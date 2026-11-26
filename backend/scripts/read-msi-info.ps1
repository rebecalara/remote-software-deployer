#Requires -Version 5.1
<#
  read-msi-info.ps1 - le o ProductCode (e nome, versao e fabricante) de UM pacote MSI
  guardado pelo sistema, NO PROPRIO SERVIDOR.

  Chamado somente pelo MsiInfoReader do backend, no envio de um instalador MSI (ver
  DECISIONS.md, desinstalacao remota). Script FIXO e versionado. O pacote e aberto SO
  PARA LEITURA (OpenDatabase modo 0) pelo COM WindowsInstaller.Installer - a mesma
  consulta a tabela Property ja usada pelo deploy-target.ps1 na maquina de destino.
  Nada e instalado nem executado.

  Entrada: UM objeto JSON pela entrada padrao: {"path":"C:\\...\\<uuid>.msi"}.
  Saida: UMA linha JSON no stdout, so com caracteres ASCII:
    {"ok":true,"productCode":"{...}","productName":"...","productVersion":"...","manufacturer":"..."}
    {"ok":false,"message":"..."}

  Salvo em UTF-8 COM BOM, como o deploy-target.ps1 (um teste do backend confere).
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Result([hashtable] $Result) {
  $json = ConvertTo-Json -InputObject $Result -Compress
  # Só ASCII: o stdout do powershell.exe 5.1 sai na página de código do console.
  $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($json)
}

$wi = $null; $db = $null
try {
  $in = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  if ($null -eq $in -or $null -eq $in.PSObject.Properties['path'] -or $in.path -isnot [string]) {
    throw 'Entrada inválida.'
  }
  $path = $in.path
  # Só arquivos gerados pelo sistema (<uuid>.msi).
  if ([System.IO.Path]::GetFileName($path) -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.msi$') {
    throw 'Nome do arquivo inválido.'
  }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Arquivo não encontrado.' }

  $wi = New-Object -ComObject WindowsInstaller.Installer
  $db = $wi.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $wi, @($path, 0))
  $props = @{}
  foreach ($name in 'ProductCode', 'ProductName', 'ProductVersion', 'Manufacturer') {
    $view = $null; $rec = $null
    try {
      $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db,
        @("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$name'"))
      [void] $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
      $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
      $props[$name] = if ($null -eq $rec) { $null } else { [string] $rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, 1) }
      [void] $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)
    } finally {
      foreach ($o in $rec, $view) {
        if ($null -ne $o) { [void] [System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) }
      }
    }
  }
  if (-not $props['ProductCode']) { throw 'O pacote não tem ProductCode.' }
  Write-Result @{
    ok = $true
    productCode = $props['ProductCode']
    productName = $props['ProductName']
    productVersion = $props['ProductVersion']
    manufacturer = $props['Manufacturer']
  }
} catch {
  $msg = $_.Exception.Message
  Write-Result @{ ok = $false; message = [string] $msg }
} finally {
  # Solta o arquivo: sem isto, o pacote fica travado e não pode ser apagado.
  foreach ($o in $db, $wi) {
    if ($null -ne $o) { [void] [System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) }
  }
}
exit 0
