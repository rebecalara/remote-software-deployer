# Funções comuns ao deploy (deploy.ps1), ao rollback (rollback.ps1) e ao preparo da VM
# (provision-app.ps1). Só definições: carregar este arquivo não executa nada.
# Windows PowerShell 5.1. Salvo em UTF-8 com BOM (as mensagens têm acento).

Set-StrictMode -Version 2.0

# ---------------------------------------------------------------------------------------------
# Caminhos fixos na APP-RSD (ver README, "Deploy em produção").
# ---------------------------------------------------------------------------------------------
function Get-RsdPaths {
  param([string]$Root = 'C:\rsd')
  [pscustomobject]@{
    Root        = $Root
    App         = Join-Path $Root 'app'
    Releases    = Join-Path $Root 'app\releases'
    Current     = Join-Path $Root 'app\current'
    History     = Join-Path $Root 'app\deploys.jsonl'
    Lock        = Join-Path $Root 'app\.deploy.lock'
    Config      = Join-Path $Root 'config'
    BackendEnv  = Join-Path $Root 'config\backend.env'
    DeployEnv   = Join-Path $Root 'config\deploy.env'
    CaPem       = Join-Path $Root 'config\rsd-ca.pem'
    Data        = Join-Path $Root 'data'
    Installers  = Join-Path $Root 'data\installers'
    Backups     = Join-Path $Root 'data\backups'
    Caddy       = Join-Path $Root 'caddy'
    Logs        = Join-Path $Root 'logs'
    Service     = Join-Path $Root 'service'
  }
}

$script:RsdServiceName = 'rsd-backend'
$script:RsdKeepReleases = 5
$script:RsdKeepBackups = 10

# ---------------------------------------------------------------------------------------------
# Arquivos .env: KEY=valor por linha, com ou sem aspas; # é comentário.
# ---------------------------------------------------------------------------------------------
function Read-EnvFile {
  param([Parameter(Mandatory)][string]$Path)
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $value = $t.Substring($eq + 1).Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }
  return $values
}

