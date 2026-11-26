#Requires -RunAsAdministrator
<#
  Confere, DE VERDADE e como o papel rsd_app (o do backend), que ele lê e grava em todas as
  tabelas do banco: em cada tabela, SELECT, INSERT ... SELECT ... WHERE false, UPDATE ... WHERE
  false e DELETE ... WHERE false, dentro de uma transação desfeita no fim — nenhuma linha muda.
  Sequências: has_sequence_privilege (USAGE), sem chamar nextval (que mudaria o valor).

  Rodar na APP-RSD, como administrador, depois do primeiro deploy (e quando quiser conferir).
  O deploy.ps1 já confere as permissões em todo deploy (pelo catálogo, como rsd_owner); este
  script é a prova prática, com a credencial do backend.

  Uso:  .\deploy\check-db-grants.ps1
#>
[CmdletBinding()]
param([string]$Root = 'C:\rsd', [string]$PgBin)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'rsd-deploy-common.ps1')
$P = Get-RsdPaths -Root $Root
if (-not $PgBin) { $PgBin = (Read-EnvFile $P.DeployEnv)['PG_BIN'] }
$db = Split-PgUrl (Read-EnvFile $P.BackendEnv)['DATABASE_URL']
if ($db.User -ne 'rsd_app') { throw "O backend.env usa o papel '$($db.User)', e não rsd_app." }

$sql = Join-Path ([IO.Path]::GetTempPath()) ("rsd-check-{0}.sql" -f [guid]::NewGuid())
[IO.File]::WriteAllText($sql, (Get-AppWriteCheckSql))
$env:PGPASSWORD = $db.Password
try {
  $out = & (Join-Path $PgBin 'psql.exe') -X -q -t -A -v ON_ERROR_STOP=1 --host $db.Host --port $db.Port --username $db.User --dbname $db.Database --no-password -f $sql 2>&1
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $sql -Force -ErrorAction SilentlyContinue
}
$text = ($out | Out-String).Trim()
Write-Host $text
if ($code -ne 0 -or $text -notmatch '^OK ' -or $text -match 'FALTA') { Write-Host 'FALHOU: o rsd_app não lê ou não grava em alguma tabela (ver acima).' -ForegroundColor Red; exit 1 }
Write-Host 'OK: o rsd_app lê e grava em todas as tabelas.' -ForegroundColor Green
