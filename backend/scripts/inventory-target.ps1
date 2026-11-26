#Requires -Version 5.1
<#
  inventory-target.ps1 - LE o software instalado em UMA maquina (RF08). SO LEITURA.

  Chamado somente pelo PowerShellExecutor do backend (ver DECISIONS.md, RF08). Script
  FIXO e versionado. Na maquina de destino: abre uma sessao WinRM e le as chaves
  Uninstall do registro (64 e 32 bits) com Get-ItemProperty. Nada e copiado, nenhuma
  pasta e criada, o C$ nao e usado e nenhum processo e iniciado. Nunca Win32_Product
  (consultar essa classe faz o Windows Installer verificar e reparar cada MSI) e nunca
  Get-Package (a PoC mostrou que sozinho e insuficiente, e pode tentar baixar provedor).
  Le tambem o QuietUninstallString e o InstallLocation (desinstalacao de programa que
  nao e MSI, excecao controlada - DECISIONS.md). O UninstallString (sem "Quiet") NUNCA
  e lido: so o comando silencioso que o proprio programa declarou pode ser usado.

  Entrada: UM objeto JSON pela entrada padrao (nunca pela linha de comando):
    { computerName, connectTimeoutSeconds, readTimeoutSeconds, credential? }
  Saida: eventos JSON, um por linha, so com caracteres ASCII:
    {"type":"log","level":"INFO","phase":"connect","message":"..."}
    {"type":"result","ok":true,"items":[{"name":"...","version":"...","publisher":"...",
      "installDate":"2026-11-19","productCode":"{...}","arch":"64"}]}
    {"type":"result","ok":false,"phase":"connect","reason":"unreachable","message":"..."}

  O bloco de conexao (nome, porta 5985, sessao) e as funcoes auxiliares foram COPIADOS
  do deploy-target.ps1 (decisao da autora: nao mexer no script de implantacao). Um teste
  do backend confere que as mensagens de erro continuam iguais nos dois.

  Salvo em UTF-8 COM BOM, como o deploy-target.ps1 (um teste do backend confere).
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

class DeployFailure : System.Exception {
  [string] $Phase
  [string] $Reason
  DeployFailure([string] $phase, [string] $reason, [string] $message) : base($message) {
    $this.Phase = $phase
    $this.Reason = $reason
  }
}

function Write-Event([hashtable] $Event) {
  $json = ConvertTo-Json -InputObject $Event -Compress -Depth 3
  # So ASCII no stdout: a codificacao do console varia (cp850 no Windows pt-BR).
  # Todo caractere fora do ASCII vira \uXXXX, que o JSON.parse do Node entende.
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Write-Log([string] $Level, [string] $Phase, [string] $Message) {
  Write-Event @{ type = 'log'; level = $Level; phase = $Phase; message = $Message }
}

function Get-InnermostMessage($ErrorRecord) {
  $ex = $ErrorRecord.Exception
  while ($ex.InnerException) { $ex = $ex.InnerException }
  return $ex.Message.Trim()
}

# Testa a porta antes do WinRM, para separar "nao responde" de "recusou".
# Retorna 'open', 'refused', 'timeout' ou 'error: <mensagem>'.
function Test-TcpPort([string] $Computer, [int] $Port, [int] $TimeoutMs) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync($Computer, $Port)
    if (-not $task.Wait($TimeoutMs)) { return 'timeout' }
    return 'open'
  } catch {
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    if ($ex -is [System.Net.Sockets.SocketException] -and
        $ex.SocketErrorCode -eq [System.Net.Sockets.SocketError]::ConnectionRefused) {
      return 'refused'
    }
    return "error: $($ex.Message)"
  } finally {
    $client.Dispose()
  }
}

