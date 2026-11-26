import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REAL_POWERSHELL_TEST_TIMEOUT_MS } from './deployments/testing/real-powershell';

// Scripts de produção (pasta deploy/ na raiz do repositório): preparo da VM (provision-app.ps1),
// funções comuns (rsd-deploy-common.ps1), modelo do serviço e do backend.env. Verificações
// estáticas rodam em qualquer sistema; as funções rodam no PowerShell de verdade, no Windows.

const DEPLOY = join(__dirname, '..', '..', 'deploy');
const read = (name: string) => readFileSync(join(DEPLOY, name), 'utf8').replace(/\r\n/g, '\n');
const onWindows = process.platform === 'win32' ? describe : describe.skip;
const PS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Roda um trecho de PowerShell com as funções comuns carregadas; devolve o JSON que ele escrever. */
function runPs(body: string): unknown {
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; . '${join(DEPLOY, 'rsd-deploy-common.ps1')}'; function Write-Host {}; ${body}`;
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`PowerShell falhou (${r.status}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim());
}

describe('deploy/*.ps1 — arquivos', () => {
  const scripts = readdirSync(DEPLOY).filter((f) => f.endsWith('.ps1'));

  it('existem os scripts de preparo e as funções comuns', () => {
    expect(scripts).toEqual(expect.arrayContaining(['provision-app.ps1', 'rsd-deploy-common.ps1']));
  });

  it.each(readdirSync(DEPLOY).filter((f) => f.endsWith('.ps1')))('%s está em UTF-8 com BOM (o PowerShell 5.1 leria os acentos errado sem ele)', (name) => {
    expect([...readFileSync(join(DEPLOY, name)).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  onWindows('sintaxe', () => {
    it.each(readdirSync(DEPLOY).filter((f) => f.endsWith('.ps1')))(
      '%s não tem erro de sintaxe (parser do PowerShell)',
      (name) => {
        const out = runPs(
          `$t = $null; $e = $null; [void][Management.Automation.Language.Parser]::ParseFile('${join(DEPLOY, name)}', [ref]$t, [ref]$e); ConvertTo-Json @(@($e) | ForEach-Object { $_.Message })`,
        );
        expect(out).toEqual([]);
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );
  });
});

/** Só o código: sem o bloco de ajuda (<# #>) nem as linhas de comentário. */
const codeOf = (name: string) =>
  read(name)
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

describe('deploy.ps1 — ordem e regras do deploy', () => {
  const code = codeOf('deploy.ps1');

  it('ordem: build da versão nova → pg_dump → migrações → troca com health check', () => {
    const build = code.indexOf("Invoke-Native 'nest build'");
    const dump = code.indexOf('pg_dump.exe');
    const migrate = code.indexOf("Invoke-Native 'prisma migrate deploy'");
    const swap = code.indexOf('Invoke-ReleaseSwitch');
    expect(build).toBeGreaterThan(0);
    expect(dump).toBeGreaterThan(build);
    expect(migrate).toBeGreaterThan(dump);
    expect(swap).toBeGreaterThan(migrate);
  });

  it('o backend é compilado na VM (motor do Prisma do Windows); o frontend vem do artefato do CI', () => {
    expect(code).toContain("Invoke-Native 'npm ci'");
    expect(code).toContain("Invoke-Native 'prisma generate'");
    expect(code).toContain('robocopy.exe $FrontendDist');
  });

  it('migração que falha para o deploy sem trocar a versão no ar, apontando o backup', () => {
    expect(code).toContain('Migração falhou: a versão no ar NÃO foi trocada. Backup de antes: $dump');
  });

  it('senha do banco: pelo PGPASSWORD (nunca na linha de comando) e apagada depois', () => {
    expect(code).toContain('$env:PGPASSWORD = $db.Password');
    expect(code).toContain('--no-password');
    expect(code).toContain('Remove-Item Env:\\PGPASSWORD');
    expect(code).toContain('Remove-Item Env:\\DATABASE_URL');
  });

  it('nunca toca nos instaladores nem no Caddyfile; não lê o backend.env', () => {
    for (const name of ['deploy.ps1', 'rollback.ps1']) {
      const c = codeOf(name);
      expect(c).not.toMatch(/Installers|installers/);
      expect(c).not.toMatch(/Caddyfile|caddy\.exe|caddy reload/i);
      expect(c).not.toContain('BackendEnv');
    }
    expect(code).toContain('Read-EnvFile $P.DeployEnv');
  });

  it('o health check que decide o rollback é o do backend; o site pelo Caddy só avisa', () => {
    expect(code).toContain('-Health { Test-BackendHealth }');
    expect(code).toMatch(/\$site = if \(\$result\.Ok\) \{ Test-PublicSite/);
    const common = codeOf('rsd-deploy-common.ps1');
    const publicFn = common.slice(common.indexOf('function Test-PublicSite'), common.indexOf('function Write-RsdLog'));
    expect(publicFn).not.toMatch(/throw|exit/);
    expect(publicFn).toContain('--resolve "${PublicHost}:443:127.0.0.1"');
  });
});

describe('.github/workflows/ci.yml — job de deploy', () => {
  const yml = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const deploy = yml.slice(yml.indexOf('\n  deploy:'));

  it('só em push na main, depois do backend e do frontend, no runner da APP-RSD, no environment production', () => {
    expect(deploy).toContain('needs: [backend, frontend]');
    expect(deploy).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(deploy).toContain('runs-on: [self-hosted, windows, rsd-app]');
    expect(deploy).toContain('environment: production');
    expect(deploy).toMatch(/concurrency:\s*\n\s*group: deploy-production\s*\n\s*cancel-in-progress: false/);
    expect(deploy).not.toContain('secrets.');
  });

  it('nenhum outro job usa o runner self-hosted', () => {
    expect(yml.match(/runs-on: \[self-hosted/g)).toHaveLength(1);
    expect(yml.match(/runs-on: ubuntu-24\.04/g)).toHaveLength(3); // backend, frontend e sonar
  });

  it('na main, um push novo não cancela a execução (que pode estar no meio de um deploy)', () => {
    expect(yml).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
  });

  it('o frontend que vai para produção é o build que passou nos testes (artefato frontend-dist)', () => {
    expect(yml).toMatch(/name: frontend-dist\s*\n\s*path: frontend\/dist/);
    expect(deploy).toMatch(/name: frontend-dist\s*\n\s*path: frontend-dist/);
  });
});

describe('provision-app.ps1 — regras do preparo', () => {
  const text = read('provision-app.ps1');

  it.each([
    ['Node', '22.23.5'],
    ['Git', '2.56.1.windows.1'],
    ['Postgres', '18.6'],
    ['WinSW', '2.12.0'],
    ['Runner', '2.338.2'],
  ])('%s: versão exata %s, URL com a versão e SHA-256 de 64 caracteres', (name, version) => {
    const block = text.slice(text.indexOf(`  ${name} = @{`), text.indexOf('}', text.indexOf(`  ${name} = @{`)));
    expect(block).toContain(`Version = '${version}'`);
    const url = /Url\s+= '([^']+)'/.exec(block)![1];
    expect(url.startsWith('https://')).toBe(true);
    expect(url).toContain(version.replace('.windows.1', ''));
    expect(block).toMatch(/Sha256\s+= '[0-9a-f]{64}'/);
  });

  it('confere o hash antes de instalar e apaga o arquivo se não bater', () => {
    const fn = text.slice(text.indexOf('function Get-VerifiedDownload'), text.indexOf('function Invoke-Checked'));
    expect(fn).toContain('Get-FileHash');
    expect(fn).toMatch(/if \(\$hash -ne \$Spec\.Sha256\) \{\s*Remove-Item/);
    expect(fn).toContain('Get-AuthenticodeSignature');
  });

  it('senhas: digitadas como SecureString, geradas na VM, nunca na tela', () => {
    expect(text).not.toMatch(/Read-Host(?! -AsSecureString)/);
    expect(text).toContain('New-RandomSecret');
    expect(text).not.toMatch(/Write-Host[^\n]*Password/i);
    expect(text).not.toMatch(/Info[^\n]*\$(owner|app|runner|svc)Password/i);
    // A senha do superusuário do PostgreSQL vai num arquivo de opções, não na linha de comando.
    expect(text).toContain("'--optionfile'");
    expect(text).not.toMatch(/--superpassword/);
  });

  it('dois papéis no banco, e o rsd_app recebe permissões padrão (tabelas e sequências)', () => {
    expect(text).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE rsd_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rsd_app;');
    expect(text).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE rsd_owner IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO rsd_app;');
    expect(text).toContain('ALTER ROLE rsd_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;');
    // Nada de GRANT ALL nem de CREATE para o rsd_app ("ON ALL TABLES" é outra coisa).
    expect(text).not.toMatch(/GRANT\s+(ALL\b|[^;]*\bCREATE\b)[^;]*TO rsd_app/);
  });

  it('PostgreSQL só local: pg_hba com 127.0.0.1/::1 e listen_addresses = 127.0.0.1', () => {
    expect(text).toContain("'host    all    all    127.0.0.1/32    scram-sha-256'");
    expect(text).toContain("ALTER SYSTEM SET listen_addresses = '127.0.0.1';");
  });

  it('instaladores: só a conta do serviço tem acesso; o runner, nenhum; nada é apagado lá', () => {
    expect(text).toContain('Set-RsdAcl -Path $P.Installers -Rules @(@{ Sid = $SvcSid; Rights = $M })');
    expect(text).not.toMatch(/Remove-Item[^\n]*Installers/);
  });

  it('o runner lê o deploy.env e não o backend.env', () => {
    expect(text).toContain("Set-RsdAcl -Path $P.DeployEnv -File -Rules @(@{ Sid = $RunnerSid; Rights = 'Read' })");
    expect(text).toContain("Set-RsdAcl -Path $P.BackendEnv -File -Rules @(@{ Sid = $SvcSid; Rights = 'Read' })");
  });

  it('a pasta de configuração fica protegida ANTES de receber qualquer arquivo com senha', () => {
    expect(text.indexOf('Set-RsdAcl -Path $P.Config')).toBeLessThan(text.indexOf('$SuperFile = '));
  });

  it('conta do runner sem administração e sem logon interativo, por RDP ou pela rede', () => {
    for (const right of ['SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight']) {
      expect(text).toContain(`'${right}'`);
    }
    expect(text).toContain("'S-1-5-32-544', 'S-1-5-32-555', 'S-1-5-32-580'");
  });

  it('o runner só consulta, inicia e para o serviço do RSD (ACE no descritor do serviço)', () => {
    expect(text).toContain('$ace = "(A;;RPWPLCLORC;;;$RunnerSid)"');
  });

  it('runner com atualização automática (sem --disableupdate) e labels próprias', () => {
    expect(text).not.toContain('--disableupdate');
    expect(text).toContain("--labels 'rsd-app'");
  });

  it('Caddy: troca o marcador pelo -PublicHost, valida ANTES de copiar e reinicia o serviço (admin off: sem reload)', () => {
    const block = codeOf('provision-app.ps1').slice(
      codeOf('provision-app.ps1').indexOf("Step '11. Caddy'"),
      codeOf('provision-app.ps1').indexOf('Step "12.'),
    );
    expect(block).toContain("$text.Replace('__RSD_PUBLIC_HOST__', $PublicHost)");
    expect(block.indexOf('validate --config $rendered')).toBeGreaterThan(0);
    expect(block.indexOf('validate --config $rendered')).toBeLessThan(block.indexOf('Copy-Item -LiteralPath $rendered'));
    expect(block).toContain('Restart-Service -Name $CaddyService');
    expect(block).not.toMatch(/caddy[^\n]*reload|\breload --config/);
    // Caddy que não fica no ar: o Caddyfile anterior volta.
    expect(block).toMatch(/if \(-not \$ok\) \{[\s\S]*Copy-Item -LiteralPath \$backup -Destination \$CaddyfileTarget/);
  });

  it('o resumo não manda colocar o rsd-ca.pem e rodar de novo (o arquivo já existe na VM)', () => {
    expect(text).not.toMatch(/coloque o arquivo e rode este script de novo/);
    expect(text).toContain('Download ZIP');
  });
});

describe('deploy/Caddyfile', () => {
  const caddy = read('Caddyfile');
  const CSP =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

  it('sem API de administração e com o domínio como marcador (preenchido pelo provision)', () => {
    expect(caddy).toMatch(/^\{\n\t# [^\n]*\n\tadmin off\n/m);
    expect(caddy).toMatch(/^__RSD_PUBLIC_HOST__ \{$/m);
    expect(caddy).not.toMatch(/cloudapp\.azure\.com \{/);
  });

  it('CSP conferida (sem inline, fontes locais com data:, só /api) e os cabeçalhos que já existiam', () => {
    expect(caddy).toContain(`Content-Security-Policy "${CSP}"`);
    expect(caddy).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(caddy).toContain('X-Content-Type-Options "nosniff"');
    expect(caddy).toContain('X-Frame-Options "DENY"');
    expect(caddy).toContain('Referrer-Policy "strict-origin-when-cross-origin"');
    expect(caddy).toContain('-Server');
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('mantém o que já existia: compressão, 600 MB, /api para o backend em 127.0.0.1:3000, cache e SPA', () => {
    expect(caddy).toContain('encode zstd gzip');
    expect(caddy).toContain('max_size 600MB');
    expect(caddy).toMatch(/handle_path \/api\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:3000\n\t\}/);
    expect(caddy).toContain('header @assets Cache-Control "public, max-age=31536000, immutable"');
    expect(caddy).toContain('header @paginas Cache-Control "no-cache"');
    expect(caddy).toContain('try_files {path} /index.html');
    expect(caddy).toContain('storage file_system C:/rsd/caddy/data');
    expect(caddy).toContain('output file C:/rsd/logs/caddy.log');
  });

  it('a raiz do frontend é a versão no ar, a mesma pasta que o deploy.ps1 publica', () => {
    expect(caddy).toContain('root * C:/rsd/app/current/frontend');
    expect(read('rsd-deploy-common.ps1')).toContain("Current     = Join-Path $Root 'app\\current'");
    expect(read('deploy.ps1')).toContain("robocopy.exe $FrontendDist (Join-Path $release 'frontend')");
  });

  it('o backend do Caddy é o endereço que o backend.env de produção usa', () => {
    const env = read('backend.env.example');
    expect(env).toContain('HOST="127.0.0.1"');
    expect(env).toContain('PORT="3000"');
  });
});

describe('deploy/rsd-backend.xml e backend.env.example', () => {
  const xml = read('rsd-backend.xml');
  const env = read('backend.env.example');
  const provision = read('provision-app.ps1');

  it('serviço: node no current\\backend, segredos pelo DOTENV_CONFIG_PATH, reinício em falha', () => {
    expect(xml).toContain('<id>rsd-backend</id>');
    expect(xml).toContain('<workingdirectory>C:\\rsd\\app\\current\\backend</workingdirectory>');
    expect(xml).toContain('<env name="DOTENV_CONFIG_PATH" value="C:\\rsd\\config\\backend.env"/>');
    expect(xml).toMatch(/<onfailure action="restart"/);
    expect(xml).not.toMatch(/<password>|<serviceaccount>/i);
  });

  it('a linha que o provision troca pelo NODE_EXTRA_CA_CERTS existe igualzinha no modelo', () => {
    const caLine = /\$caLine = '([^']+)'/.exec(provision)![1];
    expect(xml.split('\n')).toContain(caLine);
  });

  it('backend.env.example: nenhum segredo preenchido, só 127.0.0.1 e os marcadores do provision', () => {
    const values = Object.fromEntries(
      env
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
    );
    expect(values.JWT_SECRET).toBe('');
    expect(values.LDAP_SEARCH_BIND_PASSWORD).toBe('');
    expect(values.WINRM_PASSWORD).toBe('');
    expect(values.DATABASE_URL).toBe('__DATABASE_URL__');
    expect(values.INSTALLER_STORAGE_DIR).toBe('__INSTALLER_STORAGE_DIR__');
    expect(values.HOST).toBe('127.0.0.1');
  });
});

onWindows('rsd-deploy-common.ps1 — funções (PowerShell de verdade, numa pasta temporária)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsd-deploy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const T = REAL_POWERSHELL_TEST_TIMEOUT_MS;

  it(
    'Read-EnvFile e Set-EnvValue: aspas, comentários e troca de uma chave sem mexer no resto',
    () => {
      const out = runPs(`
        $f = Join-Path '${dir}' 'x.env'
        [IO.File]::WriteAllLines($f, @('# comentário', 'A="1"', "B='dois'", 'C=três', '', 'D="x=y"'))
        $before = Read-EnvFile $f
        Set-EnvValue -Path $f -Key 'B' -Value 'novo'
        Set-EnvValue -Path $f -Key 'E' -Value ''
        $after = Read-EnvFile $f
        ConvertTo-Json @{ before = $before; after = $after; lines = [IO.File]::ReadAllLines($f) }`);
      expect(out).toEqual({
        before: { A: '1', B: 'dois', C: 'três', D: 'x=y' },
        after: { A: '1', B: 'novo', C: 'três', D: 'x=y', E: '' },
        lines: ['# comentário', 'A="1"', 'B="novo"', 'C=três', '', 'D="x=y"', 'E=""'],
      });
    },
    T,
  );

  it(
    'ConvertTo-PgUri tira o ?schema=public (o pg_dump não aceita); New-RandomSecret é base64url',
    () => {
      const out = runPs(`ConvertTo-Json @{
        uri = ConvertTo-PgUri 'postgresql://rsd_owner:Ab_9-x@127.0.0.1:5432/rsd?schema=public'
        a = New-RandomSecret; b = New-RandomSecret }`) as { uri: string; a: string; b: string };
      expect(out.uri).toBe('postgresql://rsd_owner:Ab_9-x@127.0.0.1:5432/rsd');
      expect(out.a).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(out.a).not.toBe(out.b);
    },
    T,
  );

  it(
    'versões: nome com data e SHA; troca da junção "current" sem apagar o conteúdo das versões',
    () => {
      const out = runPs(`
        $P = Get-RsdPaths -Root '${dir}'
        $null = New-Item -ItemType Directory -Path $P.Releases -Force
        $a = New-ReleaseName -Sha '0123456789abcdef0123456789abcdef01234567' -When ([datetime]'2026-11-26 10:00:00')
        $b = New-ReleaseName -Sha 'fedcba9876543210fedcba9876543210fedcba98' -When ([datetime]'2026-11-26 11:00:00')
        foreach ($n in @($a, $b)) { $null = New-Item -ItemType Directory -Path (Join-Path $P.Releases $n); Set-Content (Join-Path $P.Releases "$n\\marca.txt") $n }
        Set-CurrentRelease -Paths $P -Name $a
        $first = Get-CurrentRelease $P
        Set-CurrentRelease -Paths $P -Name $b
        ConvertTo-Json @{
          a = $a; first = $first; second = (Get-CurrentRelease $P)
          viaCurrent = [IO.File]::ReadAllText((Join-Path $P.Current 'marca.txt')).Trim()
          aKept = [IO.File]::ReadAllText((Join-Path $P.Releases "$a\\marca.txt")).Trim()
          releases = @(Get-Releases $P)
        }`) as Record<string, unknown>;
      expect(out.a).toBe('20261126-100000-0123456');
      expect(out.first).toBe('20261126-100000-0123456');
      expect(out.second).toBe('20261126-110000-fedcba9');
      expect(out.viaCurrent).toBe('20261126-110000-fedcba9');
      expect(out.aKept).toBe('20261126-100000-0123456');
      expect(out.releases).toEqual(['20261126-100000-0123456', '20261126-110000-fedcba9']);
    },
    T,
  );

  it(
    'recusa SHA inválido e "current" que é uma pasta de verdade (não uma junção)',
    () => {
      const out = runPs(`
        $P = Get-RsdPaths -Root '${dir}'
        $null = New-Item -ItemType Directory -Path $P.Current -Force
        $r = @{}
        try { New-ReleaseName -Sha 'xyz' | Out-Null; $r.sha = 'aceitou' } catch { $r.sha = $_.Exception.Message }
        try { Get-CurrentRelease $P | Out-Null; $r.current = 'aceitou' } catch { $r.current = $_.Exception.Message }
        ConvertTo-Json $r`) as Record<string, string>;
      expect(out.sha).toContain('SHA inválido');
      expect(out.current).toContain('não é uma junção');
    },
    T,
  );

  it(
    'retenção: mantém as 5 últimas versões, nunca apaga a atual nem a anterior, e só pastas de versão',
    () => {
      const out = runPs(`
        $P = Get-RsdPaths -Root '${dir}'
        $null = New-Item -ItemType Directory -Path $P.Releases -Force
        $names = 1..8 | ForEach-Object { '2026112{0}-100000-abcdef{0}' -f $_ }
        foreach ($n in $names) { $null = New-Item -ItemType Directory -Path (Join-Path $P.Releases $n) }
        $null = New-Item -ItemType Directory -Path (Join-Path $P.Releases 'outra-pasta')
        # A "atual" é antiga (rollback para trás): continua protegida.
        Remove-OldReleases -Paths $P -Current $names[0] -Previous $names[7]
        ConvertTo-Json @(Get-ChildItem $P.Releases | Sort-Object Name | ForEach-Object Name)`);
      expect(out).toEqual([
        '20261121-100000-abcdef1',
        '20261124-100000-abcdef4',
        '20261125-100000-abcdef5',
        '20261126-100000-abcdef6',
        '20261127-100000-abcdef7',
        '20261128-100000-abcdef8',
        'outra-pasta',
      ]);
    },
    T,
  );

  it(
    'backups: mantém os 10 dumps de antes do deploy mais recentes e não toca em outros arquivos',
    () => {
      const out = runPs(`
        $P = Get-RsdPaths -Root '${dir}'
        $null = New-Item -ItemType Directory -Path $P.Backups -Force
        1..12 | ForEach-Object { Set-Content (Join-Path $P.Backups ('rsd-antes-deploy-202611{0:00}-100000-abcdef1.dump' -f $_)) 'x' }
        Set-Content (Join-Path $P.Backups 'rsd-antes-indices-historico-20261125.sql') 'manual'
        Remove-OldBackups -Paths $P
        ConvertTo-Json @(Get-ChildItem $P.Backups | Sort-Object Name | ForEach-Object Name)`) as string[];
      expect(out).toHaveLength(11);
      expect(out).toContain('rsd-antes-indices-historico-20261125.sql');
      expect(out).not.toContain('rsd-antes-deploy-20261101-100000-abcdef1.dump');
      expect(out).not.toContain('rsd-antes-deploy-20261102-100000-abcdef1.dump');
    },
    T,
  );
});

onWindows('troca de versão, rollback e health check (PowerShell de verdade, sem serviço)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rsd-switch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const T = REAL_POWERSHELL_TEST_TIMEOUT_MS;

  /** Duas versões (a "atual" opcional) e um health check com as respostas dadas, em ordem. */
  const switchWith = (answers: boolean[], withCurrent = true, startFails = false) =>
    runPs(`
      $P = Get-RsdPaths -Root '${dir.replace(/'/g, "''")}'
      $null = New-Item -ItemType Directory -Path $P.Releases -Force
      foreach ($n in @('20261125-100000-aaaaaaa', '20261126-100000-bbbbbbb')) { $null = New-Item -ItemType Directory -Path (Join-Path $P.Releases $n) }
      if (${withCurrent ? '$true' : '$false'}) { Set-CurrentRelease -Paths $P -Name '20261125-100000-aaaaaaa' }
      $script:answers = @(${answers.map((a) => (a ? '$true' : '$false')).join(', ')}); $script:i = 0; $script:log = @()
      $r = Invoke-ReleaseSwitch -Paths $P -NewRelease '20261126-100000-bbbbbbb' \`
        -Stop { $script:log += 'stop' } \`
        -Start { $script:log += "start:$(Get-CurrentRelease $P)"; if (${startFails ? '$true' : '$false'} -and (Get-CurrentRelease $P) -eq '20261126-100000-bbbbbbb') { throw 'não subiu' } } \`
        -Health { $script:log += 'health'; $a = $script:answers[$script:i]; $script:i++; $a }
      ConvertTo-Json @{ ok = $r.Ok; release = $r.Release; previous = $r.Previous; rolledBack = $r.RolledBack; message = $r.Message; current = (Get-CurrentRelease $P); log = $script:log }`) as Record<string, unknown>;

  it(
    'versão nova saudável: fica no ar',
    () => {
      const out = switchWith([true]);
      expect(out).toMatchObject({ ok: true, rolledBack: false, current: '20261126-100000-bbbbbbb', previous: '20261125-100000-aaaaaaa' });
      expect(out.log).toEqual(['stop', 'start:20261126-100000-bbbbbbb', 'health']);
    },
    T,
  );

  it(
    'health check falha: rollback automático para a anterior, que volta ao ar; o job termina com falha',
    () => {
      const out = switchWith([false, true]);
      expect(out).toMatchObject({ ok: false, rolledBack: true, current: '20261125-100000-aaaaaaa', release: '20261125-100000-aaaaaaa' });
      expect(out.message).toContain('rollback automático');
      expect(out.message).toContain('O banco NÃO foi desfeito');
      expect(out.log).toEqual(['stop', 'start:20261126-100000-bbbbbbb', 'health', 'stop', 'start:20261125-100000-aaaaaaa', 'health']);
    },
    T,
  );

  it(
    'serviço que nem inicia na versão nova também dispara o rollback',
    () => {
      const out = switchWith([true], true, true);
      expect(out).toMatchObject({ ok: false, rolledBack: true, current: '20261125-100000-aaaaaaa' });
    },
    T,
  );

  it(
    'rollback que também falha: avisa que precisa de intervenção manual',
    () => {
      const out = switchWith([false, false]);
      expect(out).toMatchObject({ ok: false, rolledBack: false });
      expect(out.message).toContain('intervenção manual');
    },
    T,
  );

  it(
    'primeiro deploy (sem versão anterior) que falha: não há para onde voltar, e a mensagem diz isso',
    () => {
      const out = switchWith([false], false);
      expect(out).toMatchObject({ ok: false, rolledBack: false, current: '20261126-100000-bbbbbbb' });
      expect(out.message).toContain('não há versão anterior');
    },
    T,
  );

  it(
    'rollback.ps1: versão anterior à atual, ou por SHA; SHA desconhecido é recusado',
    () => {
      const out = runPs(`
        $P = Get-RsdPaths -Root '${dir}'
        $null = New-Item -ItemType Directory -Path $P.Releases -Force
        foreach ($n in @('20261124-100000-1111111', '20261125-100000-2222222', '20261126-100000-3333333')) { $null = New-Item -ItemType Directory -Path (Join-Path $P.Releases $n) }
        Set-CurrentRelease -Paths $P -Name '20261126-100000-3333333'
        $r = @{ previous = (Get-PreviousRelease -Paths $P); bySha = (Resolve-Release -Paths $P -NameOrSha '1111111aaaabbbbccccddddeeeeffff000011112'); byName = (Resolve-Release -Paths $P -NameOrSha '20261125-100000-2222222') }
        try { Resolve-Release -Paths $P -NameOrSha 'abcdef0' | Out-Null; $r.unknown = 'aceitou' } catch { $r.unknown = $_.Exception.Message }
        ConvertTo-Json $r`) as Record<string, string>;
      expect(out.previous).toBe('20261125-100000-2222222');
      expect(out.bySha).toBe('20261124-100000-1111111');
      expect(out.byName).toBe('20261125-100000-2222222');
      expect(out.unknown).toContain('Versão não encontrada');
    },
    T,
  );

  it(
    'Split-PgUrl: usuário, senha (separada para o PGPASSWORD), host, porta e banco',
    () => {
      const out = runPs(`ConvertTo-Json (Split-PgUrl 'postgresql://rsd_owner:Ab_9-x@127.0.0.1:5432/rsd?schema=public')`);
      expect(out).toEqual({ User: 'rsd_owner', Password: 'Ab_9-x', Host: '127.0.0.1', Port: '5432', Database: 'rsd' });
    },
    T,
  );

  /** Servidor HTTP num processo separado (o spawnSync do PowerShell bloquearia um servidor no Jest). */
  async function withServer(status: number, body: string, fn: (url: string) => void) {
    const server = spawn(process.execPath, [
      '-e',
      `require('http').createServer((q, s) => { s.writeHead(${status}, { 'Content-Type': 'application/json' }); s.end(${JSON.stringify(body)}); })` +
        `.listen(0, '127.0.0.1', function () { console.log(this.address().port); });`,
    ]);
    try {
      const port = await new Promise<string>((resolve, reject) => {
        server.stdout.once('data', (d: Buffer) => resolve(d.toString().trim()));
        server.once('error', reject);
      });
      fn(`http://127.0.0.1:${port}/health`);
    } finally {
      server.kill();
    }
  }

  it(
    'Test-BackendHealth: 200 com { status: "ok" } passa; 503 não passa (no tempo limite)',
    async () => {
      await withServer(200, '{"status":"ok"}', (url) => {
        expect(runPs(`ConvertTo-Json (Test-BackendHealth -Url '${url}' -TimeoutSeconds 10)`)).toBe(true);
      });
      await withServer(503, '{"status":"error"}', (url) => {
        expect(runPs(`ConvertTo-Json (Test-BackendHealth -Url '${url}' -TimeoutSeconds 3)`)).toBe(false);
      });
    },
    T,
  );
});

describe('permissões do rsd_app — conferência em todo deploy e prova prática', () => {
  it('o deploy confere as permissões DEPOIS da migração e ANTES da troca de versão', () => {
    const code = codeOf('deploy.ps1');
    const migrate = code.indexOf("Invoke-Native 'prisma migrate deploy'");
    const grants = code.indexOf('Get-AppGrantProblemsSql');
    const swap = code.indexOf('Invoke-ReleaseSwitch');
    expect(grants).toBeGreaterThan(migrate);
    expect(swap).toBeGreaterThan(grants);
    expect(code).toContain('O papel rsd_app não tem permissão em: $problems. A versão no ar NÃO foi trocada');
  });

  it('conferência do deploy: SELECT, INSERT, UPDATE e DELETE em cada tabela e USAGE em cada sequência', () => {
    const common = read('rsd-deploy-common.ps1');
    const sql = common.slice(common.indexOf('function Get-AppGrantProblemsSql'), common.indexOf('function Get-AppWriteCheckSql'));
    expect(sql).toContain("(VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'))");
    expect(sql).toContain("has_sequence_privilege('rsd_app'");
  });

  it('prova prática: como rsd_app, numa transação desfeita, sem mudar linha nem sequência', () => {
    const common = read('rsd-deploy-common.ps1');
    const sql = common.slice(common.indexOf('function Get-AppWriteCheckSql'), common.indexOf('function Split-PgUrl'));
    expect(sql.trim()).toMatch(/^function Get-AppWriteCheckSql \{\s*return @'\s*BEGIN;/);
    expect(sql).toMatch(/ROLLBACK;\s*'@/);
    for (const stmt of ['INSERT INTO %I.%I SELECT * FROM %I.%I WHERE false', 'UPDATE %I.%I SET %s = %s WHERE false', 'DELETE FROM %I.%I WHERE false']) {
      expect(sql).toContain(stmt);
    }
    expect(sql).not.toMatch(/nextval|setval/);
    const check = read('check-db-grants.ps1');
    expect(check).toContain("if ($db.User -ne 'rsd_app')");
    expect(check).toContain('Read-EnvFile $P.BackendEnv');
    expect(check).toMatch(/-match 'FALTA'/);
  });
});
