# Pasta temporária da instalação na máquina de destino.
#
# Antes: C:\Windows\Temp\rsd\<alvo>, criada pelo compartilhamento C$ e herdando a ACL do pai,
# onde usuários comuns podem criar arquivos — risco de plantar uma DLL ao lado do instalador
# (que roda como administrador) ou de pré-criar a pasta. Agora: C:\ProgramData\RSD\<alvo>, só
# SYSTEM e Administradores, sem herança, conferida antes de usar.
#
# UMA função autocontida, de propósito: deploy-target.ps1 a executa NA MÁQUINA pela sessão
# WinRM (Invoke-Command -ScriptBlock ${function:Initialize-RsdTempDir}), e só o corpo da
# função viaja — nada de funções auxiliares fora dela.
#
# Mensagens de recusa começam com "Pasta temporária insegura" (o script vira o motivo
# 'unsafe-temp-dir'); as outras falhas, com "Não foi possível preparar a pasta temporária".

function Initialize-RsdTempDir {
  param(
    [Parameter(Mandatory = $true)] [string] $BaseDir,
    [Parameter(Mandatory = $true)] [string] $TargetId,
    # Dono das pastas criadas. Produção: Administradores. Os testes passam o próprio usuário.
    [string] $OwnerSid = 'S-1-5-32-544',
    # Só para os testes (apagar as pastas sem ser administrador). Produção: nenhuma.
    [string[]] $ExtraSids = @()
  )
  $ErrorActionPreference = 'Stop'

  $system = 'S-1-5-18'
  $admins = 'S-1-5-32-544'
  $allowed = @($system, $admins) + $ExtraSids
  $owners = @($system, $admins, $OwnerSid)

  if ($TargetId -notmatch '^[A-Za-z0-9-]{1,64}$') {
    throw "Não foi possível preparar a pasta temporária: identificador inválido ($TargetId)."
  }

  # ACL final já na criação (Directory.CreateDirectory com DirectorySecurity): não existe um
  # instante em que a pasta fica aberta, herdando a ACL do ProgramData.
  $newSecurity = {
    $sec = New-Object System.Security.AccessControl.DirectorySecurity
    $sec.SetAccessRuleProtection($true, $false)
    foreach ($sid in $allowed) {
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $sec.AddAccessRule($rule)
    }
    $sec.SetOwner([System.Security.Principal.SecurityIdentifier]::new($OwnerSid))
    $sec
  }

  $nameOf = {
    param([string] $Sid)
    try { "$(([System.Security.Principal.SecurityIdentifier]::new($Sid)).Translate([System.Security.Principal.NTAccount]).Value) ($Sid)" } catch { $Sid }
  }

  # Pasta de verdade (não junção nem link), dono SYSTEM/Administradores, herança desligada e
  # nenhuma permissão de acesso para mais ninguém.
  $assertSafe = {
    param([string] $Path)
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) { throw "Pasta temporária insegura: $Path não é uma pasta." }
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "Pasta temporária insegura: $Path é uma junção ou link simbólico."
    }
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($owners -notcontains $owner) {
      throw "Pasta temporária insegura: o dono de $Path é $(& $nameOf $owner) (esperado SYSTEM ou Administradores)."
    }
    if (-not $acl.AreAccessRulesProtected) {
      throw "Pasta temporária insegura: $Path herda permissões da pasta-mãe (herança ligada)."
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Value) {
        throw "Pasta temporária insegura: $Path dá permissão a $(& $nameOf $rule.IdentityReference.Value) (só SYSTEM e Administradores podem ter acesso)."
      }
    }
  }

  # --- Pasta-base -----------------------------------------------------------------------
  if (Test-Path -LiteralPath $BaseDir) {
    & $assertSafe $BaseDir
  } else {
    $parent = Split-Path -Parent $BaseDir
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
      throw "Não foi possível preparar a pasta temporária: $parent não existe."
    }
    $null = [System.IO.Directory]::CreateDirectory($BaseDir, (& $newSecurity))
    # Se alguém criou a pasta entre o teste e a criação, o CreateDirectory não aplica a ACL
    # (a pasta já existe): a conferência pega.
    & $assertSafe $BaseDir
  }

  # --- Pasta do alvo --------------------------------------------------------------------
  $dir = Join-Path $BaseDir $TargetId
  if (Test-Path -LiteralPath $dir) {
    # Sobra de uma execução interrompida (só um administrador conseguiria criá-la aqui).
    # Junção nunca é seguida nem apagada: apagar recursivamente apagaria o destino dela.
    $item = Get-Item -LiteralPath $dir -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "Pasta temporária insegura: $dir é uma junção ou link simbólico (sobra suspeita; não foi apagada)."
    }
    Remove-Item -LiteralPath $dir -Recurse -Force
  }
  $null = [System.IO.Directory]::CreateDirectory($dir, (& $newSecurity))
  & $assertSafe $dir
  return $dir
}
