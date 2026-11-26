#Requires -RunAsAdministrator
<#
  Prova, com o agente New Relic de verdade, que nenhum segredo do backend.env sai para o New Relic.

  Como usar (na APP-RSD, como administrador):
    1. No C:\rsd\config\backend.env, acrescente NEW_RELIC_AUDIT_LOG_ENABLED='true' e rode
       Restart-Service rsd-backend. Com isso, o agente escreve no log TUDO o que envia ao New Relic
       (o log do agente vai para C:\rsd\logs, pelo WinSW).
    2. Faça um login com senha errada (anote a senha de teste), um login certo, uma ação proibida
       para o perfil (403) e, se quiser, uma implantação de teste. Espere uns 2 minutos (o agente
       envia os dados em ciclos).
    3. Rode: .\deploy\check-newrelic-secrets.ps1
       O script lê os segredos do backend.env, procura cada um nos logs de C:\rsd\logs desde que o
       serviço subiu e mostra só o NOME de cada segredo, as contagens e as linhas — nunca o valor.
    4. Ele oferece apagar os logs do período e lembra de desligar o audit log.

  A chave do New Relic tem ocorrências esperadas: o agente a envia ao coletor (license_key= na URL,
  cabeçalho X-License-Key), e o audit log registra esse transporte. Só conta como vazamento se ela
  aparecer fora disso (por exemplo, dentro de um log ou evento enviado). Os outros segredos — e a
  senha de teste do login — contam em qualquer lugar.

  Saída: código 0 sem vazamento; 1 com vazamento.
#>
[CmdletBinding()]
param(
  [string]$Root = 'C:\rsd',
  # Início do período. Padrão: quando o serviço rsd-backend subiu.
  [datetime]$Since,
  [string]$ServiceName = 'rsd-backend'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'rsd-deploy-common.ps1')
$P = Get-RsdPaths -Root $Root

if (-not $PSBoundParameters.ContainsKey('Since')) {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if (-not $svc -or -not $svc.ProcessId) { throw "Serviço $ServiceName não está rodando: informe -Since (ex.: -Since (Get-Date).AddHours(-1))." }
  $Since = (Get-Process -Id $svc.ProcessId).StartTime
}
Write-Host "Período: desde $($Since.ToString('dd/MM/yyyy HH:mm:ss')) (subida do serviço ou -Since)."

$envValues = Read-EnvFile $P.BackendEnv
$auditOn = "$($envValues['NEW_RELIC_AUDIT_LOG_ENABLED'])".Trim().ToLowerInvariant() -eq 'true'
if (-not $auditOn) { Write-Host 'AVISO: NEW_RELIC_AUDIT_LOG_ENABLED não está "true" no backend.env: sem o audit log, o log não mostra o que o agente envia.' -ForegroundColor Yellow }

$secrets = @(Get-BackendSecrets -EnvValues $envValues)
$testPassword = Read-Host -AsSecureString 'Senha de teste usada no login errado (Enter para pular)'
if ($testPassword.Length -gt 0) {
  $secrets += [pscustomobject]@{ Name = 'senha de teste do login'; Value = ([Net.NetworkCredential]::new('', $testPassword).Password) }
}
$testPassword.Dispose()
if ($secrets.Count -eq 0) { throw 'Nenhum segredo encontrado no backend.env para procurar.' }

$files = @(Get-ChildItem -LiteralPath $P.Logs -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -ge $Since } | Sort-Object FullName)
if ($files.Count -eq 0) { throw "Nenhum log em $($P.Logs) alterado desde $Since." }

$summary = @{}
foreach ($s in $secrets) { if (-not $summary.ContainsKey($s.Name)) { $summary[$s.Name] = [pscustomobject]@{ Expected = 0; Leaks = 0; Where = New-Object Collections.Generic.List[string] } } }
foreach ($f in $files) {
  # FileShare.ReadWrite: o serviço continua escrevendo no log enquanto o script lê.
  $stream = [IO.File]::Open($f.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try { $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8); $lines = $reader.ReadToEnd() -split "`r?`n" } finally { $stream.Dispose() }
  foreach ($r in (Find-SecretOccurrences -Lines $lines -Secrets $secrets)) {
    $entry = $summary[$r.Name]
    $entry.Expected += $r.Expected
    $entry.Leaks += $r.Leaks
    if ($r.Leaks -gt 0) { $entry.Where.Add("$($f.Name): linhas $($r.LeakLines -join ', ')") }
  }
}
$secrets = $null

Write-Host ''
Write-Host "Arquivos conferidos: $($files.Count)"
$leakTotal = 0
foreach ($name in ($summary.Keys | Sort-Object)) {
  $e = $summary[$name]
  $leakTotal += $e.Leaks
  $expectedText = if ($name -eq 'NEW_RELIC_LICENSE_KEY') { "; esperadas (transporte ao coletor): $($e.Expected)" } else { '' }
  $color = if ($e.Leaks -gt 0) { 'Red' } else { 'Green' }
  Write-Host ("  {0}: vazamentos {1}{2}" -f $name, $e.Leaks, $expectedText) -ForegroundColor $color
  foreach ($w in $e.Where) { Write-Host "      $w" -ForegroundColor Red }
}
Write-Host ''
if ($leakTotal -gt 0) { Write-Host "VAZAMENTO: $leakTotal ocorrência(s) fora do esperado (ver acima). Não compartilhe esses arquivos." -ForegroundColor Red }
else { Write-Host 'OK: nenhum segredo fora do esperado nos logs do período.' -ForegroundColor Green }

# Os logs do período podem conter o que o agente enviou (e, se houve vazamento, o segredo).
Write-Host ''
Write-Host "Logs do período ($($files.Count)):"
$files | ForEach-Object { Write-Host "  $($_.FullName)" }
$answer = Read-Host 'Apagar esses arquivos agora? Digite SIM para apagar (o arquivo em uso pelo serviço só sai com ele parado)'
if ($answer -ceq 'SIM') {
  foreach ($f in $files) {
    try { Remove-Item -LiteralPath $f.FullName -Force; Write-Host "  apagado: $($f.Name)" }
    catch { Write-Host "  em uso, não apagado: $($f.Name) (pare o serviço e apague à mão)" -ForegroundColor Yellow }
  }
} else {
  Write-Host 'Nada apagado.'
}

Write-Host ''
Write-Host 'LEMBRETE: desligue o audit log — tire NEW_RELIC_AUDIT_LOG_ENABLED do C:\rsd\config\backend.env e rode Restart-Service rsd-backend.' -ForegroundColor Yellow
if ($leakTotal -gt 0) { exit 1 }
