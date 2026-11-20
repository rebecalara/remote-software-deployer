#Requires -Version 5.1
<#
  uninstall-program-target.ps1 - desinstala UM programa que NAO e MSI em UMA maquina,
  pelo comando silencioso que o PROPRIO programa declarou (QuietUninstallString).

  EXCECAO CONTROLADA a regra "nunca executar comando que nao seja do sistema" (decisao da
  autora, DECISIONS.md). Chamado somente pelo PowerShellExecutor do backend. Script FIXO e
  versionado; o deploy-target.ps1 nao muda. O UninstallString (sem "Quiet") nunca e usado.

  Na maquina de destino, nesta ordem (nada e copiado):
    1. rele a chave Uninstall (64 ou 32 bits): sumiu -> "nao estava instalado";
       o QuietUninstallString precisa ser IDENTICO ao do inventario, senao nada e executado;
    2. valida o comando (uninstall-command-rules.ps1, mesmas regras e casos do servidor)
       com as pastas Program Files reais da maquina;
    3. o executavel precisa existir, sem juncao/link no caminho; a assinatura digital e
       registrada no log, sem bloquear;
    4. executa com Start-Process -FilePath <exe> -ArgumentList <argumentos> (sem cmd, sem
       comando montado como texto), com tempo limite e encerramento da arvore;
    5. sucesso = a chave saiu do registro (espera ate removalWaitSeconds: desinstaladores
       NSIS/Inno se copiam para a pasta temporaria e o processo original termina logo).

  Entrada: UM objeto JSON pela entrada padrao:
    { targetId, computerName, arch, uninstallKey, command, connectTimeoutSeconds,
      installTimeoutSeconds, removalWaitSeconds, credential? }
  Saida: eventos JSON, um por linha, so ASCII:
    {"type":"log","level":"INFO","phase":"check","message":"..."}
    {"type":"result","ok":true,"removed":true,"exitCode":0}
    {"type":"result","ok":true,"notInstalled":true}
    {"type":"result","ok":false,"phase":"check","reason":"command-changed","message":"..."}

  O bloco de conexao e as funcoes auxiliares foram COPIADOS do deploy-target.ps1 (um teste
  do backend confere que as mensagens de erro continuam iguais). Salvo em UTF-8 COM BOM.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

