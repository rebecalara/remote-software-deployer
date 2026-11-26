import { spawnSync } from 'node:child_process';
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

  it('Caddy: valida antes de aplicar e restaura o anterior se o reload falhar', () => {
    const block = text.slice(text.indexOf("Step '11. Caddy'"), text.indexOf("Step \"12."));
    expect(block.indexOf('validate')).toBeLessThan(block.indexOf('Copy-Item -LiteralPath $caddyFile'));
    expect(block).toMatch(/reload[\s\S]*Copy-Item -LiteralPath \$backup/);
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
