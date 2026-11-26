<#
  Deploy do RSD na APP-RSD, rodado pelo job "deploy" do GitHub Actions (runner self-hosted, conta
  local rsd-runner, sem administração). Não é rodado à mão: para voltar uma versão, rollback.ps1.

  1. Prepara a versão nova em C:\rsd\app\releases\<data>-<sha7>: copia o backend do checkout e o
     frontend já compilado no CI (artefato), e faz o build do backend AQUI (npm ci, prisma
     generate, nest build) — node_modules e o motor do Prisma são os do Windows.
  2. pg_dump do banco (papel rsd_owner) em C:\rsd\data\backups.
  3. prisma migrate deploy. Se falhar, para: a versão no ar não é trocada. Depois, confere as
     permissões do rsd_app e tira as dependências de desenvolvimento da versão nova
     (npm prune --omit=dev); qualquer falha também para antes da troca.
  4. Troca: para o serviço, aponta C:\rsd\app\current para a nova, inicia e confere
     http://127.0.0.1:3000/health. Se falhar, ROLLBACK automático para a anterior (o código; o banco
     não é desfeito — por isso as migrações só acrescentam, ver README).
  5. Confere o site pelo Caddy (só aviso).
  6. Guarda as últimas 5 versões e os últimos 10 dumps; registra em C:\rsd\app\deploys.jsonl.

  Nunca toca em C:\rsd\data\installers nem no Caddyfile (o Caddy é aplicado pelo provision-app.ps1).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceDir,
  [Parameter(Mandatory)][string]$FrontendDist,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Sha,
  [string]$Root = 'C:\rsd'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'rsd-deploy-common.ps1')

$P = Get-RsdPaths -Root $Root
$started = Get-Date
$lock = Enter-DeployLock -Paths $P
$transcript = Join-Path $P.Logs ('deploy-{0}-{1}.log' -f $started.ToString('yyyyMMdd-HHmmss'), $Sha.Substring(0, 7))
Start-Transcript -LiteralPath $transcript | Out-Null

$name = New-ReleaseName -Sha $Sha -When $started
$release = Join-Path $P.Releases $name
$dump = $null
$result = $null

function Invoke-Native {
  param([Parameter(Mandatory)][string]$What, [Parameter(Mandatory)][scriptblock]$Command)
  Write-RsdLog $What
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What falhou (código $LASTEXITCODE)." }
}

