#Requires -RunAsAdministrator
<#
  Preparo da APP-RSD (Windows Server 2022, domínio rsd-demo.local) — rodado UMA vez por
  administrador, à mão, a partir de um clone do repositório. Idempotente: rodar de novo só
  confere e completa o que falta. NÃO é o deploy (esse é o deploy.ps1, pelo GitHub Actions).

  O que faz:
    1. Pastas C:\rsd\... e permissões (ACL, sem herança).
    2. Node.js, Git e PostgreSQL nas versões exatas, com SHA-256 e assinatura conferidos.
    3. Banco "rsd" com dois papéis: rsd_owner (migrações) e rsd_app (só dados), senhas geradas
       aqui; permissões padrão para as tabelas e sequências que as migrações criarem.
    4. C:\rsd\config\deploy.env (rsd_owner; só o runner lê) e backend.env (rsd_app; só o
       serviço lê) — o backend.env só é criado se não existir.
    5. Contas: direito "Fazer logon como serviço" para RSDDEMO\svc-rsd; conta local rsd-runner
       (sem administração, sem logon interativo/RDP/rede).
    6. Serviço rsd-backend (WinSW) com a conta RSDDEMO\svc-rsd; o rsd-runner só consulta,
       inicia e para esse serviço.
    7. Caddyfile do repositório (deploy\Caddyfile), validado e recarregado — quando existir.
    8. Runner do GitHub Actions (labels self-hosted, windows, rsd-app) como serviço do rsd-runner.

  Nenhum segredo é escrito no repositório nem na tela. As senhas digitadas (svc-rsd, token do
  runner) são lidas como SecureString e não são guardadas em arquivo.

  Uso (PowerShell como administrador):
    Na primeira vez a VM não tem Git: "Download ZIP" da branch dev no GitHub, extrair e
    desbloquear (o Windows marca o que veio da internet):
      Expand-Archive .\remote-software-deployer-dev.zip -DestinationPath C:\rsd\setup\repo
      Get-ChildItem -Recurse C:\rsd\setup\repo | Unblock-File
      cd C:\rsd\setup\repo\remote-software-deployer-dev
    Depois, com o Git já instalado, o clone serve. Em qualquer caso:
      .\deploy\provision-app.ps1 -PublicHost rsd-demo-rebeca.chilecentral.cloudapp.azure.com
#>
[CmdletBinding()]
param(
  # Domínio público do RSD: entra no Caddyfile (no lugar de __RSD_PUBLIC_HOST__) e no deploy.env
  # (health check do site). Ex.: rsd-demo-rebeca.chilecentral.cloudapp.azure.com
  [Parameter(Mandatory)][ValidatePattern('^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$')][string]$PublicHost,
  [string]$Repo = 'rebecalara/remote-software-deployer',
  [string]$ServiceAccount = 'RSDDEMO\svc-rsd',
  [string]$RunnerAccount = 'rsd-runner',
  [string]$RunnerDir = 'C:\actions-runner',
  [string]$ExpectedDomain = 'rsd-demo.local',
  [string]$CaddyfileTarget = 'C:\rsd\caddy\Caddyfile',
  [string]$CaddyService = 'caddy',
  # Pede de novo a senha da svc-rsd e reconfigura o serviço (troca de senha da conta).
  [switch]$ResetServicePassword,
  [switch]$SkipRunner
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest fica muito lento com a barra
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'rsd-deploy-common.ps1')

$RepoRoot = Split-Path -Parent $PSScriptRoot
$P = Get-RsdPaths
$Setup = Join-Path $P.Root 'setup'

