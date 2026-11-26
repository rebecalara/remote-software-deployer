#Requires -RunAsAdministrator
<#
  Cadastra um usuário do RSD (tabela "User") na APP-RSD. O login nunca cria usuário: ele faz o
  bind no AD e depois procura o nome digitado, em minúsculas, nesta tabela.

  Rodar como administrador, DEPOIS do primeiro deploy (é ele que cria as tabelas), uma vez por
  usuário. Pode rodar de novo: usuário que já existe não é alterado (o script mostra como está
  e avisa se o papel ou o nome forem diferentes do pedido).

  Conecta como rsd_app (só dados; a senha vem do C:\rsd\config\backend.env) — inserir usuário não
  precisa do rsd_owner. Os valores vão como literais SQL escapados num arquivo temporário em UTF-8
  (na linha de comando, os acentos chegariam corrompidos pela página de código do console); a
  senha vai só pelo PGPASSWORD.

  Uso:
    .\deploy\add-user.ps1 -Username rebeca   -DisplayName 'Rebeca Lara' -Role ADMIN
    .\deploy\add-user.ps1 -Username operador -DisplayName 'Operador'    -Role OPERATOR
    .\deploy\add-user.ps1 -Username leitor   -DisplayName 'Leitor'      -Role VIEWER

  -Username é o que a pessoa digita no login, sem o domínio: o LDAP_BIND_DN_TEMPLATE da APP-RSD
  ({{username}}@rsd-demo.local) acrescenta o @rsd-demo.local.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Username,
  [Parameter(Mandatory)][string]$DisplayName,
  [Parameter(Mandatory)][ValidateSet('ADMIN', 'OPERATOR', 'VIEWER')][string]$Role,
  [string]$Root = 'C:\rsd',
  [string]$PgBin
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'rsd-deploy-common.ps1')
$P = Get-RsdPaths -Root $Root

# Confere os dados antes de tocar no banco (minúsculas, sem @, papel, nome de exibição).
$sqlText = Get-AddUserSql -Username $Username -DisplayName $DisplayName -Role $Role
$Role = $Role.ToUpperInvariant()
$DisplayName = $DisplayName.Trim()

if (-not $PgBin) { $PgBin = (Read-EnvFile $P.DeployEnv)['PG_BIN'] }
$psql = Join-Path $PgBin 'psql.exe'
if (-not (Test-Path -LiteralPath $psql)) { throw "psql.exe não encontrado em $PgBin (PG_BIN do deploy.env)." }
$db = Split-PgUrl (Read-EnvFile $P.BackendEnv)['DATABASE_URL']
if ($db.User -ne 'rsd_app') { throw "O backend.env usa o papel '$($db.User)', e não rsd_app." }

$sql = Join-Path ([IO.Path]::GetTempPath()) ("rsd-add-user-{0}.sql" -f [guid]::NewGuid())
[IO.File]::WriteAllText($sql, $sqlText, (New-Object Text.UTF8Encoding($false)))
$previousEncoding = [Console]::OutputEncoding
$env:PGPASSWORD = $db.Password
$env:PGCLIENTENCODING = 'UTF8'
try {
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) # o psql responde em UTF-8
  # Continue: no Windows PowerShell 5.1, com Stop, uma linha no stderr do psql viraria exceção
  # antes de o código de saída ser lido.
  $ErrorActionPreference = 'Continue'
  $out = & $psql -X -q -t -A --host $db.Host --port $db.Port --username $db.User --dbname $db.Database --no-password -f $sql 2>&1
  $code = $LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
  [Console]::OutputEncoding = $previousEncoding
  Remove-Item Env:\PGPASSWORD, Env:\PGCLIENTENCODING -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sql -Force -ErrorAction SilentlyContinue
}
$lines = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
if ($code -ne 0) { throw "psql falhou (código $code): $($lines -join ' | ')" }

$before = $lines | Where-Object { $_ -like 'ANTES|*' } | Select-Object -First 1
$after = $lines | Where-Object { $_ -like 'DEPOIS|*' } | Select-Object -First 1
if (-not $before -or -not $after) { throw "Resposta inesperada do psql: $($lines -join ' | ')" }
$row = $after.Split('|', 4) # DEPOIS | username | role | displayName (o nome pode ter "|")
$shown = "$($row[1]) ($($row[2]), '$($row[3])')"

if ($before -eq 'ANTES|0') {
  Write-Host "Criado: $shown." -ForegroundColor Green
} else {
  Write-Host "Já existia, não foi alterado: $shown."
  if ($row[2] -ne $Role -or $row[3] -cne $DisplayName) {
    Write-Host "   AVISO: o pedido era ($Role, '$DisplayName'). Para mudar, altere a linha no banco." -ForegroundColor Yellow
  }
}