function Assert-Input($In) {
  $fail = { param($msg) throw [DeployFailure]::new('validate', 'invalid-input', $msg) }
  foreach ($field in 'computerName', 'connectTimeoutSeconds', 'readTimeoutSeconds') {
    if ($null -eq $In.PSObject.Properties[$field] -or $null -eq $In.$field) {
      & $fail "Campo obrigatório ausente: $field."
    }
  }
  # Mesma regra do deploy-target.ps1: nome curto, FQDN ou IPv4, sem barra, espaço ou aspas.
  if ($In.computerName -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9-]{1,63})*$') {
    & $fail 'Nome de máquina inválido.'
  }
  foreach ($field in 'connectTimeoutSeconds', 'readTimeoutSeconds') {
    $v = $In.$field
    if ($v -isnot [int] -or $v -lt 1 -or $v -gt 600) { & $fail "Tempo limite inválido: $field." }
  }
  foreach ($field in 'installerPath', 'sha256', 'installArgs', 'productCode', 'action') {
    if ($null -ne $In.PSObject.Properties[$field]) { & $fail "Campo não aceito na consulta: $field." }
  }
}

$phase = 'validate'
$final = $null
$session = $null

try {
  # --- Entrada -------------------------------------------------------------------
  $raw = [Console]::In.ReadToEnd()
  try {
    $in = ConvertFrom-Json -InputObject $raw
  } catch {
    throw [DeployFailure]::new('validate', 'invalid-input', 'Entrada JSON inválida.')
  }
  $raw = $null
  if ($null -eq $in) { throw [DeployFailure]::new('validate', 'invalid-input', 'Entrada vazia.') }
  Assert-Input $in

  $computer = $in.computerName
  $connectMs = $in.connectTimeoutSeconds * 1000
  $readMs = $in.readTimeoutSeconds * 1000

  $credential = $null
  if ($null -ne $in.PSObject.Properties['credential'] -and $null -ne $in.credential) {
    $secure = ConvertTo-SecureString -String $in.credential.password -AsPlainText -Force
    $credential = New-Object System.Management.Automation.PSCredential($in.credential.username, $secure)
    $in.credential.password = $null
    $secure = $null
  }

  # --- Nome --------------------------------------------------------------------
  $phase = 'resolve'
  try {
    $null = [System.Net.Dns]::GetHostAddresses($computer)
  } catch {
    throw [DeployFailure]::new('resolve', 'dns', "O nome $computer não foi encontrado no DNS.")
  }

  # --- Conexão WinRM -----------------------------------------------------------
  $phase = 'connect'
  Write-Log 'INFO' 'connect' "Conectando a $computer pelo WinRM (porta 5985)."
  $port = Test-TcpPort $computer 5985 $connectMs
  if ($port -eq 'timeout') {
    throw [DeployFailure]::new('connect', 'unreachable',
      "$computer não respondeu na porta 5985 em $($in.connectTimeoutSeconds) s (desligada, fora da rede ou firewall bloqueando).")
  }
  if ($port -eq 'refused') {
    throw [DeployFailure]::new('connect', 'winrm-refused',
      "$computer recusou a conexão na porta 5985: o serviço WinRM não está ativo ou não aceita conexões remotas.")
  }
  if ($port -ne 'open') {
    throw [DeployFailure]::new('connect', 'unreachable', "Não foi possível conectar a $computer (porta 5985): $($port.Substring(7))")
  }

  # Única adaptação do bloco copiado: o OperationTimeout é o tempo limite da LEITURA.
  $sessionOption = New-PSSessionOption -OpenTimeout $connectMs -OperationTimeout $readMs -CancelTimeout 10000
  $sessionParams = @{ ComputerName = $computer; SessionOption = $sessionOption }
  if ($credential) { $sessionParams.Credential = $credential }
  try {
    $session = New-PSSession @sessionParams
  } catch {
    $msg = Get-InnermostMessage $_
    if ($_.FullyQualifiedErrorId -like 'AccessDenied*') {
      throw [DeployFailure]::new('connect', 'access-denied',
        "Acesso negado em ${computer}: a credencial foi recusada ou não é administradora da máquina.")
    }
    if ($msg -match 'TrustedHosts') {
      throw [DeployFailure]::new('connect', 'not-trusted',
        "O servidor do sistema não confia em $computer para autenticação NTLM (lista TrustedHosts do servidor).")
    }
    throw [DeployFailure]::new('connect', 'session', "Falha ao abrir a sessão WinRM com ${computer}: $msg")
  }
  Write-Log 'INFO' 'connect' "Sessão WinRM aberta com $computer."

  # --- Leitura do registro (SÓ LEITURA) ---------------------------------------------
  # Chaves Uninstall de 64 e 32 bits, com Get-ChildItem/Get-ItemProperty. Ficam de fora,
  # para a lista bater com "Aplicativos instalados" do Windows: itens sem nome,
  # componentes de sistema (SystemComponent = 1) e atualizações (ParentKeyName ou
  # ReleaseType de atualização). Num MSI (WindowsInstaller = 1), o nome da subchave é o
  # ProductCode. Programas instalados só para um usuário (HKCU) não aparecem: a sessão
  # roda com a conta de serviço.
  $phase = 'read'
  Write-Log 'INFO' 'read' "Lendo o software instalado em $computer."
  $started = [Diagnostics.Stopwatch]::StartNew()
  try {
    $rawItems = Invoke-Command -Session $session -ScriptBlock {
      $views = @(
        @{ Path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; Arch = '64' },
        @{ Path = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'; Arch = '32' }
      )
      $out = New-Object System.Collections.ArrayList
      foreach ($view in $views) {
        if (-not (Test-Path -LiteralPath $view.Path)) { continue }
        foreach ($key in @(Get-ChildItem -LiteralPath $view.Path -ErrorAction SilentlyContinue)) {
          $p = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
          if ($null -eq $p) { continue }
          $values = @{}
          foreach ($n in 'DisplayName', 'DisplayVersion', 'Publisher', 'InstallDate', 'SystemComponent',
                         'ParentKeyName', 'ReleaseType', 'WindowsInstaller', 'QuietUninstallString',
                         'InstallLocation') {
            $prop = $p.PSObject.Properties[$n]
            $values[$n] = if ($prop) { $prop.Value } else { $null }
          }
          $name = [string] $values['DisplayName']
          if ($name.Trim() -eq '') { continue }
          if ("$($values['SystemComponent'])" -eq '1') { continue }
          if ("$($values['ParentKeyName'])" -ne '') { continue }
          if ("$($values['ReleaseType'])" -match 'Update|Hotfix') { continue }
          $isMsi = "$($values['WindowsInstaller'])" -eq '1' -and
                   $key.PSChildName -match '^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$'
          [void] $out.Add(@{
            name = $name.Trim()
            version = [string] $values['DisplayVersion']
            publisher = [string] $values['Publisher']
            installDate = [string] $values['InstallDate']
            productCode = if ($isMsi) { $key.PSChildName.ToUpperInvariant() } else { '' }
            arch = $view.Arch
            uninstallKey = $key.PSChildName
            quietUninstallString = [string] $values['QuietUninstallString']
            installLocation = [string] $values['InstallLocation']
          })
        }
      }
      , $out.ToArray()
    }
  } catch {
    if ($started.ElapsedMilliseconds -ge ($readMs - 1000)) {
      throw [DeployFailure]::new('read', 'timeout',
        "Tempo esgotado ($($in.readTimeoutSeconds) s) ao ler o software instalado em $computer.")
    }
    throw [DeployFailure]::new('read', 'read-failed', "Falha ao ler o registro de ${computer}: $(Get-InnermostMessage $_)")
  }

  # aaaammdd → aaaa-mm-dd; o resto (vazio ou outro formato) fica sem data.
  $items = @(foreach ($i in @($rawItems)) {
    $date = [string] $i['installDate']
    @{
      name = [string] $i['name']
      version = [string] $i['version']
      publisher = [string] $i['publisher']
      installDate = if ($date -match '^(\d{4})(\d{2})(\d{2})$') { "$($Matches[1])-$($Matches[2])-$($Matches[3])" } else { '' }
      productCode = [string] $i['productCode']
      arch = [string] $i['arch']
      uninstallKey = [string] $i['uninstallKey']
      quietUninstallString = [string] $i['quietUninstallString']
      installLocation = [string] $i['installLocation']
    }
  })
  Write-Log 'INFO' 'read' "Leitura concluída: $($items.Count) itens."
  $final = @{ type = 'result'; ok = $true; items = $items }
} catch [DeployFailure] {
  $final = @{ type = 'result'; ok = $false; phase = $_.Exception.Phase; reason = $_.Exception.Reason; message = $_.Exception.Message }
} catch {
  $final = @{ type = 'result'; ok = $false; phase = $phase; reason = 'unexpected'; message = (Get-InnermostMessage $_) }
} finally {
  if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}

Write-Event $final
exit 0