# ---------------------------------------------------------------------------------------------
# Versões exatas e hashes (SHA-256). Node e Git: hash publicado pelo projeto; PostgreSQL (EDB) e
# WinSW não publicam hash — o valor abaixo foi calculado do arquivo oficial e é conferido aqui.
# ---------------------------------------------------------------------------------------------
$Downloads = @{
  Node = @{
    Version = '22.23.5'
    Url     = 'https://nodejs.org/dist/v22.23.5/node-v22.23.5-x64.msi'
    Sha256  = '963a110509eca7e0d6cc009095ccb4117e26d59287876a056b79293ae3fef238'
    Signer  = 'OpenJS Foundation'
  }
  Git = @{
    Version = '2.56.1.windows.1'
    Url     = 'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe'
    Sha256  = 'c330c72e10b408cc39994bfefdb63542b0d93d21699325c3e0bd874af8a5a559'
    Signer  = 'Johannes Schindelin'
  }
  Postgres = @{
    Version = '18.6'
    Url     = 'https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64.exe'
    Sha256  = 'cae561e98d09f3f4a1a95759249240f86f66d71dcf33d14b6f7be894078401d1'
    Signer  = 'EnterpriseDB Corporation'
  }
  WinSW = @{
    Version = '2.12.0'
    Url     = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'
    Sha256  = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
    Signer  = $null # sem assinatura Authenticode: vale só o hash
  }
  Runner = @{
    Version = '2.338.2'
    Url     = 'https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-win-x64-2.338.2.zip'
    Sha256  = 'a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc'
    Signer  = $null
  }
}
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$GitExe = 'C:\Program Files\Git\cmd\git.exe'
$PgRoot = 'C:\Program Files\PostgreSQL\18'
$PgService = 'postgresql-x64-18'
$DbName = 'rsd'

function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Info([string]$Text) { Write-Host "   $Text" }
function Warn([string]$Text) { Write-Host "   AVISO: $Text" -ForegroundColor Yellow }

function Get-VerifiedDownload {
  param([Parameter(Mandatory)][hashtable]$Spec)
  $file = Join-Path $Setup (Split-Path -Leaf $Spec.Url)
  if (-not (Test-Path -LiteralPath $file)) {
    Info "Baixando $(Split-Path -Leaf $Spec.Url)..."
    Invoke-WebRequest -UseBasicParsing -Uri $Spec.Url -OutFile $file
  }
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $Spec.Sha256) {
    Remove-Item -LiteralPath $file -Force
    throw "SHA-256 diferente do esperado para $(Split-Path -Leaf $file) (esperado $($Spec.Sha256), veio $hash). Arquivo apagado; nada foi instalado."
  }
  if ($Spec.Signer) {
    $sig = Get-AuthenticodeSignature -LiteralPath $file
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch [regex]::Escape($Spec.Signer)) {
      throw "Assinatura inválida em $(Split-Path -Leaf $file): $($sig.Status) $($sig.SignerCertificate.Subject)"
    }
  }
  Info "Conferido: $(Split-Path -Leaf $file) (SHA-256 ok$(if ($Spec.Signer) { ', assinatura ok' }))."
  return $file
}

function Invoke-Checked {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @(), [int[]]$OkCodes = @(0))
  $p = Start-Process -FilePath $Exe -ArgumentList $Arguments -Wait -PassThru -NoNewWindow
  if ($OkCodes -notcontains $p.ExitCode) { throw "$(Split-Path -Leaf $Exe) terminou com código $($p.ExitCode)." }
}

function Resolve-Sid([string]$Account) {
  return (New-Object Security.Principal.NTAccount($Account)).Translate([Security.Principal.SecurityIdentifier])
}