try {
  $cfg = Read-EnvFile $P.DeployEnv
  foreach ($k in @('DATABASE_URL', 'RSD_PUBLIC_HOST', 'PG_BIN')) {
    if (-not $cfg[$k]) { throw "$k ausente em $($P.DeployEnv) (rode o provision-app.ps1)." }
  }
  $previousOnline = Get-CurrentRelease $P
  Write-RsdLog "Deploy de $Sha ($name). No ar: $(if ($previousOnline) { $previousOnline } else { '(nenhuma)' })."

  # ------------------------------------------------------------------ 1. versão nova
  $backendDir = Join-Path $release 'backend'
  $null = New-Item -ItemType Directory -Path $backendDir -Force
  # Só o que o backend precisa para o build e para rodar (sem node_modules/dist do checkout).
  & robocopy.exe (Join-Path $SourceDir 'backend') $backendDir /E /XD node_modules dist coverage /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Cópia do backend falhou (robocopy $LASTEXITCODE)." }
  & robocopy.exe $FrontendDist (Join-Path $release 'frontend') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Cópia do frontend falhou (robocopy $LASTEXITCODE)." }

  Push-Location $backendDir
  try {
    Invoke-Native 'npm ci' { & npm.cmd ci --no-audit --no-fund }
    Invoke-Native 'prisma generate' { & node.exe node_modules\prisma\build\index.js generate }
    Invoke-Native 'nest build' { & npm.cmd run build }
  } finally { Pop-Location }

  foreach ($f in @('backend\dist\main.js', 'backend\scripts\deploy-target.ps1', 'frontend\index.html')) {
    if (-not (Test-Path -LiteralPath (Join-Path $release $f))) { throw "Versão incompleta: falta $f." }
  }
  $bom = [IO.File]::ReadAllBytes((Join-Path $backendDir 'scripts\deploy-target.ps1'))[0..2]
  if (($bom -join ',') -ne '239,187,191') { throw 'scripts\deploy-target.ps1 sem BOM (o PowerShell 5.1 leria os acentos errado).' }
  Write-RsdLog "Versão $name pronta."

  # ------------------------------------------------------------------ 2. backup
  $db = Split-PgUrl $cfg['DATABASE_URL']
  $dump = Join-Path $P.Backups ('rsd-antes-deploy-{0}-{1}.dump' -f $started.ToString('yyyyMMdd-HHmmss'), $Sha.Substring(0, 7))
  $env:PGPASSWORD = $db.Password
  try {
    Invoke-Native "pg_dump para $dump" {
      & (Join-Path $cfg['PG_BIN'] 'pg_dump.exe') --format=custom --file $dump --host $db.Host --port $db.Port --username $db.User --dbname $db.Database --no-password
    }
  } finally { Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue }
  if ((Get-Item -LiteralPath $dump).Length -le 0) { throw "Backup vazio: $dump." }

  # ------------------------------------------------------------------ 3. migrações
  Push-Location $backendDir
  $env:DATABASE_URL = $cfg['DATABASE_URL']
  try {
    Invoke-Native 'prisma migrate deploy' { & node.exe node_modules\prisma\build\index.js migrate deploy }
  } catch {
    throw "Migração falhou: a versão no ar NÃO foi trocada. Backup de antes: $dump (pg_restore, ver README). Detalhe: $($_.Exception.Message)"
  } finally {
    Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
    Pop-Location
  }

  # ------------------------------------------------------------------ 3b. permissões do rsd_app
  # Tabelas e sequências criadas pelas migrações herdam as permissões padrão (provision); se
  # faltar alguma, o backend quebraria em produção — para aqui, sem trocar a versão.
  $grantSql = Join-Path ([IO.Path]::GetTempPath()) ("rsd-grants-{0}.sql" -f [guid]::NewGuid())
  [IO.File]::WriteAllText($grantSql, (Get-AppGrantProblemsSql))
  $env:PGPASSWORD = $db.Password
  try {
    $problems = & (Join-Path $cfg['PG_BIN'] 'psql.exe') -X -q -t -A -v ON_ERROR_STOP=1 --host $db.Host --port $db.Port --username $db.User --dbname $db.Database --no-password -f $grantSql
    if ($LASTEXITCODE -ne 0) { throw "Conferência das permissões do rsd_app falhou (psql $LASTEXITCODE)." }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $grantSql -Force -ErrorAction SilentlyContinue
  }
  $problems = (($problems | Out-String).Trim())
  if ($problems) { throw "O papel rsd_app não tem permissão em: $problems. A versão no ar NÃO foi trocada; rode o provision-app.ps1 (permissões padrão) e repita o deploy." }
  Write-RsdLog 'Permissões do rsd_app conferidas em todas as tabelas e sequências.'

  # ------------------------------------------------------------------ 3c. só dependências de produção
  # O npm ci do passo 1 instalou também as de desenvolvimento (nest build, jest, ts-jest...), que
  # o build e o prisma generate precisam. Na versão que vai ao ar ficam só as de produção: as de
  # desenvolvimento apareceriam como vulnerabilidades do app no New Relic (handlebars, picomatch)
  # sem nunca rodar. Depois das migrações, porque o CLI do prisma é usado nelas. Se falhar, para
  # sem trocar a versão no ar.
  Push-Location $backendDir
  try {
    Invoke-Native 'npm prune --omit=dev' { & npm.cmd prune --omit=dev --no-audit --no-fund }
    foreach ($need in @('node_modules\@prisma\client', 'node_modules\.prisma\client\index.js', 'node_modules\@nestjs\core', 'node_modules\newrelic')) {
      if (-not (Test-Path -LiteralPath $need)) { throw "falta $need depois do prune." }
    }
    foreach ($dev in @('node_modules\jest', 'node_modules\ts-jest', 'node_modules\@nestjs\cli', 'node_modules\typescript')) {
      if (Test-Path -LiteralPath $dev) { throw "$dev continua lá depois do prune." }
    }
  } catch {
    throw "Limpeza das dependências de desenvolvimento falhou: a versão no ar NÃO foi trocada. Detalhe: $($_.Exception.Message)"
  } finally { Pop-Location }
  Write-RsdLog 'Dependências de desenvolvimento removidas da versão nova (npm prune --omit=dev).'

  # ------------------------------------------------------------------ 4. troca + health check
  $result = Invoke-ReleaseSwitch -Paths $P -NewRelease $name `
    -Stop { Stop-RsdService } -Start { Start-Service -Name $script:RsdServiceName } -Health { Test-BackendHealth }
  Write-RsdLog $result.Message $(if ($result.Ok) { 'INFO' } else { 'ERROR' })

  # ------------------------------------------------------------------ 5. site pelo Caddy (aviso)
  $site = if ($result.Ok) { Test-PublicSite -PublicHost $cfg['RSD_PUBLIC_HOST'] } else { '—' }

  # ------------------------------------------------------------------ 6. retenção e registro
  Remove-OldReleases -Paths $P -Current $result.Release -Previous $result.Previous
  Remove-OldBackups -Paths $P
  Add-DeployHistory -Paths $P -Entry @{ sha = $Sha; release = $name; ok = $result.Ok; online = $result.Release; previous = $result.Previous; rolledBack = $result.RolledBack; backup = $dump; message = $result.Message }
  $elapsed = [int]((Get-Date) - $started).TotalSeconds
  Add-JobSummary @"
### Deploy $(if ($result.Ok) { 'concluído' } elseif ($result.RolledBack) { 'falhou — rollback automático' } else { 'falhou' })
| | |
|---|---|
| Commit | ``$Sha`` |
| Versão nova | ``$name`` |
| No ar agora | ``$($result.Release)`` |
| Anterior | ``$(if ($result.Previous) { $result.Previous } else { '—' })`` |
| Backup antes da migração | ``$dump`` |
| Site pelo Caddy | $site |
| Tempo | $elapsed s |

$($result.Message)
"@
  if (-not $result.Ok) { exit 1 }
} catch {
  $msg = $_.Exception.Message
  Write-RsdLog $msg 'ERROR'
  try { Add-DeployHistory -Paths $P -Entry @{ sha = $Sha; release = $name; ok = $false; online = (Get-CurrentRelease $P); backup = $dump; message = $msg } } catch { }
  Add-JobSummary "### Deploy falhou`n`n$msg`n`nNo ar: ``$(try { Get-CurrentRelease $P } catch { '?' })``"
  exit 1
} finally {
  Stop-Transcript | Out-Null
  $lock.Dispose()
}
