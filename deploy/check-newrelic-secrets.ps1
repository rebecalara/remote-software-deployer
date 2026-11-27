#Requires -RunAsAdministrator
<#
  Prova, com o agente New Relic de verdade, que nenhum segredo do backend.env sai para o New Relic.

  Como usar (na APP-RSD, como administrador):
    1. No C:\rsd\config\backend.env, acrescente NEW_RELIC_LOG_LEVEL='trace' e rode
       Restart-Service rsd-backend. Com o log do agente em trace, ele grava cada envio ao New Relic
       ("Posting to ...", com o corpo) no log do serviço, em C:\rsd\logs (pelo WinSW).
       Por que trace, e não NEW_RELIC_AUDIT_LOG_ENABLED: no newrelic 14.12.0, lib/logger.js monta
       auditLogging a partir de audit_log.enabled, mas Logger.prototype.configure
       (lib/util/logger.js) só copia name, enabled e level — o audit log fica desligado e nada é
       gravado. O próprio agente trata trace como audit (loggingFunctions.audit usa trace quando
       traceEnabled()).
    2. Faça um login com senha errada (anote a senha de teste), um login certo, uma ação proibida
       para o perfil (403) e, se quiser, uma implantação de teste. Espere uns 2 minutos (o agente
       envia os dados em ciclos).
    3. Rode: .\deploy\check-newrelic-secrets.ps1
       O script lê os segredos do backend.env, procura cada um nos logs de C:\rsd\logs e mostra só
       o NOME de cada segredo, as contagens e as linhas — nunca o valor.
    4. Ele oferece apagar os logs do período e lembra de tirar o NEW_RELIC_LOG_LEVEL.

  Arquivos lidos: os que mudaram desde a subida do serviço e, SEMPRE, o rsd-backend.out.log e o
  rsd-backend.err.log — com o serviço segurando o arquivo aberto, o Windows não atualiza a data de
  modificação na listagem, e o arquivo principal ficava de fora.

  A chave do New Relic tem UMA ocorrência esperada: como valor de "license_key" no JSON de
  configuração que o agente manda ao coletor nos métodos connect e agent_settings (numa linha
  "Posting to"). Em qualquer outro lugar conta como vazamento. Os outros segredos — e a senha de
  teste do login — contam em qualquer lugar.

  Saída: 0 = nenhum vazamento, com envios conferidos; 1 = vazamento; 2 = INCONCLUSIVO (nenhum envio
  "Posting to" nos logs: o log não estava em trace ou o agente não enviou nada no período).
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
$traceOn = "$($envValues['NEW_RELIC_LOG_LEVEL'])".Trim().ToLowerInvariant() -eq 'trace'
if (-not $traceOn) { Write-Host "AVISO: NEW_RELIC_LOG_LEVEL não está 'trace' no backend.env: sem ele, o agente não grava os envios (no 14.12.0 o NEW_RELIC_AUDIT_LOG_ENABLED é ignorado)." -ForegroundColor Yellow }

$secrets = @(Get-BackendSecrets -EnvValues $envValues)
$testPassword = Read-Host -AsSecureString 'Senha de teste usada no login errado (Enter para pular)'
if ($testPassword.Length -gt 0) {
  $secrets += [pscustomobject]@{ Name = 'senha de teste do login'; Value = ([Net.NetworkCredential]::new('', $testPassword).Password) }
}
$testPassword.Dispose()
if ($secrets.Count -eq 0) { throw 'Nenhum segredo encontrado no backend.env para procurar.' }

$files = @(Get-NewRelicCheckFiles -LogDir $P.Logs -Since $Since -ServiceName $ServiceName)
if ($files.Count -eq 0) { throw "Nenhum log em $($P.Logs) (nem o $ServiceName.out.log)." }

$summary = @{}
foreach ($s in $secrets) { if (-not $summary.ContainsKey($s.Name)) { $summary[$s.Name] = [pscustomobject]@{ Expected = 0; Leaks = 0; Where = New-Object Collections.Generic.List[string] } } }
$posts = 0
Write-Host ''
Write-Host 'Arquivos lidos:'
foreach ($f in $files) {
  # FileShare.ReadWrite: o serviço continua escrevendo no log enquanto o script lê. O tamanho vem do
  # arquivo aberto, não da listagem (que pode estar desatualizada).
  $stream = [IO.File]::Open($f.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $bytes = $stream.Length
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
    $lines = $reader.ReadToEnd() -split "`r?`n"
  } finally { $stream.Dispose() }
  $postsHere = Measure-AgentPosts -Lines $lines
  $posts += $postsHere
  Write-Host ("  {0}: {1:N0} bytes, {2} envio(s) do agente" -f $f.Name, $bytes, $postsHere)
  foreach ($r in (Find-SecretOccurrences -Lines $lines -Secrets $secrets)) {
    $entry = $summary[$r.Name]
    $entry.Expected += $r.Expected
    $entry.Leaks += $r.Leaks
    if ($r.Leaks -gt 0) { $entry.Where.Add("$($f.Name): linhas $($r.LeakLines -join ', ')") }
  }
}
$secrets = $null

Write-Host ''
Write-Host "Envios do agente encontrados ('Posting to'): $posts"
$leakTotal = 0
foreach ($name in ($summary.Keys | Sort-Object)) {
  $e = $summary[$name]
  $leakTotal += $e.Leaks
  $expectedText = if ($name -eq 'NEW_RELIC_LICENSE_KEY') { "; esperadas (configuração do agente enviada ao coletor): $($e.Expected)" } else { '' }
  $color = if ($e.Leaks -gt 0) { 'Red' } else { 'Green' }
  Write-Host ("  {0}: vazamentos {1}{2}" -f $name, $e.Leaks, $expectedText) -ForegroundColor $color
  foreach ($w in $e.Where) { Write-Host "      $w" -ForegroundColor Red }
}
Write-Host ''
$exitCode = 0
if ($leakTotal -gt 0) {
  Write-Host "VAZAMENTO: $leakTotal ocorrência(s) fora do esperado (ver acima). Não compartilhe esses arquivos." -ForegroundColor Red
  $exitCode = 1
} elseif ($posts -eq 0) {
  Write-Host "INCONCLUSIVO: nenhum envio gravado ('Posting to'). Confira NEW_RELIC_LOG_LEVEL='trace' no backend.env, reinicie o serviço, gere tráfego, espere uns 2 minutos e rode de novo." -ForegroundColor Yellow
  $exitCode = 2
} else {
  Write-Host "OK: nenhum segredo fora do esperado em $posts envio(s) do agente." -ForegroundColor Green
}

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
Write-Host "LEMBRETE: volte o log do agente ao normal — tire NEW_RELIC_LOG_LEVEL do C:\rsd\config\backend.env e rode Restart-Service rsd-backend (em trace o log cresce muito e guarda o que é enviado)." -ForegroundColor Yellow
if ($exitCode -ne 0) { exit $exitCode }
