#Requires -Version 5.1
<#
  uninstall-command-rules.ps1 - REGRAS do comando de desinstalacao do fabricante
  (QuietUninstallString), para programa que NAO e MSI. Excecao controlada (DECISIONS.md).

  Usado (dot-source) pelo uninstall-program-target.ps1 ANTES de executar, com as pastas
  Program Files reais da maquina de destino. Mesmas regras do validador do servidor
  (backend/src/deployments/vendor-uninstall.ts) e os MESMOS casos de teste
  (uninstall-command-cases.json) - um teste do backend roda os casos nos dois.

  Salvo em UTF-8 COM BOM.
#>

$script:BlockedExecutables = @(
  'cmd', 'powershell', 'powershell_ise', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32',
  'msiexec', 'conhost', 'bash', 'wsl', 'certutil', 'bitsadmin', 'schtasks', 'reg', 'regedit', 'sc', 'net',
  'net1', 'taskkill', 'explorer', 'curl', 'ftp', 'msbuild', 'installutil', 'regasm', 'regsvcs', 'cmstp',
  'forfiles', 'hh', 'wmic', 'control', 'msdt', 'odbcconf', 'at', 'psexec', 'psexec64', 'python', 'pythonw',
  'node', 'java', 'javaw', 'wt', 'tar', 'expand', 'makecab', 'esentutl', 'diskshadow', 'ntdsutil'
)

# Devolve @{ ok = $true; executable; arguments } ou @{ ok = $false; reason }.
function Test-UninstallCommand([string] $Command, [string[]] $Roots) {
  $fail = { param($reason) return @{ ok = $false; reason = $reason } }
  if ($null -eq $Command -or $Command.Trim() -eq '') { return & $fail 'Comando vazio.' }
  if ($Command.Length -gt 1024) { return & $fail 'Comando com mais de 1024 caracteres.' }
  if ($Command -match '[\x00-\x1f\x7f]') { return & $fail 'Comando com caracteres de controle (ex.: quebra de linha).' }
  $text = $Command.Trim()

  if ($text.StartsWith('"')) {
    $close = $text.IndexOf('"', 1)
    if ($close -lt 0) { return & $fail 'Aspas sem fechar no executável.' }
    $exe = $text.Substring(1, $close - 1)
    $rest = $text.Substring($close + 1)
    if ($rest -ne '' -and -not $rest.StartsWith(' ')) { return & $fail 'Falta espaço entre o executável e os argumentos.' }
  } else {
    $space = $text.IndexOf(' ')
    if ($space -lt 0) { $exe = $text; $rest = '' } else { $exe = $text.Substring(0, $space); $rest = $text.Substring($space) }
    if (-not $exe.ToLowerInvariant().EndsWith('.exe') -and $rest -ne '' -and $exe -match '^[A-Za-z]:\\') {
      return & $fail 'O caminho do executável tem espaço e precisa estar entre aspas.'
    }
  }
  $arguments = $rest.Trim()

  if ($exe -notmatch '^[A-Za-z]:\\' -or $exe.StartsWith('\\')) {
    return & $fail 'O executável precisa ter caminho absoluto (C:\...), sem caminho de rede nem variável.'
  }
  if ($exe -match '[%$<>|*?^&;`"]') { return & $fail 'O caminho do executável tem caractere não permitido.' }
  foreach ($part in $exe.Split('\')) {
    if ($part -eq '..' -or $part -eq '.') { return & $fail "O caminho do executável não pode ter '..'." }
  }
  if ($exe.Contains('~')) { return & $fail "O caminho do executável não pode ter '~' (nome curto 8.3)." }
  if (-not $exe.ToLowerInvariant().EndsWith('.exe')) { return & $fail 'O executável precisa ser um .exe.' }

  $lower = $exe.ToLowerInvariant()
  $inRoot = $false
  foreach ($root in @($Roots)) {
    if (-not $root) { continue }
    $r = $root.TrimEnd('\').ToLowerInvariant()
    if ($r -ne '' -and $lower.StartsWith("$r\")) { $inRoot = $true }
  }
  if (-not $inRoot) { return & $fail 'O executável precisa estar dentro de Program Files ou Program Files (x86).' }

  $base = $lower.Substring($lower.LastIndexOf('\') + 1) -replace '\.exe$', ''
  if ($script:BlockedExecutables -contains $base) { return & $fail "O executável $base.exe não é permitido." }

  if ($arguments -match '[&|;<>^%$`]') {
    return & $fail 'Os argumentos têm caractere não permitido (&, |, ;, <, >, ^, %, $ ou crase).'
  }
  if ((([regex]::Matches($arguments, '"')).Count % 2) -ne 0) { return & $fail 'Aspas desbalanceadas nos argumentos.' }
  return @{ ok = $true; executable = $exe; arguments = $arguments }
}