# Troca (ou acrescenta) uma chave num .env, sem mexer nas outras linhas nem nos comentários.
function Set-EnvValue {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  $lines = [Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $Path) { $lines.AddRange([IO.File]::ReadAllLines($Path)) }
  $newLine = "$Key=`"$Value`""
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$([regex]::Escape($Key))\s*=") { $lines[$i] = $newLine; $found = $true }
  }
  if (-not $found) { $lines.Add($newLine) }
  [IO.File]::WriteAllLines($Path, $lines, (New-Object Text.UTF8Encoding($false)))
}

# O pg_dump não aceita parâmetros que não são do libpq (o Prisma usa ?schema=public).
function ConvertTo-PgUri {
  param([Parameter(Mandatory)][string]$DatabaseUrl)
  $q = $DatabaseUrl.IndexOf('?')
  if ($q -ge 0) { return $DatabaseUrl.Substring(0, $q) }
  return $DatabaseUrl
}

# Senha aleatória forte, só com caracteres seguros numa URL (base64url).
function New-RandomSecret {
  param([int]$Bytes = 32)
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return ([Convert]::ToBase64String($buffer)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# ---------------------------------------------------------------------------------------------
# Versões publicadas: C:\rsd\app\releases\<aaaaMMdd-HHmmss>-<sha7>. A junção "current" aponta
# para a que está no ar. Junção, e não symlink: não exige privilégio de administrador.
# ---------------------------------------------------------------------------------------------
function New-ReleaseName {
  param([Parameter(Mandatory)][string]$Sha, [datetime]$When = (Get-Date))
  if ($Sha -notmatch '^[0-9a-f]{7,40}$') { throw "SHA inválido: '$Sha'." }
  return '{0}-{1}' -f $When.ToString('yyyyMMdd-HHmmss'), $Sha.Substring(0, 7)
}

function Get-CurrentRelease {
  param([Parameter(Mandatory)]$Paths)
  $item = Get-Item -LiteralPath $Paths.Current -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    $target = @($item.Target)[0]
    if ($target) { return (Split-Path -Leaf $target) }
  }
  throw "$($Paths.Current) existe e não é uma junção: confira à mão antes do deploy."
}

# Versões em ordem (a mais antiga primeiro), pelo nome com data.
function Get-Releases {
  param([Parameter(Mandatory)]$Paths)
  if (-not (Test-Path -LiteralPath $Paths.Releases)) { return @() }
  return @(Get-ChildItem -LiteralPath $Paths.Releases -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}-[0-9a-f]{7}$' } |
      Sort-Object Name | ForEach-Object Name)
}

# Aponta "current" para uma versão. Só mexe na junção (nunca no conteúdo das versões).
function Set-CurrentRelease {
  param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$Name)
  $target = Join-Path $Paths.Releases $Name
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "Versão inexistente: $target" }
  $item = Get-Item -LiteralPath $Paths.Current -Force -ErrorAction SilentlyContinue
  if ($item) {
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$($Paths.Current) não é uma junção." }
    [IO.Directory]::Delete($Paths.Current, $false) # apaga SÓ a junção, não o destino
  }
  $null = New-Item -ItemType Junction -Path $Paths.Current -Target $target
}

# Versões que podem ser apagadas: além das últimas $Keep, nunca a atual nem a anterior.
function Get-ReleasesToDelete {
  param([string[]]$Releases, [string]$Current, [string]$Previous, [int]$Keep = $script:RsdKeepReleases)
  $sorted = @($Releases | Sort-Object)
  if ($sorted.Count -le $Keep) { return @() }
  $old = $sorted[0..($sorted.Count - $Keep - 1)]
  return @($old | Where-Object { $_ -ne $Current -and $_ -ne $Previous })
}

function Remove-OldReleases {
  param([Parameter(Mandatory)]$Paths, [string]$Current, [string]$Previous)
  foreach ($name in (Get-ReleasesToDelete -Releases (Get-Releases $Paths) -Current $Current -Previous $Previous)) {
    $dir = Join-Path $Paths.Releases $name
    # Só pastas DENTRO de releases, com o nome no formato das versões.
    if ((Split-Path -Parent $dir) -ne $Paths.Releases) { throw "Caminho fora de releases: $dir" }
    Remove-Item -LiteralPath $dir -Recurse -Force
    Write-RsdLog "Versão antiga apagada: $name"
  }
}

# Backups de antes do deploy: mantém os $Keep mais recentes (só os que o deploy cria).
function Remove-OldBackups {
  param([Parameter(Mandatory)]$Paths, [int]$Keep = $script:RsdKeepBackups)
  $dumps = @(Get-ChildItem -LiteralPath $Paths.Backups -File -Filter 'rsd-antes-deploy-*.dump' -ErrorAction SilentlyContinue | Sort-Object Name)
  if ($dumps.Count -le $Keep) { return }
  foreach ($d in $dumps[0..($dumps.Count - $Keep - 1)]) {
    Remove-Item -LiteralPath $d.FullName -Force
    Write-RsdLog "Backup antigo apagado: $($d.Name)"
  }
}

# ---------------------------------------------------------------------------------------------
# Serviço e saúde do backend.
# ---------------------------------------------------------------------------------------------
function Test-BackendHealth {
  param([string]$Url = 'http://127.0.0.1:3000/health', [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $last = ''
  do {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
      if ($r.StatusCode -eq 200 -and ($r.Content | ConvertFrom-Json).status -eq 'ok') { return $true }
      $last = "HTTP $($r.StatusCode)"
    } catch {
      $last = $_.Exception.Message
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  Write-RsdLog "Health check sem sucesso em $TimeoutSeconds s ($Url): $last" 'WARN'
  return $false
}

function Restart-RsdService {
  param([string]$Name = $script:RsdServiceName)
  $svc = Get-Service -Name $Name -ErrorAction Stop
  if ($svc.Status -ne 'Stopped') {
    Stop-Service -Name $Name -ErrorAction Stop
    $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
  }
  Start-Service -Name $Name -ErrorAction Stop
}

function Stop-RsdService {
  param([string]$Name = $script:RsdServiceName)
  $svc = Get-Service -Name $Name -ErrorAction Stop
  if ($svc.Status -ne 'Stopped') {
    Stop-Service -Name $Name -ErrorAction Stop
    $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
  }
}

# ---------------------------------------------------------------------------------------------
# Log: console do job (e transcript) + resumo do GitHub Actions, quando houver.
# ---------------------------------------------------------------------------------------------
function Write-RsdLog {
  param([Parameter(Mandatory)][string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO')
  $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message
  if ($Level -eq 'WARN') { Write-Host "::warning::$Message" } elseif ($Level -eq 'ERROR') { Write-Host "::error::$Message" }
  Write-Host $line
}

function Add-JobSummary {
  param([Parameter(Mandatory)][string]$Markdown)
  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $Markdown -Encoding UTF8 }
}

function Add-DeployHistory {
  param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][hashtable]$Entry)
  $Entry['at'] = (Get-Date).ToString('o')
  Add-Content -LiteralPath $Paths.History -Value ($Entry | ConvertTo-Json -Compress) -Encoding UTF8
}

# Um deploy (ou rollback) por vez: arquivo aberto com acesso exclusivo enquanto o script roda.
function Enter-DeployLock {
  param([Parameter(Mandatory)]$Paths)
  try {
    return [IO.File]::Open($Paths.Lock, 'OpenOrCreate', 'ReadWrite', 'None')
  } catch {
    throw 'Outro deploy ou rollback está em andamento nesta máquina.'
  }
}