. (Join-Path $PSScriptRoot 'uninstall-command-rules.ps1')

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
  $has = { param($field) $null -ne $In.PSObject.Properties[$field] -and $null -ne $In.$field }
  foreach ($field in 'targetId', 'computerName', 'arch', 'uninstallKey', 'command',
                     'connectTimeoutSeconds', 'installTimeoutSeconds', 'removalWaitSeconds') {
    if (-not (& $has $field)) { & $fail "Campo obrigatório ausente: $field." }
  }
  if ($In.targetId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
    & $fail 'Identificador do alvo inválido.'
  }
  if ($In.computerName -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9-]{1,63})*$') {
    & $fail 'Nome de máquina inválido.'
  }
  if ($In.arch -cne '64' -and $In.arch -cne '32') { & $fail 'Visão do registro inválida.' }
  if ($In.uninstallKey -isnot [string] -or $In.uninstallKey.Length -lt 1 -or $In.uninstallKey.Length -gt 255 -or
      $In.uninstallKey -match '[\\\x00-\x1f\x7f]' -or $In.uninstallKey -match '[*?\[\]]') {
    & $fail 'Subchave do registro inválida.'
  }
  if ($In.command -isnot [string] -or $In.command.Trim() -eq '' -or $In.command.Length -gt 1024) {
    & $fail 'Comando inválido.'
  }
  foreach ($field in 'connectTimeoutSeconds', 'installTimeoutSeconds', 'removalWaitSeconds') {
    $v = $In.$field
    if ($v -isnot [int] -or $v -lt 1 -or $v -gt 86400) { & $fail "Tempo limite inválido: $field." }
  }
  foreach ($field in 'installerPath', 'sha256', 'installArgs', 'productCode', 'action') {
    if ($null -ne $In.PSObject.Properties[$field]) { & $fail "Campo não aceito nesta desinstalação: $field." }
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
  $installMs = $in.installTimeoutSeconds * 1000
  $waitSeconds = $in.removalWaitSeconds

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

  # OperationTimeout acima do tempo de instalação: a chamada que espera o instalador
  # não pode ser cortada pelo WinRM antes do nosso próprio limite.
  $sessionOption = New-PSSessionOption -OpenTimeout $connectMs -OperationTimeout ($installMs + 300000) -CancelTimeout 10000
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

  # --- 1. Relê a chave e confere o comando -------------------------------------------
  $phase = 'check'
  $state = Invoke-Command -Session $session -ArgumentList $in.arch, $in.uninstallKey -ScriptBlock {
    param($Arch, $Key)
    $base = if ($Arch -eq '32') { 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' }
            else { 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' }
    $path = "$base\$Key"
    $exists = Test-Path -LiteralPath $path
    $quiet = $null
    if ($exists) {
      $p = Get-ItemProperty -LiteralPath $path
      $prop = $p.PSObject.Properties['QuietUninstallString']
      if ($prop) { $quiet = [string] $prop.Value }
    }
    @{ exists = $exists; quiet = $quiet; pf = $env:ProgramFiles; pf86 = ${env:ProgramFiles(x86)} }
  }
  if (-not $state.exists) {
    $final = @{ type = 'result'; ok = $true; notInstalled = $true }
  } else {
    if ($state.quiet -cne $in.command) {
      throw [DeployFailure]::new('check', 'command-changed',
        "O comando de desinstalação registrado em $computer mudou desde a consulta do software instalado. Nada foi executado; consulte o software instalado de novo.")
    }
    Write-Log 'INFO' 'check' "Comando de desinstalação conferido no registro de $computer."

    # --- 2. Regras do comando, com as pastas Program Files reais da máquina ----------
    $rule = Test-UninstallCommand $in.command @($state.pf, $state.pf86)
    if (-not $rule.ok) {
      throw [DeployFailure]::new('check', 'command-rejected', "Comando recusado: $($rule.reason) Nada foi executado.")
    }

    # --- 3. O executável: existe, sem junção/link no caminho; assinatura no log ------
    $phase = 'verify'
    $exe = $rule.executable
    $check = Invoke-Command -Session $session -ArgumentList $exe -ScriptBlock {
      param($Exe)
      $r = @{ exists = (Test-Path -LiteralPath $Exe -PathType Leaf); reparse = $null; status = $null; signer = $null }
      if (-not $r.exists) { return $r }
      $p = $Exe
      while ($p) {
        $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { $r.reparse = $p; break }
        $parent = Split-Path -Path $p -Parent
        if (-not $parent -or $parent -eq $p) { break }
        $p = $parent
      }
      $sig = Get-AuthenticodeSignature -LiteralPath $Exe
      $r.status = [string] $sig.Status
      $r.signer = if ($sig.SignerCertificate) { [string] $sig.SignerCertificate.Subject } else { $null }
      return $r
    }
    if (-not $check.exists) {
      throw [DeployFailure]::new('verify', 'executable-missing', "O desinstalador não existe em ${computer}: $exe. Nada foi executado.")
    }
    if ($check.reparse) {
      throw [DeployFailure]::new('verify', 'reparse-point',
        "O caminho do desinstalador passa por uma junção ou link ($($check.reparse)) em $computer. Nada foi executado.")
    }
    if ($check.status -eq 'Valid') {
      Write-Log 'INFO' 'verify' "Assinatura do executável: válida ($($check.signer))."
    } else {
      Write-Log 'WARN' 'verify' "Assinatura do executável: $($check.status)$(if ($check.signer) { " ($($check.signer))" }). Executado assim mesmo (decisão: registrar sem bloquear)."
    }

    # --- 4. Executa o desinstalador do fabricante ------------------------------------
    $phase = 'uninstall'
    Write-Log 'INFO' 'uninstall' "Executando o desinstalador do fabricante em $computer."
    $outcome = Invoke-Command -Session $session -ArgumentList $exe, $rule.arguments, $installMs -ScriptBlock {
      param($Exe, $Arguments, $TimeoutMs)
      $ErrorActionPreference = 'Stop'
      # Argumentos como UM texto no -ArgumentList: chegam ao executável como o fabricante
      # os escreveu, sem passar por cmd e sem virar comando montado.
      $params = @{ FilePath = $Exe; PassThru = $true }
      if ($Arguments) { $params.ArgumentList = $Arguments }
      $process = Start-Process @params
      $null = $process.Handle
      if ($process.WaitForExit($TimeoutMs)) { return @{ timedOut = $false; exitCode = $process.ExitCode } }
      $null = & taskkill.exe /PID $process.Id /T /F 2>&1
      return @{ timedOut = $true; exitCode = $null }
    }
    if ($outcome.timedOut) {
      throw [DeployFailure]::new('uninstall', 'uninstall-timeout',
        "Tempo esgotado ($($in.installTimeoutSeconds) s): o desinstalador foi encerrado. Ele pode estar esperando uma resposta numa janela que ninguém vê.")
    }
    $exitCode = [int] $outcome.exitCode

    # --- 5. Sucesso = a chave saiu do registro ---------------------------------------
    $phase = 'confirm'
    Write-Log 'INFO' 'confirm' "O desinstalador terminou com o código $exitCode. Conferindo se o programa saiu do registro (até $waitSeconds s)."
    $removed = Invoke-Command -Session $session -ArgumentList $in.arch, $in.uninstallKey, ($waitSeconds * 1000) -ScriptBlock {
      param($Arch, $Key, $WaitMs)
      $base = if ($Arch -eq '32') { 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' }
              else { 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' }
      $path = "$base\$Key"
      $deadline = (Get-Date).AddMilliseconds($WaitMs)
      do {
        if (-not (Test-Path -LiteralPath $path)) { return $true }
        Start-Sleep -Seconds 2
      } while ((Get-Date) -lt $deadline)
      return (-not (Test-Path -LiteralPath $path))
    }
    if ($removed) {
      $final = @{ type = 'result'; ok = $true; removed = $true; exitCode = $exitCode }
    } else {
      $final = @{ type = 'result'; ok = $false; phase = 'confirm'; reason = 'still-installed'; exitCode = $exitCode
                  message = "O programa continua registrado em $computer depois de $waitSeconds s (o desinstalador terminou com o código $exitCode)." }
    }
  }
} catch [DeployFailure] {
  $final = @{ type = 'result'; ok = $false; phase = $_.Exception.Phase; reason = $_.Exception.Reason; message = $_.Exception.Message }
} catch {
  $final = @{ type = 'result'; ok = $false; phase = $phase; reason = 'unexpected'; message = (Get-InnermostMessage $_) }
} finally {
  if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}

Write-Event $final
exit 0
