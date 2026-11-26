import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as dotenvParse } from 'dotenv';
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

  it('rodar de novo com o runner já registrado não troca a senha da conta rsd-runner', () => {
    const step8 = codeOf('provision-app.ps1').slice(
      codeOf('provision-app.ps1').indexOf('Step "8.'),
      codeOf('provision-app.ps1').indexOf("Step '9."),
    );
    // Set-LocalUser -Password só quando o runner ainda vai ser registrado.
    expect(step8).toMatch(/elseif \(-not \$runnerRegistered -and -not \$SkipRunner\) \{\s*\$runnerPassword = New-RandomSecret\s*Set-LocalUser/);
    expect(step8.match(/Set-LocalUser/g)).toHaveLength(1);
    const step12 = codeOf('provision-app.ps1').slice(codeOf('provision-app.ps1').indexOf('Step "12.'));
    expect(step12).not.toContain('StartPassword');
  });

  // Na VM, o rsd-backend ficou em LocalSystem: uma rodada interrompida instalou o serviço sem
  // aplicar a senha, e a seguinte só pedia a senha se o serviço ainda não existisse.
  it('serviço: pede a senha sempre que a conta não for a svc-rsd, confere no AD antes e para com erro se não aplicar', () => {
    const code = codeOf('provision-app.ps1');
    const step10 = code.slice(code.indexOf('Step "10.'), code.indexOf("Step '11."));
    expect(step10).toContain('if ($ResetServicePassword -or -not (Test-ServiceRunsAs -Name $script:RsdServiceName -Sid $SvcSid))');
    expect(step10).not.toMatch(/\$needPassword/);
    const check = step10.indexOf('Test-DomainCredential');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(step10.indexOf('-MethodName Change'));
    // Depois do Change, confere de novo e para com erro se a conta não for a esperada.
    expect(step10.slice(step10.indexOf('-MethodName Change'))).toMatch(/if \(-not \(Test-ServiceRunsAs[^\n]*\)\) \{\s*throw/);
  });

  it('runner: o token é lido por Read-RunnerToken (nunca vazio no config.cmd) e o registro é conferido depois', () => {
    const code = codeOf('provision-app.ps1');
    const step12 = code.slice(code.indexOf('Step "12.'));
    expect(step12).toContain('$token = Read-RunnerToken');
    expect(step12.indexOf('Read-RunnerToken')).toBeLessThan(step12.indexOf('config.cmd --unattended'));
    expect(step12).not.toMatch(/Read-Host/);
    expect(step12).toMatch(/if \(-not \(Test-Path \(Join-Path \$RunnerDir '\.runner'\)\) -or -not \$runnerSvc[^\n]*\{\s*throw/);
  });

  // Na VM: "Invalid windows credentials entered" — o config.cmd confere a senha com LogonUser em
  // modo rede (LOGON32_LOGON_NETWORK), negado à rsd-runner pelo passo 8.
  it('runner: SeDenyNetworkLogonRight suspensa só durante o config.cmd, devolvida no finally e conferida no fim', () => {
    const code = codeOf('provision-app.ps1');
    const step12 = code.slice(code.indexOf('Step "12.'), code.indexOf("Step 'Resumo'"));
    const remove = step12.indexOf("Remove-AccountRight -Sid $RunnerSid -Rights @('SeDenyNetworkLogonRight')");
    const config = step12.indexOf('& .\\config.cmd');
    const fin = step12.indexOf('} finally {', config);
    const add = step12.indexOf("Add-AccountRight -Sid $RunnerSid -Rights @('SeDenyNetworkLogonRight')");
    expect(remove).toBeGreaterThan(0);
    expect(remove).toBeLessThan(config);
    expect(fin).toBeGreaterThan(config);
    expect(add).toBeGreaterThan(fin);
    // DENTRO do finally (volta mesmo se o config.cmd falhar), não depois dele.
    expect(step12).toMatch(
      /\} finally \{\s*Pop-Location; \$token = \$null\s*Add-AccountRight -Sid \$RunnerSid -Rights @\('SeDenyNetworkLogonRight'\)\s*\}/,
    );
    // Nenhuma outra negação é retirada, em lugar nenhum do script; o passo 8 concede as quatro.
    expect(code.match(/Remove-AccountRight -Sid[^\n]*/g)).toEqual([
      "Remove-AccountRight -Sid $RunnerSid -Rights @('SeDenyNetworkLogonRight')",
    ]);
    expect(code).toContain(
      "Add-AccountRight -Sid $RunnerSid -Rights @('SeServiceLogonRight', 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight')",
    );
    // A conferência final vale para todos os caminhos (inclusive -SkipRunner) e para com erro.
    const tail = step12.slice(step12.lastIndexOf('Test-AccountRight'));
    expect(step12.slice(0, step12.lastIndexOf('Test-AccountRight'))).toMatch(/\n\}\n[^\n]*\n?if \(-not \($/);
    expect(tail).toMatch(/^Test-AccountRight -Sid \$RunnerSid -Right 'SeDenyNetworkLogonRight'\)\) \{\s*throw/);
    expect(tail).toContain('SeDenyNetworkLogonRight da ${RunnerAccount}: valendo');
  });

  it('runner registrado pela metade (.runner sem serviço): apaga a configuração local e registra de novo com --replace', () => {
    const code = codeOf('provision-app.ps1');
    const step8 = code.slice(code.indexOf('Step "8.'), code.indexOf("Step '9."));
    expect(step8).toMatch(/if \(\$runnerRegistered -and -not \(Get-Service -Name 'actions\.runner\.\*'[^\n]*\{\s*\$runnerRegistered = \$false\s*\$runnerHalfConfigured = \$true/);
    const step12 = code.slice(code.indexOf('Step "12.'), code.indexOf("Step 'Resumo'"));
    expect(step12.indexOf('Reset-RunnerLocalConfig -Dir $RunnerDir')).toBeGreaterThan(0);
    expect(step12.indexOf('Reset-RunnerLocalConfig -Dir $RunnerDir')).toBeLessThan(step12.indexOf('& .\\config.cmd'));
    expect(step12).toContain('--replace');
    expect(step12).not.toContain('config.cmd remove');
  });

  onWindows('funções do preparo no PowerShell de verdade', () => {
    /** Carrega do provision só as funções pedidas (sem rodar o script), com Info/Warn gravando em $log. */
    const withFunctions = (names: string[], body: string) => `
      $tk = $null; $er = $null
      $ast = [Management.Automation.Language.Parser]::ParseFile('${join(DEPLOY, 'provision-app.ps1')}', [ref]$tk, [ref]$er)
      foreach ($fn in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
        if (@(${names.map((n) => `'${n}'`).join(',')}) -contains $fn.Name) { Invoke-Expression $fn.Extent.Text }
      }
      $log = New-Object Collections.Generic.List[string]
      function Info([string]$t) { $log.Add('INFO ' + $t) }
      function Warn([string]$t) { $log.Add('WARN ' + $t) }
      ${body}`;
    const token = 'AABBCCDDEEFF00112233445566';
    const readToken = (inputs: string[]) =>
      runPs(
        withFunctions(
          ['Get-PlainText', 'Read-RunnerToken'],
          `$queue = New-Object Collections.Generic.Queue[string]
          ${inputs.map((i) => `$queue.Enqueue('${i.replace(/'/g, "''")}')`).join('; ')}
          function Read-Host { param([string]$Prompt, [switch]$AsSecureString)
            $v = $queue.Dequeue(); $s = New-Object Security.SecureString; foreach ($ch in $v.ToCharArray()) { $s.AppendChar($ch) }; $s }
          try { $r = Read-RunnerToken; $err = $null } catch { $r = $null; $err = $_.Exception.Message }
          ConvertTo-Json -Compress @{ token = $r; error = $err; log = @($log); left = $queue.Count }`,
        ),
      ) as { token: string | null; error: string | null; log: string[]; left: number };

    it(
      'Read-RunnerToken: tira espaço e quebra de linha das pontas e mostra só o tamanho',
      () => {
        const r = readToken([`  ${token}\r\n`]);
        expect(r.token).toBe(token);
        expect(r.log).toEqual([`INFO Token lido: ${token.length} caracteres.`]);
        expect(JSON.stringify(r.log)).not.toContain(token);
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );

    it(
      'Read-RunnerToken: vazio ou com espaço no meio pede de novo; 3 vezes sem token = erro, sem chamar o config.cmd',
      () => {
        const ok = readToken(['', `--token ${token}`, token]);
        expect(ok.token).toBe(token);
        expect(ok.log.filter((l) => l.startsWith('WARN'))).toHaveLength(2);
        expect(JSON.stringify(ok.log)).not.toContain(token);
        const fail = readToken(['', '   ', '\r\n']);
        expect(fail.token).toBeNull();
        expect(fail.error).toMatch(/não lido em 3 tentativas/);
        expect(fail.log.filter((l) => l.startsWith('INFO'))).toEqual(Array(3).fill('INFO Token lido: 0 caracteres.'));
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );

    it(
      'Reset-RunnerLocalConfig: apaga só .runner, .credentials e .credentials_rsaparams (inclusive ocultos)',
      () => {
        const dir = mkdtempSync(join(tmpdir(), 'rsd-runner-'));
        try {
          const out = runPs(
            withFunctions(
              ['Reset-RunnerLocalConfig'],
              `$d = '${dir}'
              foreach ($f in '.runner', '.credentials', '.credentials_rsaparams', '.env', 'config.cmd', 'bin\\Runner.Listener.dll', '_diag\\Runner_1.log') {
                $p = Join-Path $d $f; $null = New-Item -ItemType File -Path $p -Force }
              (Get-Item -LiteralPath (Join-Path $d '.credentials') -Force).Attributes = 'Hidden'
              Reset-RunnerLocalConfig -Dir $d
              Reset-RunnerLocalConfig -Dir $d
              ConvertTo-Json -Compress @(Get-ChildItem -LiteralPath $d -Recurse -File -Force | ForEach-Object { $_.FullName.Substring($d.Length + 1) })`,
            ),
          ) as string[];
          const byName = (a: string, b: string) => a.localeCompare(b);
          expect([...out].sort(byName)).toEqual(['_diag\\Runner_1.log', '.env', 'bin\\Runner.Listener.dll', 'config.cmd'].sort(byName));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );

    it(
      'RsdLsa2 compila (conceder, retirar e listar direitos); a leitura roda de verdade quando o teste é administrador',
      () => {
        const out = runPs(
          withFunctions(
            ['Initialize-RsdLsa', 'Get-SidBytes', 'Test-AccountRight'],
            `Initialize-RsdLsa
            $t = [RsdLsa2]
            $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            $backup = $null
            if ($admin) { $backup = Test-AccountRight -Sid (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')) -Right 'SeBackupPrivilege' }
            ConvertTo-Json -Compress @{ methods = @($t.GetMethods() | Where-Object { $_.IsStatic -and $_.DeclaringType -eq $t } | ForEach-Object Name | Sort-Object); admin = $admin; backup = $backup }`,
          ),
        ) as { methods: string[]; admin: boolean; backup: boolean | null };
        expect(out.methods).toEqual(['Add', 'List', 'Remove']);
        // Administradores sempre têm SeBackupPrivilege: controle positivo da leitura pela LSA.
        if (out.admin) expect(out.backup).toBe(true);
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );

    it(
      'Test-ServiceRunsAs: LocalSystem, conta diferente e serviço inexistente contam como "não"',
      () => {
        const out = runPs(
          withFunctions(
            ['Resolve-Sid', 'Test-ServiceRunsAs'],
            `$me = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $localService = New-Object Security.Principal.SecurityIdentifier('S-1-5-19')
            ConvertTo-Json -Compress @{
              same = (Test-ServiceRunsAs -Name 'EventLog' -Sid $localService)
              localSystem = (Test-ServiceRunsAs -Name 'Winmgmt' -Sid $me)
              missing = (Test-ServiceRunsAs -Name 'rsd-nao-existe-123' -Sid $me)
            }`,
          ),
        ) as { same: boolean; localSystem: boolean; missing: boolean };
        // EventLog roda como NT AUTHORITY\LocalService (S-1-5-19): controle positivo.
        expect(out).toEqual({ same: true, localSystem: false, missing: false });
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );
  });
});

// Limites do Windows que a VM pegou só na hora (New-LocalUser -Description com 58 caracteres).
describe('deploy/*.ps1 — limites de tamanho do Windows', () => {
  const provision = read('provision-app.ps1');
  const xml = read('rsd-backend.xml');
  const literals = (flag: string) =>
    readdirSync(DEPLOY)
      .filter((f) => f.endsWith('.ps1'))
      .flatMap((f) => [...read(f).matchAll(new RegExp(`-${flag}\\s+(?:'([^']*)'|"([^"$]*)")`, 'g'))].map((m) => ({ f, value: m[1] ?? m[2] })));

  it('New-LocalUser / Set-LocalUser: -Description literal com no máximo 48 caracteres', () => {
    const found = literals('Description');
    expect(found.length).toBeGreaterThan(0);
    for (const { f, value } of found) expect({ f, value, length: value.length }).toEqual({ f, value, length: Math.min(value.length, 48) });
  });

  it('conta do runner: nome padrão com no máximo 20 caracteres e o parâmetro validado (o PowerShell não valida o padrão)', () => {
    const m = /\[ValidatePattern\('([^']+)'\)\]\[string\]\$RunnerAccount = '([^']+)'/.exec(provision)!;
    expect(m).not.toBeNull();
    expect(m[1]).toContain('{1,20}');
    expect(new RegExp(m[1]).test(m[2])).toBe(true);
    expect(m[2].length).toBeLessThanOrEqual(20);
  });

  it('serviço do WinSW: id sem espaço e id/nome dentro do limite de 256 do Windows; runner com o nome da máquina (até 15)', () => {
    const id = /<id>([^<]+)<\/id>/.exec(xml)![1];
    const name = /<name>([^<]+)<\/name>/.exec(xml)![1];
    expect(id).toMatch(/^[A-Za-z0-9._-]{1,256}$/);
    expect(name.length).toBeLessThanOrEqual(256);
    expect(provision).toContain('--name $env:COMPUTERNAME');
  });

  onWindows('com os limites reais das cmdlets', () => {
    it(
      'nenhum texto literal passa do [ValidateLength] do parâmetro da cmdlet chamada',
      () => {
        const out = runPs(`
          $errs = @(); $checked = 0
          foreach ($f in Get-ChildItem -LiteralPath '${DEPLOY}' -Filter *.ps1) {
            $t = $null; $e = $null
            $ast = [Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)
            foreach ($c in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true)) {
              $name = $c.GetCommandName(); if (-not $name) { continue }
              $info = Get-Command -Name $name -CommandType Cmdlet -ErrorAction SilentlyContinue | Select-Object -First 1
              if (-not $info) { continue }
              $bound = [Management.Automation.Language.StaticParameterBinder]::BindCommand($c, $true)
              foreach ($k in @($bound.BoundParameters.Keys)) {
                $v = $bound.BoundParameters[$k].Value
                if ($v -isnot [Management.Automation.Language.StringConstantExpressionAst]) { continue }
                $p = $info.Parameters[$k]; if (-not $p) { continue }
                foreach ($a in $p.Attributes) {
                  if ($a -is [Management.Automation.ValidateLengthAttribute]) {
                    $checked++
                    if ($v.Value.Length -gt $a.MaxLength) { $errs += ('{0}: {1} -{2} = {3} chars (max {4})' -f $f.Name, $name, $k, $v.Value.Length, $a.MaxLength) }
                  }
                }
              }
            }
          }
          ConvertTo-Json -Compress @{ checked = $checked; errors = @($errs) }`) as { checked: number; errors: string[] };
        expect(out.errors).toEqual([]);
        expect(out.checked).toBeGreaterThan(0); // New-LocalUser -Description, ao menos
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );

    // Na VM: "A parameter cannot be found that matches parameter name 'Filter'" no
    // Invoke-CimMethod do passo 10, logo depois da senha — o parser não pega, só a execução.
    it(
      'todo parâmetro nomeado existe na cmdlet chamada, e todo comando existe (cmdlet, programa ou função dos scripts)',
      () => {
        const out = runPs(`
          $errs = New-Object Collections.Generic.List[string]; $checked = 0
          $files = @(Get-ChildItem -LiteralPath '${DEPLOY}' -Filter *.ps1)
          $asts = @{}; $ownFunctions = @{}
          foreach ($f in $files) {
            $t = $null; $e = $null
            $asts[$f.Name] = [Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e)
            foreach ($fn in $asts[$f.Name].FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $ownFunctions[$fn.Name] = $true }
          }
          foreach ($fname in $asts.Keys) {
            foreach ($c in $asts[$fname].FindAll({ param($n) $n -is [Management.Automation.Language.CommandAst] }, $true)) {
              $name = $c.GetCommandName()
              if (-not $name -or $name.Contains('\\') -or $ownFunctions.ContainsKey($name)) { continue }
              $any = Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
              if (-not $any) { $errs.Add(('{0}: comando {1} não existe' -f $fname, $name)); continue }
              if ($any.CommandType -eq 'Alias') { $any = $any.ResolvedCommand }
              if ($any.CommandType -ne 'Cmdlet') { continue }
              foreach ($p in @($c.CommandElements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] })) {
                $checked++
                $pn = $p.ParameterName
                $match = @($any.Parameters.Values | Where-Object { $_.Name -eq $pn -or $_.Aliases -contains $pn })
                if ($match.Count -eq 0) { $match = @($any.Parameters.Values | Where-Object { $_.Name -like ($pn + '*') }) }
                if ($match.Count -ne 1) { $errs.Add(('{0}:{1} {2} -{3}: parâmetro não existe' -f $fname, $p.Extent.StartLineNumber, $any.Name, $pn)) }
              }
            }
          }
          ConvertTo-Json -Compress @{ checked = $checked; errors = @($errs) }`) as { checked: number; errors: string[] };
        expect(out.errors).toEqual([]);
        expect(out.checked).toBeGreaterThan(100);
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );
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
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]),
    );
    expect(values.JWT_SECRET).toBe('');
    expect(values.LDAP_SEARCH_BIND_PASSWORD).toBe('');
    expect(values.WINRM_PASSWORD).toBe('');
    expect(values.DATABASE_URL).toBe('__DATABASE_URL__');
    expect(values.INSTALLER_STORAGE_DIR).toBe('__INSTALLER_STORAGE_DIR__');
    expect(values.HOST).toBe('127.0.0.1');
  });

  // Na VM: INSTALLER_STORAGE_DIR="C:\rsd\data\installers" virou "C:" + CR + "sd\data\installers"
  // (o dotenv troca \r e \n dentro de aspas duplas).
  const envExamples: [string, string][] = [
    ['deploy/backend.env.example', join(DEPLOY, 'backend.env.example')],
    ['backend/.env.example', join(DEPLOY, '..', 'backend', '.env.example')],
    ['frontend/.env.example', join(DEPLOY, '..', 'frontend', '.env.example')],
  ];
  it.each(envExamples)('%s: nenhum valor entre aspas duplas com \\r, \\n ou \\t', (_name, file) => {
    const bad = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*"[^"]*\\[rnt][^"]*"/.test(line));
    expect(bad).toEqual([]);
  });

  it('o backend.env que o provision gera (marcadores trocados) chega ao backend com o caminho exato', () => {
    const appUrl = 'postgresql://rsd_app:Ab-_9@127.0.0.1:5432/rsd?schema=public';
    // Os mesmos Replace do passo 7 do provision.
    expect(provision).toContain(".Replace('__DATABASE_URL__', $appUrl).Replace('__INSTALLER_STORAGE_DIR__', $P.Installers)");
    const rendered = env.replace('__DATABASE_URL__', appUrl).replace('__INSTALLER_STORAGE_DIR__', 'C:\\rsd\\data\\installers');
    const values = dotenvParse(Buffer.from(rendered));
    expect(values.INSTALLER_STORAGE_DIR).toBe('C:\\rsd\\data\\installers');
    expect(values.DATABASE_URL).toBe(appUrl);
  });

  it('deploy.env: PG_BIN (caminho do Windows) entre aspas simples', () => {
    expect(provision).toContain(`"PG_BIN='$PgRoot\\bin'"`);
    expect(provision).not.toMatch(/PG_BIN=`"/);
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
    'Set-EnvValue com caminho do Windows grava entre aspas simples, e o dotenv do backend lê o caminho exato',
    () => {
      const out = runPs(`
        $f = Join-Path '${dir}' 'y.env'
        Set-EnvValue -Path $f -Key 'INSTALLER_STORAGE_DIR' -Value 'C:\\rsd\\data\\installers'
        Set-EnvValue -Path $f -Key 'NODE_EXTRA_CA_CERTS' -Value 'C:\\rsd\\config\\rsd-ca.pem'
        try { Set-EnvValue -Path $f -Key 'X' -Value "C:\\it's"; $err = $null } catch { $err = $_.Exception.Message }
        ConvertTo-Json @{ lines = [IO.File]::ReadAllLines($f); err = $err }`) as { lines: string[]; err: string | null };
      expect(out.lines).toEqual(["INSTALLER_STORAGE_DIR='C:\\rsd\\data\\installers'", "NODE_EXTRA_CA_CERTS='C:\\rsd\\config\\rsd-ca.pem'"]);
      expect(out.err).toMatch(/não tem forma segura/);
      expect(dotenvParse(Buffer.from(out.lines.join('\n')))).toEqual({
        INSTALLER_STORAGE_DIR: 'C:\\rsd\\data\\installers',
        NODE_EXTRA_CA_CERTS: 'C:\\rsd\\config\\rsd-ca.pem',
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

describe('deploy/add-user.ps1 — usuários iniciais (o login nunca cria usuário)', () => {
  const script = codeOf('add-user.ps1');
  const common = read('rsd-deploy-common.ps1');
  const schema = readFileSync(join(DEPLOY, '..', 'backend', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');

  it('valida antes de tocar no banco, conecta como rsd_app (backend.env) e a senha só vai pelo PGPASSWORD', () => {
    expect(script.indexOf('Get-AddUserSql')).toBeLessThan(script.indexOf('Read-EnvFile'));
    expect(script).toContain("Split-PgUrl (Read-EnvFile $P.BackendEnv)['DATABASE_URL']");
    expect(script).toContain("if ($db.User -ne 'rsd_app')");
    expect(script).not.toMatch(/\$P\.DeployEnv\)\['DATABASE_URL'\]/);
    expect(script).toMatch(/\} finally \{[\s\S]*Remove-Item Env:\\PGPASSWORD/);
    // Nenhum valor do usuário na linha de comando do psql (-v ou -c): só o arquivo temporário.
    const psqlLine = script.split('\n').find((l) => l.includes('& $psql'))!;
    expect(psqlLine).toContain('-f $sql');
    expect(psqlLine).not.toMatch(/\s-v\s|\s-c\s|\$Username|\$DisplayName/);
  });

  it('o INSERT tem todas as colunas obrigatórias sem padrão no banco (conferido contra o schema.prisma)', () => {
    const model = /model User \{([\s\S]*?)\n\}/.exec(schema)![1];
    const models = new Set([...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]));
    const required = model
      .split('\n')
      .map((l) => /^\s+(\w+)\s+(\w+)(\??)(\[\])?(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m && !m[3] && !m[4] && !models.has(m[2]))
      // @default(uuid()) / cuid() é gerado pelo cliente Prisma, não pelo banco: também entra.
      .filter((m) => !/@default\((?!uuid\(\)|cuid\(\))/.test(m[5]))
      .map((m) => m[1]);
    expect(required).toEqual(expect.arrayContaining(['id', 'username', 'displayName', 'role']));
    const columns = /INSERT INTO "User" \(([^)]+)\)/.exec(common)![1].split(',').map((c) => c.trim().replace(/"/g, ''));
    expect([...columns].sort((a, b) => a.localeCompare(b))).toEqual([...required].sort((a, b) => a.localeCompare(b)));
  });

  onWindows('com o PowerShell de verdade', () => {
    const sqlFor = (u: string, d: string, r: string) =>
      runPs(`try { $s = Get-AddUserSql -Username '${u.replace(/'/g, "''")}' -DisplayName '${d.replace(/'/g, "''")}' -Role '${r}'; ConvertTo-Json @{ sql = $s; err = $null } } catch { ConvertTo-Json @{ sql = $null; err = $_.Exception.Message } }`) as {
        sql: string | null;
        err: string | null;
      };

    it(
      'SQL: confere a tabela, conta antes, INSERT ... ON CONFLICT DO NOTHING com o tipo do enum, e mostra a linha',
      () => {
        const { sql, err } = sqlFor('rebeca', '  Rebeca Lara ', 'admin');
        expect(err).toBeNull();
        const s = sql!.replace(/\r\n/g, '\n');
        expect(s).toContain('\\set ON_ERROR_STOP on\n\\encoding UTF8\n');
        expect(s).toContain(`IF to_regclass('public."User"') IS NULL THEN`);
        expect(s).toContain(`SELECT 'ANTES|' || count(*) FROM "User" WHERE username = 'rebeca';`);
        expect(s).toContain(
          `INSERT INTO "User" (id, username, "displayName", role)\nVALUES (gen_random_uuid(), 'rebeca', 'Rebeca Lara', 'ADMIN'::"UserRole")\nON CONFLICT (username) DO NOTHING;`,
        );
        expect(s).toContain(`SELECT 'DEPOIS|' || username || '|' || role::text || '|' || "displayName" FROM "User" WHERE username = 'rebeca';`);
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );

    it(
      'aspa simples no nome é dobrada (sem injeção); acentos ficam como estão',
      () => {
        const { sql } = sqlFor('leitor', "Usuário D'Ávila'); DROP TABLE x; --", 'VIEWER');
        expect(sql).toContain(`'Usuário D''Ávila''); DROP TABLE x; --', 'VIEWER'::"UserRole"`);
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );

    it.each([
      ['Rebeca', 'Rebeca', 'ADMIN', /só letras minúsculas/],
      ['rebeca@rsd-demo.local', 'Rebeca', 'ADMIN', /sem @/],
      ["re'beca", 'Rebeca', 'ADMIN', /só letras minúsculas/],
      ['a'.repeat(65), 'Rebeca', 'ADMIN', /1 a 64/],
      ['rebeca', '   ', 'ADMIN', /de 1 a 200/],
      ['rebeca', 'x'.repeat(201), 'ADMIN', /de 1 a 200/],
      ['rebeca', 'Rebeca\tLara', 'ADMIN', /caractere de controle/],
      ['rebeca', 'Rebeca', 'ROOT', /Papel 'ROOT' inválido/],
    ])('recusa antes do banco: usuário %j, nome %j, papel %j', (u, d, r, msg) => {
      const { sql, err } = sqlFor(u, d, r);
      expect(sql).toBeNull();
      expect(err).toMatch(msg);
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);
  });
});

describe('deploy/check-newrelic-secrets.ps1 — prova de que nenhum segredo vai para o New Relic', () => {
  const script = codeOf('check-newrelic-secrets.ps1');

  it('lê os segredos do backend.env e nunca imprime um valor (só nomes, contagens e linhas)', () => {
    expect(script).toContain('Get-BackendSecrets -EnvValues $envValues');
    expect(script).toContain('Find-SecretOccurrences -Lines $lines -Secrets $secrets');
    const printed = script.split('\n').filter((l) => /Write-Host/.test(l));
    expect(printed.length).toBeGreaterThan(5);
    for (const l of printed) expect(l).not.toMatch(/\.Value\b|\$lines\b|\$line\b/);
    // A senha de teste é lida sem eco.
    expect(script).toMatch(/Read-Host -AsSecureString 'Senha de teste/);
  });

  it('apagar os logs só com confirmação explícita (SIM), e sempre lembra de desligar o audit log', () => {
    const ask = script.indexOf("Read-Host 'Apagar esses arquivos agora?");
    const remove = script.indexOf('Remove-Item -LiteralPath $f.FullName');
    expect(ask).toBeGreaterThan(0);
    expect(remove).toBeGreaterThan(ask);
    expect(script).toContain("if ($answer -ceq 'SIM') {");
    expect(script).toMatch(/LEMBRETE: desligue o audit log[^\n]*NEW_RELIC_AUDIT_LOG_ENABLED[^\n]*Restart-Service rsd-backend/);
    expect(script).toMatch(/if \(\$leakTotal -gt 0\) \{ exit 1 \}\s*$/);
  });

  onWindows('com o PowerShell de verdade', () => {
    const ENV = {
      JWT_SECRET: 'jwtSegredoDeTeste0123456789abcdefXYZ',
      LDAP_SEARCH_BIND_PASSWORD: 'LdapSenhaTeste',
      WINRM_PASSWORD: '',
      NEW_RELIC_LICENSE_KEY: 'abcdef0123456789'.repeat(2) + 'abcd' + 'NRAL', // montada: nenhuma literal no formato de uma license key
      DATABASE_URL: 'postgresql://rsd_app:Db%40Senha_9@127.0.0.1:5432/rsd?schema=public',
    };
    const KEY = ENV.NEW_RELIC_LICENSE_KEY;

    it(
      'Get-BackendSecrets: os segredos pelo nome, a senha do banco crua e decodificada; vazio fica de fora',
      () => {
        const out = runPs(`
          $e = @{ JWT_SECRET = '${ENV.JWT_SECRET}'; LDAP_SEARCH_BIND_PASSWORD = '${ENV.LDAP_SEARCH_BIND_PASSWORD}'; WINRM_PASSWORD = ''; NEW_RELIC_LICENSE_KEY = '${KEY}'; DATABASE_URL = '${ENV.DATABASE_URL}' }
          ConvertTo-Json -Compress @(Get-BackendSecrets -EnvValues $e | ForEach-Object { $_.Name + '=' + $_.Value })`) as string[];
        expect(out).toEqual([
          `JWT_SECRET=${ENV.JWT_SECRET}`,
          `LDAP_SEARCH_BIND_PASSWORD=${ENV.LDAP_SEARCH_BIND_PASSWORD}`,
          `NEW_RELIC_LICENSE_KEY=${KEY}`,
          'DATABASE_URL (senha)=Db%40Senha_9',
          'DATABASE_URL (senha)=Db@Senha_9',
        ]);
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );

    it(
      'Find-SecretOccurrences: chave no transporte ao coletor é esperada; em payload de log, vazamento; o resultado não traz valores',
      () => {
        const lines = [
          `{"component":"collector_api","msg":"Posting to https://collector.newrelic.com/agent_listener/invoke_raw_method?marshal_format=json&license_key=${KEY}&method=connect"}`,
          `{"headers":{"X-License-Key":"${KEY}","Content-Type":"application/json"}}`,
          `{"message":"linha de log com ${KEY} dentro","level":"INFO"}`,
          'linha sem segredo nenhum',
          `{"message":"jwt ${ENV.JWT_SECRET}"}`,
          `license_key=${KEY} e de novo ${KEY} solto`,
          '{"error.message":"conexão com Db@Senha_9 recusada"}',
        ];
        const out = runPs(`
          $lines = @(${lines.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ')})
          $s = @(Get-BackendSecrets -EnvValues @{ JWT_SECRET = '${ENV.JWT_SECRET}'; LDAP_SEARCH_BIND_PASSWORD = '${ENV.LDAP_SEARCH_BIND_PASSWORD}'; NEW_RELIC_LICENSE_KEY = '${KEY}'; DATABASE_URL = '${ENV.DATABASE_URL}' })
          ConvertTo-Json -Compress -Depth 4 @(Find-SecretOccurrences -Lines $lines -Secrets $s)`) as { Name: string; Expected: number; Leaks: number; LeakLines: number[] }[];
        const by = (name: string) => out.filter((r) => r.Name === name);
        expect(by('NEW_RELIC_LICENSE_KEY')).toEqual([{ Name: 'NEW_RELIC_LICENSE_KEY', Expected: 3, Leaks: 2, LeakLines: [3, 6] }]);
        expect(by('JWT_SECRET')).toEqual([{ Name: 'JWT_SECRET', Expected: 0, Leaks: 1, LeakLines: [5] }]);
        expect(by('LDAP_SEARCH_BIND_PASSWORD')).toEqual([{ Name: 'LDAP_SEARCH_BIND_PASSWORD', Expected: 0, Leaks: 0, LeakLines: [] }]);
        expect(by('DATABASE_URL (senha)').map((r) => r.Leaks)).toEqual([0, 1]); // crua: não aparece; decodificada: linha 7
        const json = JSON.stringify(out);
        for (const v of [KEY, ENV.JWT_SECRET, ENV.LDAP_SEARCH_BIND_PASSWORD, 'Db@Senha_9', 'Db%40Senha_9']) expect(json).not.toContain(v);
      },
      REAL_POWERSHELL_TEST_TIMEOUT_MS,
    );
  });
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
