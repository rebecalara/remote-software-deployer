<#
  Volta o RSD para uma versão que ainda está em C:\rsd\app\releases (sem build e sem migração):
  para o serviço, aponta C:\rsd\app\current para ela, inicia e confere o /health. Se a saúde
  falhar, volta para a que estava no ar.

  O BANCO NÃO É DESFEITO. Se a versão de destino não funcionar com o schema atual (migração que
  apagou ou renomeou algo), restaure o dump de antes do deploy (README, "Deploy em produção").

  Uso (na APP-RSD, como administrador ou como rsd-runner):
    .\deploy\rollback.ps1                 # versão anterior à que está no ar
    .\deploy\rollback.ps1 -To 1a2b3c4     # por SHA (7+ caracteres) ou nome da pasta
    .\deploy\rollback.ps1 -List           # só lista as versões
#>
[CmdletBinding()]
param(
  [string]$To,
  [switch]$List,
  [string]$Root = 'C:\rsd'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'rsd-deploy-common.ps1')
$P = Get-RsdPaths -Root $Root

$current = Get-CurrentRelease $P
if ($List) {
  foreach ($r in (Get-Releases $P)) { Write-Host ('{0} {1}' -f $(if ($r -eq $current) { '*' } else { ' ' }), $r) }
  return
}

$target = if ($To) { Resolve-Release -Paths $P -NameOrSha $To } else { Get-PreviousRelease -Paths $P -Current $current }
if (-not $target) { throw 'Não há versão anterior em C:\rsd\app\releases.' }
if ($target -eq $current) { Write-Host "$target já está no ar."; return }

$lock = Enter-DeployLock -Paths $P
try {
  $result = Invoke-ReleaseSwitch -Paths $P -NewRelease $target `
    -Stop { Stop-RsdService } -Start { Start-Service -Name $script:RsdServiceName } -Health { Test-BackendHealth }
  Add-DeployHistory -Paths $P -Entry @{ kind = 'rollback'; release = $target; ok = $result.Ok; online = $result.Release; previous = $result.Previous; rolledBack = $result.RolledBack; message = $result.Message }
  Write-RsdLog $result.Message $(if ($result.Ok) { 'INFO' } else { 'ERROR' })
  if (-not $result.Ok) { exit 1 }
} finally {
  $lock.Dispose()
}
