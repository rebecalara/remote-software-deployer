# Teste: roda Initialize-RsdTempDir (temp-dir-rules.ps1) em cenários reais, numa pasta temporária
# desta máquina. O usuário atual entra como identidade extra permitida (-ExtraSids) e, quando o
# cenário pede, como dono (-OwnerSid) — só para o teste conseguir apagar as pastas no fim, sem
# precisar de administrador. Em produção, só SYSTEM e Administradores.
param([string] $Rules, [string] $Root)
$ErrorActionPreference = 'Stop'
. $Rules

$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$users = 'S-1-5-32-545'
$target = '11111111-1111-4111-8111-111111111111'

function New-ProtectedDir([string] $Path, [string[]] $Sids) {
  $sec = New-Object System.Security.AccessControl.DirectorySecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($sid in $Sids) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      (New-Object System.Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $sec.AddAccessRule($rule)
  }
  $null = [System.IO.Directory]::CreateDirectory($Path, $sec)
}

function Invoke-Case([string] $Name, [scriptblock] $Body) {
  try {
    $extra = & $Body
    @{ name = $Name; ok = $true; message = $null; extra = $extra }
  } catch {
    @{ name = $Name; ok = $false; message = $_.Exception.Message; extra = $null }
  }
}

function Describe-Acl([string] $Path) {
  $acl = Get-Acl -LiteralPath $Path
  @{
    owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    protected = $acl.AreAccessRulesProtected
    sids = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
  }
}

$out = @()

# 1) Pasta-base não existe: criada já com a ACL final; pasta do alvo criada dentro.
$base1 = Join-Path $Root 'nova\RSD'
$null = New-Item -ItemType Directory -Path (Split-Path $base1) -Force
$out += Invoke-Case 'cria-base-e-alvo' {
  $p = Initialize-RsdTempDir -BaseDir $base1 -TargetId $target -OwnerSid $me -ExtraSids @($me)
  @{ path = $p; exists = (Test-Path -LiteralPath $p -PathType Container); base = (Describe-Acl $base1); alvo = (Describe-Acl $p) }
}

# 2) De novo, com sobra de uma execução interrompida: a pasta do alvo é refeita vazia.
Set-Content -LiteralPath (Join-Path (Join-Path $base1 $target) 'sobra.txt') -Value 'x'
$out += Invoke-Case 'idempotente-refaz-alvo' {
  $p = Initialize-RsdTempDir -BaseDir $base1 -TargetId $target -OwnerSid $me -ExtraSids @($me)
  @{ files = @(Get-ChildItem -LiteralPath $p -Force).Count }
}

# 3) Pasta-base existente com permissão para Users: recusada, nada criado dentro.
$base3 = Join-Path $Root 'users\RSD'
$null = New-Item -ItemType Directory -Path (Split-Path $base3) -Force
New-ProtectedDir $base3 @($me, 'S-1-5-18', 'S-1-5-32-544', $users)
$out += Invoke-Case 'base-com-users' { Initialize-RsdTempDir -BaseDir $base3 -TargetId $target -OwnerSid $me -ExtraSids @($me) }
$out += @{ name = 'base-com-users-nada-dentro'; ok = (@(Get-ChildItem -LiteralPath $base3 -Force).Count -eq 0); message = $null }

# 4) Pasta-base com herança (criada do jeito comum): recusada.
$base4 = Join-Path $Root 'herdada\RSD'
$null = New-Item -ItemType Directory -Path $base4 -Force
$out += Invoke-Case 'base-com-heranca' { Initialize-RsdTempDir -BaseDir $base4 -TargetId $target -OwnerSid $me -ExtraSids @($me) }

# 5) Dono fora de SYSTEM/Administradores (aqui, o usuário atual): recusada.
$base5 = Join-Path $Root 'dono\RSD'
$null = New-Item -ItemType Directory -Path (Split-Path $base5) -Force
New-ProtectedDir $base5 @($me, 'S-1-5-18', 'S-1-5-32-544')
$out += Invoke-Case 'dono-errado' { Initialize-RsdTempDir -BaseDir $base5 -TargetId $target -ExtraSids @($me) }

# 6) Pasta-base é junção (aponta para outra pasta, mesmo com ACL certa): recusada.
$real6 = Join-Path $Root 'juncao-destino'
New-ProtectedDir $real6 @($me, 'S-1-5-18', 'S-1-5-32-544')
$base6 = Join-Path $Root 'juncao\RSD'
$null = New-Item -ItemType Directory -Path (Split-Path $base6) -Force
$null = New-Item -ItemType Junction -Path $base6 -Target $real6
$out += Invoke-Case 'base-juncao' { Initialize-RsdTempDir -BaseDir $base6 -TargetId $target -OwnerSid $me -ExtraSids @($me) }

# 7) Pasta do alvo é junção (sobra suspeita): recusada, e o destino da junção fica intacto.
$base7 = Join-Path $Root 'alvo-juncao\RSD'
$null = New-Item -ItemType Directory -Path (Split-Path $base7) -Force
$null = Initialize-RsdTempDir -BaseDir $base7 -TargetId 'preparo' -OwnerSid $me -ExtraSids @($me)
$victim = Join-Path $Root 'vitima'
$null = New-Item -ItemType Directory -Path $victim -Force
Set-Content -LiteralPath (Join-Path $victim 'importante.txt') -Value 'nao apagar'
$null = New-Item -ItemType Junction -Path (Join-Path $base7 $target) -Target $victim
$out += Invoke-Case 'alvo-juncao' { Initialize-RsdTempDir -BaseDir $base7 -TargetId $target -OwnerSid $me -ExtraSids @($me) }
$out += @{ name = 'alvo-juncao-destino-intacto'; ok = (Test-Path -LiteralPath (Join-Path $victim 'importante.txt')); message = $null }

$json = ConvertTo-Json -InputObject @{ me = $me; cases = @($out) } -Compress -Depth 6
[Console]::Out.WriteLine([regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
