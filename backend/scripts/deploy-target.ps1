#Requires -Version 5.1
<#
  deploy-target.ps1 - instala UM software em UMA maquina de destino.

  Chamado somente pelo PowerShellExecutor do backend (ver DECISIONS.md, Bloco 4).
  Script FIXO e versionado: nunca e montado como texto, e nunca executa nada alem do
  instalador, com o comando-base decidido pelo tipo (MSI ou EXE).

  Entrada: UM objeto JSON pela entrada padrao - nunca pela linha de comando, que
  aparece na lista de processos e no evento 4688 do Windows. A credencial (quando
  houver) chega por aqui e so existe na memoria deste processo.

  Saida: UM evento JSON por linha no stdout, so com caracteres ASCII:
    {"type":"log","level":"INFO","phase":"copy","message":"..."}
    {"type":"result","ok":true,"exitCode":3010}
    {"type":"result","ok":true,"alreadyInstalled":true,"productCode":"{...}"}
    {"type":"result","ok":false,"phase":"connect","reason":"unreachable","message":"..."}
  O script NAO interpreta o codigo de saida (0, 3010, 1603...): isso e regra do
  backend. "ok" diz que o instalador executou e terminou, ou que (so MSI) o produto
  ja estava instalado e nada foi executado.

  Este arquivo precisa ser salvo em UTF-8 COM BOM: sem o BOM, o Windows PowerShell
  5.1 le o arquivo como ANSI e as mensagens com acento saem corrompidas (um teste
  do backend confere isso).
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Pasta de trabalho na maquina de destino. Sem espaco no caminho, de proposito:
# o Start-Process -ArgumentList junta os itens com espaco, sem aspas.
$RemoteBaseDir = 'C:\Windows\Temp\rsd'

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

  foreach ($field in 'targetId', 'computerName', 'installerPath', 'sha256', 'installType',
                     'connectTimeoutSeconds', 'installTimeoutSeconds') {
    if ($null -eq $In.PSObject.Properties[$field] -or $null -eq $In.$field) {
      & $fail "Campo obrigatório ausente: $field."
    }
  }
  if ($In.targetId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
    & $fail 'Identificador do alvo inválido.'
  }
  # Nome curto (NetBIOS), FQDN ou IPv4. Nada de barra, espaço ou aspas: o nome entra
  # num caminho UNC (\\nome\C$).
  if ($In.computerName -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9-]{1,63})*$') {
    & $fail 'Nome de máquina inválido.'
  }
  if ($In.sha256 -cnotmatch '^[A-F0-9]{64}$') {
    & $fail 'SHA-256 inválido.'
  }
  if ($In.installType -cne 'MSI' -and $In.installType -cne 'EXE') {
    & $fail 'Tipo de instalador inválido.'
  }
  # Só nomes gerados pelo sistema (<uuid>.msi|exe), com a extensão do tipo.
  $fileName = [System.IO.Path]::GetFileName($In.installerPath)
  $expectedExt = $In.installType.ToLowerInvariant()
  if ($fileName -cnotmatch "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.$expectedExt$") {
    & $fail 'Nome do arquivo do instalador inválido.'
  }
  if (-not (Test-Path -LiteralPath $In.installerPath -PathType Leaf)) {
    & $fail 'Arquivo do instalador não encontrado no servidor.'
  }
  foreach ($arg in @($In.installArgs)) {
    if ($null -ne $arg -and $arg -isnot [string]) { & $fail 'Argumento de instalação inválido.' }
  }
  foreach ($field in 'connectTimeoutSeconds', 'installTimeoutSeconds') {
    $v = $In.$field
    if ($v -isnot [int] -or $v -lt 1 -or $v -gt 86400) { & $fail "Tempo limite inválido: $field." }
  }
}