# ACL nova, sem herança: SYSTEM e Administradores com controle total + as regras dadas.
function Set-RsdAcl {
  param([Parameter(Mandatory)][string]$Path, [array]$Rules = @(), [switch]$File)
  $acl = if ($File) { New-Object Security.AccessControl.FileSecurity } else { New-Object Security.AccessControl.DirectorySecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = if ($File) { 'None' } else { 'ContainerInherit, ObjectInherit' }
  $base = @(
    @{ Sid = (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')); Rights = 'FullControl' }
    @{ Sid = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')); Rights = 'FullControl' }
  )
  foreach ($r in ($base + $Rules)) {
    $flags = if ($r.ContainsKey('Inherit')) { $r.Inherit } else { $inherit }
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($r.Sid, $r.Rights, $flags, 'None', 'Allow')))
  }
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

# Direitos de usuário (Fazer logon como serviço / Negar logon...) pela API de política local.
function Add-AccountRight {
  param([Parameter(Mandatory)][Security.Principal.SecurityIdentifier]$Sid, [Parameter(Mandatory)][string[]]$Rights)
  if (-not ('RsdLsa' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class RsdLsa {
  [StructLayout(LayoutKind.Sequential)] struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attr, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaAddAccountRights(IntPtr handle, byte[] sid, LSA_UNICODE_STRING[] rights, uint count);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  public static void Add(byte[] sid, string right) {
    var attr = new LSA_OBJECT_ATTRIBUTES(); IntPtr h;
    uint s = LsaOpenPolicy(IntPtr.Zero, ref attr, 0x00000800 | 0x00000010, out h); // POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES
    if (s != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(s));
    try {
      var u = new LSA_UNICODE_STRING(); u.Buffer = Marshal.StringToHGlobalUni(right);
      u.Length = (ushort)(right.Length * 2); u.MaximumLength = (ushort)(u.Length + 2);
      try { s = LsaAddAccountRights(h, sid, new[] { u }, 1); } finally { Marshal.FreeHGlobal(u.Buffer); }
      if (s != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(s));
    } finally { LsaClose(h); }
  }
}
'@
  }
  $bytes = New-Object byte[] $Sid.BinaryLength
  $Sid.GetBinaryForm($bytes, 0)
  foreach ($right in $Rights) { [RsdLsa]::Add($bytes, $right) }
}

function Get-PlainText([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

# Executa SQL como o superusuário "postgres", a partir de um arquivo temporário só de administrador
# (as senhas nunca vão para a linha de comando).
function Invoke-PgSql {
  param([Parameter(Mandatory)][string]$Sql, [string]$Database = 'postgres', [switch]$Scalar)
  $tmp = Join-Path $Setup ("pg-{0}.sql" -f [guid]::NewGuid())
  [IO.File]::WriteAllText($tmp, $Sql, (New-Object Text.UTF8Encoding($false)))
  Set-RsdAcl -Path $tmp -File
  try {
    $env:PGPASSWORD = $script:PgSuperPassword
    $psqlArgs = @('-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'postgres', '-d', $Database, '-f', $tmp)
    if ($Scalar) { $psqlArgs += @('-t', '-A') }
    $out = & (Join-Path $PgRoot 'bin\psql.exe') @psqlArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "psql falhou: $($out -join ' ')" }
    return ($out -join "`n").Trim()
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

# =============================================================================================
Step '1. Conferências iniciais'
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
Info "Windows: $($os.Caption) (build $($os.BuildNumber)); máquina $($env:COMPUTERNAME)."
if ($os.BuildNumber -ne '20348') { Warn 'não é o Windows Server 2022 (build 20348) previsto.' }
if (-not $cs.PartOfDomain -or $cs.Domain -ne $ExpectedDomain) { throw "A máquina precisa estar no domínio $ExpectedDomain (está em: $($cs.Domain))." }
$SvcSid = Resolve-Sid $ServiceAccount
Info "Conta do serviço: $ServiceAccount ($SvcSid)."

# =============================================================================================
Step '2. Pastas'
foreach ($dir in @($P.Root, $P.App, $P.Releases, $P.Config, $P.Data, $P.Installers, $P.Backups, $P.Caddy, $P.Logs, $P.Service, $Setup)) {
  if (-not (Test-Path -LiteralPath $dir)) { $null = New-Item -ItemType Directory -Path $dir; Info "Criada: $dir" }
}
# Antes de qualquer arquivo com senha: setup e config só para SYSTEM e Administradores.
Set-RsdAcl -Path $Setup
Set-RsdAcl -Path $P.Config

# =============================================================================================
Step "3. Node.js $($Downloads.Node.Version)"
$nodeVersion = if (Test-Path $NodeExe) { (& $NodeExe --version).Trim() } else { $null }
if ($nodeVersion -eq "v$($Downloads.Node.Version)") {
  Info "Já instalado ($nodeVersion)."
} elseif ($nodeVersion -and $nodeVersion -notlike 'v22.*') {
  throw "Há outro Node.js instalado ($nodeVersion). Remova-o antes (o RSD usa a linha 22)."
} else {
  $msi = Get-VerifiedDownload $Downloads.Node
  Invoke-Checked -Exe 'msiexec.exe' -Arguments @('/i', "`"$msi`"", '/qn', '/norestart') -OkCodes @(0, 3010)
  Info "Instalado: $((& $NodeExe --version).Trim())."
}

# =============================================================================================
Step "4. Git $($Downloads.Git.Version)"
$gitVersion = if (Test-Path $GitExe) { (& $GitExe --version).Trim() } else { $null }
if ($gitVersion -eq "git version $($Downloads.Git.Version)") {
  Info "Já instalado ($gitVersion)."
} else {
  $exe = Get-VerifiedDownload $Downloads.Git
  Invoke-Checked -Exe $exe -Arguments @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES')
  Info "Instalado: $((& $GitExe --version).Trim())."
}

# =============================================================================================
Step "5. PostgreSQL $($Downloads.Postgres.Version)"
$SuperFile = Join-Path $P.Config 'postgres-superuser.txt'
$pgExe = Join-Path $PgRoot 'bin\postgres.exe'
if (Test-Path $pgExe) {
  $pgVersion = (& $pgExe --version).Trim()
  if ($pgVersion -notmatch " $([regex]::Escape($Downloads.Postgres.Version))$") { throw "Há outro PostgreSQL 18 instalado ($pgVersion); o RSD espera o $($Downloads.Postgres.Version)." }
  if (-not (Test-Path $SuperFile)) { throw "PostgreSQL instalado, mas sem $SuperFile (senha do superusuário). Confira à mão." }
  Info "Já instalado ($pgVersion)."
  $script:PgSuperPassword = ([IO.File]::ReadAllText($SuperFile)).Trim()
} else {
  $script:PgSuperPassword = New-RandomSecret
  [IO.File]::WriteAllText($SuperFile, $script:PgSuperPassword)
  Set-RsdAcl -Path $SuperFile -File # só SYSTEM e Administradores
  $installer = Get-VerifiedDownload $Downloads.Postgres
  # Opções num arquivo (a senha não vai para a linha de comando), apagado logo depois.
  $optFile = Join-Path $Setup 'postgres-options.txt'
  @(
    'mode=unattended'
    'unattendedmodeui=none'
    "superpassword=$($script:PgSuperPassword)"
    'serverport=5432'
    "servicename=$PgService"
    "prefix=$PgRoot"
    "datadir=$PgRoot\data"
    'enable-components=server,commandlinetools'
    'disable-components=pgAdmin,stackbuilder'
  ) | Set-Content -LiteralPath $optFile -Encoding ASCII
  Set-RsdAcl -Path $optFile -File
  try {
    Invoke-Checked -Exe $installer -Arguments @('--optionfile', "`"$optFile`"")
  } finally {
    Remove-Item -LiteralPath $optFile -Force -ErrorAction SilentlyContinue
  }
  Info 'Instalado.'
}

# Só conexões locais, com senha (scram-sha-256).
$dataDir = Join-Path $PgRoot 'data'
$hba = Join-Path $dataDir 'pg_hba.conf'
$hbaWanted = @(
  '# Gerado pelo provision-app.ps1 (RSD): só conexões locais, com senha (scram-sha-256).'
  'host    all    all    127.0.0.1/32    scram-sha-256'
  'host    all    all    ::1/128         scram-sha-256'
) -join "`r`n"
$restartPg = $false
if (([IO.File]::ReadAllText($hba)).Trim() -ne $hbaWanted.Trim()) {
  Copy-Item -LiteralPath $hba -Destination "$hba.rsd-$(Get-Date -Format yyyyMMddHHmmss).bak"
  [IO.File]::WriteAllText($hba, $hbaWanted + "`r`n")
  $restartPg = $true
  Info 'pg_hba.conf: só 127.0.0.1 e ::1, scram-sha-256.'
}
$listen = Invoke-PgSql -Sql 'SHOW listen_addresses;' -Scalar
if ($listen -ne '127.0.0.1') {
  $null = Invoke-PgSql -Sql "ALTER SYSTEM SET listen_addresses = '127.0.0.1';"
  $restartPg = $true
  Info 'listen_addresses = 127.0.0.1.'
}
if ($restartPg) { Restart-Service -Name $PgService; Start-Sleep -Seconds 3 }
$openRules = @(Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue | Where-Object LocalPort -eq '5432' |
    Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
foreach ($r in $openRules) { Disable-NetFirewallRule -Name $r.Name; Warn "regra de firewall '$($r.DisplayName)' (entrada na 5432) desativada." }

# =============================================================================================
Step '6. Banco e papéis (rsd_owner: migrações; rsd_app: só dados)'
$ownerPassword = $null; $appPassword = $null
if (Test-Path $P.DeployEnv) {
  $u = (Read-EnvFile $P.DeployEnv)['DATABASE_URL']
  if ($u -match '^postgresql://rsd_owner:([^@]+)@') { $ownerPassword = $Matches[1] }
}
if (Test-Path $P.BackendEnv) {
  $u = (Read-EnvFile $P.BackendEnv)['DATABASE_URL']
  if ($u -match '^postgresql://rsd_app:([^@]+)@') { $appPassword = $Matches[1] }
}
$ownerExists = (Invoke-PgSql -Sql "SELECT count(*) FROM pg_roles WHERE rolname = 'rsd_owner';" -Scalar) -eq '1'
$appExists = (Invoke-PgSql -Sql "SELECT count(*) FROM pg_roles WHERE rolname = 'rsd_app';" -Scalar) -eq '1'
# Papel novo ou sem senha conhecida nos arquivos: senha nova (o arquivo é atualizado em seguida).
$setOwner = -not $ownerExists -or -not $ownerPassword
$setApp = -not $appExists -or -not $appPassword
if ($setOwner) { $ownerPassword = New-RandomSecret }
if ($setApp) { $appPassword = New-RandomSecret }
$roleSql = @"
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rsd_owner') THEN CREATE ROLE rsd_owner LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rsd_app') THEN CREATE ROLE rsd_app LOGIN; END IF;
END `$`$;
ALTER ROLE rsd_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE rsd_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
"@
if ($setOwner) { $roleSql += "ALTER ROLE rsd_owner WITH PASSWORD '$ownerPassword';`n" }
if ($setApp) { $roleSql += "ALTER ROLE rsd_app WITH PASSWORD '$appPassword';`n" }
$null = Invoke-PgSql -Sql $roleSql
if ((Invoke-PgSql -Sql "SELECT count(*) FROM pg_database WHERE datname = '$DbName';" -Scalar) -ne '1') {
  $null = Invoke-PgSql -Sql "CREATE DATABASE $DbName OWNER rsd_owner ENCODING 'UTF8' TEMPLATE template0;"
  Info "Banco $DbName criado (dono: rsd_owner)."
}
# Permissões: rsd_app lê e grava em todas as tabelas e sequências, inclusive as que as migrações
# (rodadas pelo rsd_owner) criarem depois — ALTER DEFAULT PRIVILEGES. Nada de DDL para o rsd_app.
$null = Invoke-PgSql -Database $DbName -Sql @"
REVOKE ALL ON DATABASE $DbName FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $DbName TO rsd_owner;
GRANT CONNECT ON DATABASE $DbName TO rsd_app;
ALTER SCHEMA public OWNER TO rsd_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO rsd_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rsd_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO rsd_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rsd_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rsd_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rsd_owner IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO rsd_app;
"@
Info 'Papéis e permissões conferidos.'

# =============================================================================================
Step '7. Arquivos de configuração (fora do repositório)'
$ownerUrl = "postgresql://rsd_owner:$ownerPassword@127.0.0.1:5432/${DbName}?schema=public"
$appUrl = "postgresql://rsd_app:$appPassword@127.0.0.1:5432/${DbName}?schema=public"
# deploy.env: só o que o deploy precisa (o runner NÃO lê o backend.env).
$deployLines = @(
  '# Gerado pelo provision-app.ps1. Só o runner (rsd-runner) lê este arquivo.'
  "DATABASE_URL=`"$ownerUrl`""
  "RSD_PUBLIC_HOST=`"$PublicHost`""
  "PG_BIN=`"$PgRoot\bin`""
)
[IO.File]::WriteAllLines($P.DeployEnv, $deployLines, (New-Object Text.UTF8Encoding($false)))
if (-not (Test-Path $P.BackendEnv)) {
  $template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'backend.env.example'))
  $template = $template.Replace('__DATABASE_URL__', $appUrl).Replace('__INSTALLER_STORAGE_DIR__', $P.Installers)
  [IO.File]::WriteAllText($P.BackendEnv, $template, (New-Object Text.UTF8Encoding($false)))
  Info 'backend.env criado a partir de deploy\backend.env.example.'
} elseif ($setApp) {
  Set-EnvValue -Path $P.BackendEnv -Key 'DATABASE_URL' -Value $appUrl
  Info 'backend.env: DATABASE_URL atualizado (senha nova do rsd_app).'
} else {
  Info 'backend.env já existe: não foi alterado.'
}

# =============================================================================================
Step "8. Conta local $RunnerAccount e direitos de logon"
$runnerPassword = New-RandomSecret
$runnerUser = Get-LocalUser -Name $RunnerAccount -ErrorAction SilentlyContinue
$securePw = ConvertTo-SecureString $runnerPassword -AsPlainText -Force
if (-not $runnerUser) {
  $null = New-LocalUser -Name $RunnerAccount -Password $securePw -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description 'RSD: runner do GitHub Actions (deploy). Sem administração.'
  Info "Conta $RunnerAccount criada."
} else {
  Set-LocalUser -Name $RunnerAccount -Password $securePw
  Info "Conta $RunnerAccount já existe (senha trocada: o runner é reconfigurado abaixo, se preciso)."
}
$RunnerSid = Resolve-Sid "$env:COMPUTERNAME\$RunnerAccount"
foreach ($g in @(Get-LocalGroup | Where-Object { Get-LocalGroupMember -Group $_ -ErrorAction SilentlyContinue | Where-Object { $_.SID -eq $RunnerSid } })) {
  if ($g.SID.Value -in @('S-1-5-32-544', 'S-1-5-32-555', 'S-1-5-32-580')) { Remove-LocalGroupMember -Group $g -Member $RunnerSid; Warn "$RunnerAccount removida do grupo $($g.Name)." }
}
Add-AccountRight -Sid $SvcSid -Rights @('SeServiceLogonRight')
Add-AccountRight -Sid $RunnerSid -Rights @('SeServiceLogonRight', 'SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight')
Info "${ServiceAccount} e ${RunnerAccount}: 'Fazer logon como serviço'; $RunnerAccount sem logon local, RDP e rede."

# =============================================================================================
Step '9. Permissões (ACL, sem herança)'
$RX = 'ReadAndExecute'; $M = 'Modify'
Set-RsdAcl -Path $P.Root -Rules @(
  @{ Sid = $SvcSid; Rights = $RX; Inherit = 'None' }
  @{ Sid = $RunnerSid; Rights = $RX; Inherit = 'None' }
)
Set-RsdAcl -Path $P.App -Rules @(@{ Sid = $SvcSid; Rights = $RX }, @{ Sid = $RunnerSid; Rights = $M })
Set-RsdAcl -Path $P.Service -Rules @(@{ Sid = $SvcSid; Rights = $RX })
Set-RsdAcl -Path $P.Config
Set-RsdAcl -Path $P.BackendEnv -File -Rules @(@{ Sid = $SvcSid; Rights = 'Read' })
Set-RsdAcl -Path $P.DeployEnv -File -Rules @(@{ Sid = $RunnerSid; Rights = 'Read' })
if (Test-Path $P.CaPem) { Set-RsdAcl -Path $P.CaPem -File -Rules @(@{ Sid = $SvcSid; Rights = 'Read' }) }
Set-RsdAcl -Path $P.Data -Rules @(@{ Sid = $SvcSid; Rights = $RX; Inherit = 'None' }, @{ Sid = $RunnerSid; Rights = $RX; Inherit = 'None' })
# Instaladores: SÓ o serviço; o runner não tem acesso nenhum.
Set-RsdAcl -Path $P.Installers -Rules @(@{ Sid = $SvcSid; Rights = $M })
Set-RsdAcl -Path $P.Backups -Rules @(@{ Sid = $RunnerSid; Rights = $M })
Set-RsdAcl -Path $P.Logs -Rules @(@{ Sid = $SvcSid; Rights = $M }, @{ Sid = $RunnerSid; Rights = $M })
# C:\rsd\caddy: não muda (o Caddy roda como SYSTEM; o runner não tem acesso).
Info 'ACLs aplicadas.'

# =============================================================================================
Step "10. Serviço $($script:RsdServiceName) (WinSW $($Downloads.WinSW.Version)) com $ServiceAccount"
$winsw = Get-VerifiedDownload $Downloads.WinSW
$svcExe = Join-Path $P.Service 'rsd-backend.exe'
Copy-Item -LiteralPath $winsw -Destination $svcExe -Force
$xml = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'rsd-backend.xml'))
$caLine = '  <!-- RSD_CA_CERTS: o provision troca esta linha por NODE_EXTRA_CA_CERTS só se C:\rsd\config\rsd-ca.pem existir. -->'
if (-not $xml.Contains($caLine)) { throw 'deploy\rsd-backend.xml sem a linha RSD_CA_CERTS esperada.' }
$xml = $xml.Replace($caLine, $(if (Test-Path $P.CaPem) { "  <env name=`"NODE_EXTRA_CA_CERTS`" value=`"$($P.CaPem)`"/>" } else { '  <!-- NODE_EXTRA_CA_CERTS: sem C:\rsd\config\rsd-ca.pem -->' }))
[IO.File]::WriteAllText((Join-Path $P.Service 'rsd-backend.xml'), $xml, (New-Object Text.UTF8Encoding($false)))
$svc = Get-Service -Name $script:RsdServiceName -ErrorAction SilentlyContinue
$needPassword = $ResetServicePassword
if (-not $svc) {
  Invoke-Checked -Exe $svcExe -Arguments @('install')
  $needPassword = $true
  Info 'Serviço instalado.'
}
if ($needPassword) {
  $svcPassword = Read-Host -AsSecureString "Senha da conta $ServiceAccount (não é guardada em arquivo)"
  $r = Invoke-CimMethod -ClassName Win32_Service -Filter "Name='$($script:RsdServiceName)'" -MethodName Change -Arguments @{ StartName = $ServiceAccount; StartPassword = (Get-PlainText $svcPassword) }
  if ($r.ReturnValue -ne 0) { throw "Não foi possível configurar a conta do serviço (Win32_Service.Change = $($r.ReturnValue))." }
  Info "Serviço configurado para rodar como $ServiceAccount."
}
# O rsd-runner só consulta (LC, RC, LO), inicia (RP) e para (WP) ESTE serviço.
$sddl = ((& sc.exe sdshow $script:RsdServiceName) -join '').Trim()
$ace = "(A;;RPWPLCLORC;;;$RunnerSid)"
if (-not $sddl.Contains($ace)) {
  $sddl = if ($sddl.Contains('S:')) { $sddl.Insert($sddl.IndexOf('S:'), $ace) } else { $sddl + $ace }
  $null = & sc.exe sdset $script:RsdServiceName $sddl
  if ($LASTEXITCODE -ne 0) { throw 'sc.exe sdset falhou.' }
  Info "$RunnerAccount pode consultar, iniciar e parar só o $($script:RsdServiceName)."
}
if (Test-Path $P.Current) {
  Restart-RsdService
  Info "Serviço reiniciado (versão $(Get-CurrentRelease $P))."
} else {
  Info 'Ainda sem versão publicada: o primeiro deploy inicia o serviço.'
}

# =============================================================================================
Step '11. Caddy'
# O Caddyfile do repositório tem __RSD_PUBLIC_HOST__ no lugar do domínio (como o backend.env.example
# tem __DATABASE_URL__): este passo troca pelo -PublicHost, valida, guarda o anterior e REINICIA o
# serviço — com "admin off" não existe "caddy reload". Se o Caddy não subir, volta o anterior.
$caddyTemplate = Join-Path $RepoRoot 'deploy\Caddyfile'
$caddySvc = Get-CimInstance Win32_Service -Filter "Name='$CaddyService'"
if (-not (Test-Path $caddyTemplate)) {
  Warn 'deploy\Caddyfile não encontrado no repositório: Caddy não alterado.'
} elseif (-not $caddySvc) {
  Warn "serviço '$CaddyService' não encontrado: Caddy não alterado."
} else {
  $caddyExe = ([regex]::Match($caddySvc.PathName, '^"?([^"]+?\.exe)')).Groups[1].Value
  $rendered = Join-Path $Setup 'Caddyfile'
  $text = [IO.File]::ReadAllText($caddyTemplate)
  if (-not $text.Contains('__RSD_PUBLIC_HOST__')) { throw 'deploy\Caddyfile sem o marcador __RSD_PUBLIC_HOST__.' }
  [IO.File]::WriteAllText($rendered, $text.Replace('__RSD_PUBLIC_HOST__', $PublicHost), (New-Object Text.UTF8Encoding($false)))
  & $caddyExe validate --config $rendered --adapter caddyfile
  if ($LASTEXITCODE -ne 0) { throw 'caddy validate recusou o Caddyfile: nada foi alterado.' }
  $current = if (Test-Path $CaddyfileTarget) { [IO.File]::ReadAllText($CaddyfileTarget) } else { '' }
  if ($current -eq [IO.File]::ReadAllText($rendered)) {
    Info 'Caddyfile já é o do repositório: Caddy não reiniciado.'
  } else {
    $backup = $null
    if ($current) { $backup = "$CaddyfileTarget.bak-$(Get-Date -Format yyyyMMddHHmmss)"; Copy-Item -LiteralPath $CaddyfileTarget -Destination $backup }
    Copy-Item -LiteralPath $rendered -Destination $CaddyfileTarget -Force
    $ok = $true
    try {
      Restart-Service -Name $CaddyService
      (Get-Service -Name $CaddyService).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
      Start-Sleep -Seconds 3 # o Caddy sobe e cai em seguida se a configuração não carregar
      $ok = (Get-Service -Name $CaddyService).Status -eq 'Running' -and [bool](Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue)
    } catch { $ok = $false }
    if (-not $ok) {
      if ($backup) {
        Copy-Item -LiteralPath $backup -Destination $CaddyfileTarget -Force
        Restart-Service -Name $CaddyService -ErrorAction SilentlyContinue
      }
      throw "O Caddy não ficou no ar com o Caddyfile novo (serviço parado ou porta 443 fechada). Anterior restaurado; veja C:\rsd\logs\caddy.log."
    }
    Info "Caddyfile aplicado para $PublicHost e Caddy reiniciado$(if ($backup) { " (anterior em $backup)" })."
    if (-not (Test-Path $P.Current)) { Info 'O site só mostra o frontend depois do primeiro deploy (C:\rsd\app\current ainda não existe).' }
  }
}

# =============================================================================================
Step "12. Runner do GitHub Actions ($($Downloads.Runner.Version))"
if ($SkipRunner) {
  Info 'Pulado (-SkipRunner).'
} else {
  if (-not (Test-Path $RunnerDir)) { $null = New-Item -ItemType Directory -Path $RunnerDir }
  Set-RsdAcl -Path $RunnerDir -Rules @(@{ Sid = $RunnerSid; Rights = $M })
  if (Test-Path (Join-Path $RunnerDir '.runner')) {
    # Já registrado: só atualiza a senha da conta no serviço do runner (trocada no passo 8).
    $runnerSvc = Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'actions.runner.*' } | Select-Object -First 1
    if ($runnerSvc) {
      $null = Invoke-CimMethod -InputObject $runnerSvc -MethodName Change -Arguments @{ StartName = ".\$RunnerAccount"; StartPassword = $runnerPassword }
      Restart-Service -Name $runnerSvc.Name
      Info "Runner já registrado; serviço $($runnerSvc.Name) reiniciado."
    }
  } else {
    $zip = Get-VerifiedDownload $Downloads.Runner
    Expand-Archive -LiteralPath $zip -DestinationPath $RunnerDir -Force
    $token = Get-PlainText (Read-Host -AsSecureString "Token de registro do runner (GitHub > Settings > Actions > Runners > New self-hosted runner)")
    Push-Location $RunnerDir
    try {
      & .\config.cmd --unattended --url "https://github.com/$Repo" --token $token --name $env:COMPUTERNAME `
        --labels 'rsd-app' --work '_work' --runasservice --windowslogonaccount ".\$RunnerAccount" --windowslogonpassword $runnerPassword --replace
      if ($LASTEXITCODE -ne 0) { throw 'config.cmd do runner falhou.' }
    } finally { Pop-Location }
    Info 'Runner registrado (labels: self-hosted, Windows, X64, rsd-app) e rodando como serviço.'
  }
}

# =============================================================================================
Step 'Resumo'
$envValues = Read-EnvFile $P.BackendEnv
$missing = @('JWT_SECRET', 'LDAP_URL', 'LDAP_BIND_DN_TEMPLATE', 'LDAP_SEARCH_BIND_DN', 'LDAP_SEARCH_BIND_PASSWORD', 'LDAP_COMPUTER_BASE_DN') |
  Where-Object { -not $envValues[$_] -or $envValues[$_] -eq 'ldaps://' }
Info "Node $((& $NodeExe --version).Trim()); $((& $GitExe --version).Trim()); $((& $pgExe --version).Trim())."
Info "Banco ${DbName}: rsd_owner (C:\rsd\config\deploy.env) e rsd_app (C:\rsd\config\backend.env)."
if ($missing) { Warn "preencha no backend.env: $($missing -join ', ')." } else { Info 'backend.env sem campos obrigatórios vazios.' }
if (Test-Path $P.CaPem) { Info 'CA do AD: C:\rsd\config\rsd-ca.pem (NODE_EXTRA_CA_CERTS no serviço).' } else { Warn 'sem C:\rsd\config\rsd-ca.pem: o LDAPS com a CA interna do AD não vai validar o certificado.' }
Info 'Para rodar este preparo de novo: o Git já está instalado, então use um git clone do repositório (o ZIP só era preciso na primeira vez).'
Info 'Pronto. O próximo passo é o PR dev -> main (o primeiro deploy roda sozinho).'
