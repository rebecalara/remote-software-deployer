# Teste: roda os casos de uninstall-command-cases.json no validador PowerShell (uninstall-command-rules.ps1).
param([string] $Rules, [string] $Cases)
. $Rules
$data = Get-Content -Raw -LiteralPath $Cases -Encoding UTF8 | ConvertFrom-Json
$out = foreach ($c in $data.cases) { $r = Test-UninstallCommand $c.command $data.roots; @{ name = $c.name; ok = $r.ok; executable = $r.executable; arguments = $r.arguments; reason = $r.reason } }
$json = ConvertTo-Json -InputObject @($out) -Compress -Depth 3
[Console]::Out.WriteLine([regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