$phase = 'validate'
$final = $null
$session = $null
$drive = $null
$remoteDirCreated = $false

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
  $fileName = [System.IO.Path]::GetFileName($in.installerPath)
  $installArgs = @(@($in.installArgs) | Where-Object { $null -ne $_ })
  $connectMs = $in.connectTimeoutSeconds * 1000
  $installMs = $in.installTimeoutSeconds * 1000

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

  # --- Cópia por SMB (C$) ----------------------------------------------------------
  $phase = 'copy'
  $remoteDirLocal = "$RemoteBaseDir\$($in.targetId)"             # caminho visto pela estação
  $remoteFileLocal = "$remoteDirLocal\$fileName"
  $driveParams = @{ Name = 'RSDTARGET'; PSProvider = 'FileSystem'; Root = "\\$computer\C$"; Scope = 'Script' }
  if ($credential) { $driveParams.Credential = $credential }
  try {
    $drive = New-PSDrive @driveParams
  } catch {
    throw [DeployFailure]::new('copy', 'smb-failed',
      "Não foi possível acessar \\$computer\C$ (compartilhamento administrativo, porta 445): $(Get-InnermostMessage $_)")
  }
  $remoteDir = "RSDTARGET:$($remoteDirLocal.Substring(2))"        # C:\Windows\... -> RSDTARGET:\Windows\...
  # "1,9 MB" (vírgula decimal): a mensagem vai para a tela em português.
  $sizeMb = ((Get-Item -LiteralPath $in.installerPath).Length / 1MB).ToString('0.0', [Globalization.CultureInfo]'pt-BR')
  Write-Log 'INFO' 'copy' "Copiando o instalador ($sizeMb MB) para $remoteFileLocal."
  try {
    $null = New-Item -ItemType Directory -Path $remoteDir -Force
    $remoteDirCreated = $true
    Copy-Item -LiteralPath $in.installerPath -Destination "$remoteDir\$fileName"
  } catch {
    throw [DeployFailure]::new('copy', 'copy-failed', "Falha ao copiar o instalador para ${computer}: $(Get-InnermostMessage $_)")
  }

  # --- Conferência do hash na máquina de destino ----------------------------------
  $phase = 'verify'
  $remoteHash = Invoke-Command -Session $session -ArgumentList $remoteFileLocal -ScriptBlock {
    param($Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  }
  if ($remoteHash -cne $in.sha256) {
    throw [DeployFailure]::new('verify', 'hash-mismatch',
      'O SHA-256 do arquivo copiado não confere com o do catálogo. A instalação não foi executada.')
  }
  Write-Log 'INFO' 'verify' 'SHA-256 conferido na máquina de destino.'

  # --- MSI: o produto já está instalado? -------------------------------------------
  # Reinstalar um MSI já presente faz o Windows Installer RECONFIGURAR o produto, e
  # ele procura a origem da instalação anterior — a pasta temporária que este script
  # apaga no fim. Resultado: 1603 (encontrado no teste com a VM). Por isso, antes de
  # executar, o ProductCode é lido do próprio pacote (tabela Property, só leitura) e
  # conferido no Windows Installer da máquina. EXE não tem código de produto confiável:
  # segue direto para a instalação.
  if ($in.installType -eq 'MSI') {
    $phase = 'check'
    $check = Invoke-Command -Session $session -ArgumentList $remoteFileLocal -ScriptBlock {
      param($Path)
      $wi = $null; $db = $null; $view = $null; $rec = $null
      try {
        $wi = New-Object -ComObject WindowsInstaller.Installer
        $db = $wi.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $wi, @($Path, 0))
        $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db,
          @("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = 'ProductCode'"))
        [void] $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
        $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
        if ($null -eq $rec) { return @{ productCode = $null; error = 'o pacote não tem ProductCode' } }
        $code = [string] $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, 1)
        [void] $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)
        # ProductState: 5 = instalado; -1 = desconhecido; 1 = anunciado; 2 = ausente.
        $state = [int] $wi.GetType().InvokeMember('ProductState', 'GetProperty', $null, $wi, @($code))
        return @{ productCode = $code; state = $state; error = $null }
      } catch {
        return @{ productCode = $null; error = $_.Exception.Message }
      } finally {
        # Solta o arquivo: sem isto, o pacote fica travado e a limpeza falha.
        foreach ($o in $rec, $view, $db, $wi) {
          if ($null -ne $o) { [void] [System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) }
        }
      }
    }
    if ($check.error) {
      Write-Log 'WARN' 'check' "Não foi possível conferir se o produto já está instalado ($($check.error)). A instalação segue."
    } elseif ($check.state -eq 5) {
      $final = @{ type = 'result'; ok = $true; alreadyInstalled = $true; productCode = [string] $check.productCode }
    } else {
      Write-Log 'INFO' 'check' "Produto ainda não instalado na máquina (ProductCode $($check.productCode))."
    }
  }

  # --- Instalação ---------------------------------------------------------------
  # Os argumentos seguem SEMPRE como itens do -ArgumentList do Start-Process — nunca
  # Invoke-Expression, cmd /c ou comando montado como texto (DECISIONS.md, Bloco 4).
  if ($null -eq $final) {
    $phase = 'install'
    Write-Log 'INFO' 'install' "Executando o instalador ($($in.installType)) em $computer."
    $outcome = Invoke-Command -Session $session -ArgumentList $remoteFileLocal, $in.installType, $installArgs, $installMs -ScriptBlock {
      param($File, $Type, $ExtraArgs, $TimeoutMs)
      $ErrorActionPreference = 'Stop'
      $extra = @(@($ExtraArgs) | Where-Object { $null -ne $_ })
      if ($Type -eq 'MSI') {
        $exe = Join-Path $env:SystemRoot 'System32\msiexec.exe'
        # REBOOT=ReallySuppress por ÚLTIMO: uma propriedade REBOOT vinda do catálogo
        # depois do /norestart vence (no teste com a VM, REBOOT=Force deu 1641 e a
        # máquina reiniciou). A última ocorrência na linha de comando prevalece, então
        # esta garante que o sistema nunca reinicia a máquina, mesmo que o validador do
        # catálogo seja contornado.
        $argList = @('/i', $File, '/qn', '/norestart') + $extra + @('REBOOT=ReallySuppress')
      } else {
        $exe = $File
        $argList = $extra
      }
      $startParams = @{ FilePath = $exe; PassThru = $true }
      if ($argList.Count -gt 0) { $startParams.ArgumentList = $argList }
      $process = Start-Process @startParams
      # Sem ler o Handle logo após o início, o ExitCode pode vir vazio
      # (comportamento conhecido do Start-Process -PassThru).
      $null = $process.Handle
      if ($process.WaitForExit($TimeoutMs)) {
        return @{ timedOut = $false; exitCode = $process.ExitCode }
      }
      # Instalador travado (pelo WinRM não há janela: um EXE sem o argumento silencioso
      # espera para sempre). Encerra a árvore inteira de processos.
      $null = & taskkill.exe /PID $process.Id /T /F 2>&1
      return @{ timedOut = $true; exitCode = $null }
    }

    if ($outcome.timedOut) {
      throw [DeployFailure]::new('install', 'install-timeout',
        "Tempo esgotado ($($in.installTimeoutSeconds) s): o instalador foi encerrado. Ele pode estar esperando interação — confira os argumentos de instalação silenciosa.")
    }
    $exitCode = [int] $outcome.exitCode
    Write-Log 'INFO' 'install' "O instalador terminou com o código $exitCode."
    $final = @{ type = 'result'; ok = $true; exitCode = $exitCode }
  }
} catch [DeployFailure] {
  $final = @{ type = 'result'; ok = $false; phase = $_.Exception.Phase; reason = $_.Exception.Reason; message = $_.Exception.Message }
} catch {
  $final = @{ type = 'result'; ok = $false; phase = $phase; reason = 'unexpected'; message = (Get-InnermostMessage $_) }
} finally {
  if ($remoteDirCreated) {
    try {
      Remove-Item -LiteralPath $remoteDir -Recurse -Force
      Write-Log 'INFO' 'cleanup' "Arquivos temporários apagados de $computer."
    } catch {
      Write-Log 'WARN' 'cleanup' "Não foi possível apagar $remoteDirLocal em ${computer}: $(Get-InnermostMessage $_)"
    }
  }
  if ($drive) { Remove-PSDrive -Name 'RSDTARGET' -Scope Script -ErrorAction SilentlyContinue }
  if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}

Write-Event $final
exit 0
