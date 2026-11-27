# Funções comuns ao deploy (deploy.ps1), ao rollback (rollback.ps1) e ao preparo da VM
# (provision-app.ps1). Só definições: carregar este arquivo não executa nada.
# Windows PowerShell 5.1. Salvo em UTF-8 com BOM (as mensagens têm acento).

Set-StrictMode -Version 2.0

# ---------------------------------------------------------------------------------------------
# Caminhos fixos na APP-RSD (ver README, "Deploy em produção").
# ---------------------------------------------------------------------------------------------
function Get-RsdPaths {
  param([string]$Root = 'C:\rsd')
  [pscustomobject]@{
    Root        = $Root
    App         = Join-Path $Root 'app'
    Releases    = Join-Path $Root 'app\releases'
    Current     = Join-Path $Root 'app\current'
    History     = Join-Path $Root 'app\deploys.jsonl'
    Lock        = Join-Path $Root 'app\.deploy.lock'
    Config      = Join-Path $Root 'config'
    BackendEnv  = Join-Path $Root 'config\backend.env'
    DeployEnv   = Join-Path $Root 'config\deploy.env'
    CaPem       = Join-Path $Root 'config\rsd-ca.pem'
    Data        = Join-Path $Root 'data'
    Installers  = Join-Path $Root 'data\installers'
    Backups     = Join-Path $Root 'data\backups'
    Caddy       = Join-Path $Root 'caddy'
    Logs        = Join-Path $Root 'logs'
    Service     = Join-Path $Root 'service'
  }
}

$script:RsdServiceName = 'rsd-backend'
$script:RsdKeepReleases = 5
$script:RsdKeepBackups = 10

# ---------------------------------------------------------------------------------------------
# Arquivos .env: KEY=valor por linha, com ou sem aspas; # é comentário.
# ---------------------------------------------------------------------------------------------
function Read-EnvFile {
  param([Parameter(Mandatory)][string]$Path)
  $values = @{}
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $value = $t.Substring($eq + 1).Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }
  return $values
}

# Troca (ou acrescenta) uma chave num .env, sem mexer nas outras linhas nem nos comentários.
function Set-EnvValue {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][AllowEmptyString()][string]$Value)
  $lines = [Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $Path) { $lines.AddRange([IO.File]::ReadAllLines($Path)) }
  # Com barra invertida (caminho do Windows), aspas simples: entre aspas duplas o dotenv do backend
  # troca \r e \n por quebra de linha.
  if ($Value.Contains('\')) {
    if ($Value.Contains("'")) { throw "Set-EnvValue: valor de $Key com barra invertida e aspas simples não tem forma segura no .env." }
    $newLine = "$Key='$Value'"
  } else {
    $newLine = "$Key=`"$Value`""
  }
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$([regex]::Escape($Key))\s*=") { $lines[$i] = $newLine; $found = $true }
  }
  if (-not $found) { $lines.Add($newLine) }
  [IO.File]::WriteAllLines($Path, $lines, (New-Object Text.UTF8Encoding($false)))
}

# O pg_dump não aceita parâmetros que não são do libpq (o Prisma usa ?schema=public).
function ConvertTo-PgUri {
  param([Parameter(Mandatory)][string]$DatabaseUrl)
  $q = $DatabaseUrl.IndexOf('?')
  if ($q -ge 0) { return $DatabaseUrl.Substring(0, $q) }
  return $DatabaseUrl
}

# Senha aleatória forte, só com caracteres seguros numa URL (base64url).
function New-RandomSecret {
  param([int]$Bytes = 32)
  $buffer = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return ([Convert]::ToBase64String($buffer)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# ---------------------------------------------------------------------------------------------
# Versões publicadas: C:\rsd\app\releases\<aaaaMMdd-HHmmss>-<sha7>. A junção "current" aponta
# para a que está no ar. Junção, e não symlink: não exige privilégio de administrador.
# ---------------------------------------------------------------------------------------------
function New-ReleaseName {
  param([Parameter(Mandatory)][string]$Sha, [datetime]$When = (Get-Date))
  if ($Sha -notmatch '^[0-9a-f]{7,40}$') { throw "SHA inválido: '$Sha'." }
  return '{0}-{1}' -f $When.ToString('yyyyMMdd-HHmmss'), $Sha.Substring(0, 7)
}

function Get-CurrentRelease {
  param([Parameter(Mandatory)]$Paths)
  $item = Get-Item -LiteralPath $Paths.Current -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $null }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    $target = @($item.Target)[0]
    if ($target) { return (Split-Path -Leaf $target) }
  }
  throw "$($Paths.Current) existe e não é uma junção: confira à mão antes do deploy."
}

# Versões em ordem (a mais antiga primeiro), pelo nome com data.
function Get-Releases {
  param([Parameter(Mandatory)]$Paths)
  if (-not (Test-Path -LiteralPath $Paths.Releases)) { return @() }
  return @(Get-ChildItem -LiteralPath $Paths.Releases -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}-[0-9a-f]{7}$' } |
      Sort-Object Name | ForEach-Object Name)
}

# Aponta "current" para uma versão. Só mexe na junção (nunca no conteúdo das versões).
function Set-CurrentRelease {
  param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$Name)
  $target = Join-Path $Paths.Releases $Name
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "Versão inexistente: $target" }
  $item = Get-Item -LiteralPath $Paths.Current -Force -ErrorAction SilentlyContinue
  if ($item) {
    if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "$($Paths.Current) não é uma junção." }
    [IO.Directory]::Delete($Paths.Current, $false) # apaga SÓ a junção, não o destino
  }
  $null = New-Item -ItemType Junction -Path $Paths.Current -Target $target
}

# Versões que podem ser apagadas: além das últimas $Keep, nunca a atual nem a anterior.
function Get-ReleasesToDelete {
  param([string[]]$Releases, [string]$Current, [string]$Previous, [int]$Keep = $script:RsdKeepReleases)
  $sorted = @($Releases | Sort-Object)
  if ($sorted.Count -le $Keep) { return @() }
  $old = $sorted[0..($sorted.Count - $Keep - 1)]
  return @($old | Where-Object { $_ -ne $Current -and $_ -ne $Previous })
}

function Remove-OldReleases {
  param([Parameter(Mandatory)]$Paths, [string]$Current, [string]$Previous)
  foreach ($name in (Get-ReleasesToDelete -Releases (Get-Releases $Paths) -Current $Current -Previous $Previous)) {
    $dir = Join-Path $Paths.Releases $name
    # Só pastas DENTRO de releases, com o nome no formato das versões.
    if ((Split-Path -Parent $dir) -ne $Paths.Releases) { throw "Caminho fora de releases: $dir" }
    Remove-Item -LiteralPath $dir -Recurse -Force
    Write-RsdLog "Versão antiga apagada: $name"
  }
}

# Backups de antes do deploy: mantém os $Keep mais recentes (só os que o deploy cria).
function Remove-OldBackups {
  param([Parameter(Mandatory)]$Paths, [int]$Keep = $script:RsdKeepBackups)
  $dumps = @(Get-ChildItem -LiteralPath $Paths.Backups -File -Filter 'rsd-antes-deploy-*.dump' -ErrorAction SilentlyContinue | Sort-Object Name)
  if ($dumps.Count -le $Keep) { return }
  foreach ($d in $dumps[0..($dumps.Count - $Keep - 1)]) {
    Remove-Item -LiteralPath $d.FullName -Force
    Write-RsdLog "Backup antigo apagado: $($d.Name)"
  }
}

# ---------------------------------------------------------------------------------------------
# Serviço e saúde do backend.
# ---------------------------------------------------------------------------------------------
function Test-BackendHealth {
  param([string]$Url = 'http://127.0.0.1:3000/health', [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $last = ''
  do {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
      if ($r.StatusCode -eq 200 -and ($r.Content | ConvertFrom-Json).status -eq 'ok') { return $true }
      $last = "HTTP $($r.StatusCode)"
    } catch {
      $last = $_.Exception.Message
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  Write-RsdLog "Health check sem sucesso em $TimeoutSeconds s ($Url): $last" 'WARN'
  return $false
}

function Restart-RsdService {
  param([string]$Name = $script:RsdServiceName)
  $svc = Get-Service -Name $Name -ErrorAction Stop
  if ($svc.Status -ne 'Stopped') {
    Stop-Service -Name $Name -ErrorAction Stop
    $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
  }
  Start-Service -Name $Name -ErrorAction Stop
}

function Stop-RsdService {
  param([string]$Name = $script:RsdServiceName)
  $svc = Get-Service -Name $Name -ErrorAction Stop
  if ($svc.Status -ne 'Stopped') {
    Stop-Service -Name $Name -ErrorAction Stop
    $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
  }
}

# Versão anterior à atual (a mais nova entre as mais antigas que ela), para o rollback.
function Get-PreviousRelease {
  param([Parameter(Mandatory)]$Paths, [string]$Current = (Get-CurrentRelease $Paths))
  $older = @(Get-Releases $Paths | Where-Object { $Current -and $_ -lt $Current })
  if ($older.Count -eq 0) { return $null }
  return $older[-1]
}

# Acha uma versão pelo nome completo ou pelo SHA (7 a 40 caracteres).
function Resolve-Release {
  param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][string]$NameOrSha)
  $all = @(Get-Releases $Paths)
  if ($all -contains $NameOrSha) { return $NameOrSha }
  if ($NameOrSha -match '^[0-9a-f]{7,40}$') {
    $hits = @($all | Where-Object { $_.EndsWith('-' + $NameOrSha.Substring(0, 7)) })
    if ($hits.Count -ge 1) { return $hits[-1] }
  }
  throw "Versão não encontrada em $($Paths.Releases): $NameOrSha"
}

<#
  Troca a versão no ar: para o serviço, aponta "current" para a nova, inicia e confere a saúde.
  Se a saúde falhar, volta sozinho para a versão anterior (código; o banco não é desfeito) e
  confere de novo. Os blocos Stop/Start/Health são parâmetros para dar para testar sem serviço.
  Devolve: Ok, Release (a que ficou no ar), Previous, RolledBack, Message.
#>
function Invoke-ReleaseSwitch {
  param(
    [Parameter(Mandatory)]$Paths,
    [Parameter(Mandatory)][string]$NewRelease,
    [Parameter(Mandatory)][scriptblock]$Stop,
    [Parameter(Mandatory)][scriptblock]$Start,
    [Parameter(Mandatory)][scriptblock]$Health
  )
  $previous = Get-CurrentRelease $Paths
  Write-RsdLog "Trocando a versão: $(if ($previous) { $previous } else { '(nenhuma)' }) -> $NewRelease"
  & $Stop
  Set-CurrentRelease -Paths $Paths -Name $NewRelease
  $started = $true
  try { & $Start } catch { $started = $false; Write-RsdLog "O serviço não iniciou: $($_.Exception.Message)" 'ERROR' }
  if ($started -and (& $Health)) {
    return [pscustomobject]@{ Ok = $true; Release = $NewRelease; Previous = $previous; RolledBack = $false; Message = "Versão $NewRelease no ar." }
  }
  if (-not $previous) {
    return [pscustomobject]@{ Ok = $false; Release = $NewRelease; Previous = $null; RolledBack = $false
      Message = "A versão $NewRelease não passou no health check e não há versão anterior para voltar. Confira o serviço e os logs em C:\rsd\logs." }
  }
  Write-RsdLog "Health check falhou: voltando para $previous." 'WARN'
  & $Stop
  Set-CurrentRelease -Paths $Paths -Name $previous
  $back = $true
  try { & $Start } catch { $back = $false; Write-RsdLog "O serviço não iniciou na versão anterior: $($_.Exception.Message)" 'ERROR' }
  if ($back -and (& $Health)) {
    return [pscustomobject]@{ Ok = $false; Release = $previous; Previous = $previous; RolledBack = $true
      Message = "A versão $NewRelease não passou no health check; rollback automático para $previous (no ar). O banco NÃO foi desfeito." }
  }
  return [pscustomobject]@{ Ok = $false; Release = $previous; Previous = $previous; RolledBack = $false
    Message = "Rollback para $previous também falhou no health check: intervenção manual (rollback.ps1, logs em C:\rsd\logs)." }
}

# SQL que lista o que falta ao rsd_app: tabela sem SELECT, INSERT, UPDATE ou DELETE e sequência
# sem USAGE. Resultado vazio = tudo certo. Roda como rsd_owner (has_*_privilege só consulta).
function Get-AppGrantProblemsSql {
  return @'
SELECT coalesce(string_agg(item, ', ' ORDER BY item), '') FROM (
  SELECT format('%I.%I (%s)', t.schemaname, t.tablename, p.priv) AS item
    FROM pg_tables t CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(priv)
   WHERE t.schemaname = 'public'
     AND NOT has_table_privilege('rsd_app', format('%I.%I', t.schemaname, t.tablename), p.priv)
  UNION ALL
  SELECT format('%I.%I (USAGE)', s.sequence_schema, s.sequence_name)
    FROM information_schema.sequences s
   WHERE s.sequence_schema = 'public'
     AND NOT has_sequence_privilege('rsd_app', format('%I.%I', s.sequence_schema, s.sequence_name), 'USAGE')
) problems;
'@
}

# SQL que o rsd_app roda para provar que lê e grava em cada tabela, sem mudar nenhuma linha:
# SELECT, INSERT...SELECT...WHERE false, UPDATE...WHERE false e DELETE...WHERE false, numa
# transação desfeita. Imprime "OK <n> tabelas" ou levanta erro com a tabela e a operação.
function Get-AppWriteCheckSql {
  return @'
BEGIN;
DO $$
DECLARE
  t record; col text; n int := 0; failures text[] := '{}';
BEGIN
  FOR t IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LOOP
    SELECT quote_ident(column_name) INTO col FROM information_schema.columns
     WHERE table_schema = t.schemaname AND table_name = t.tablename ORDER BY ordinal_position LIMIT 1;
    BEGIN
      EXECUTE format('SELECT 1 FROM %I.%I LIMIT 1', t.schemaname, t.tablename);
      EXECUTE format('INSERT INTO %I.%I SELECT * FROM %I.%I WHERE false', t.schemaname, t.tablename, t.schemaname, t.tablename);
      EXECUTE format('UPDATE %I.%I SET %s = %s WHERE false', t.schemaname, t.tablename, col, col);
      EXECUTE format('DELETE FROM %I.%I WHERE false', t.schemaname, t.tablename);
      n := n + 1;
    EXCEPTION WHEN insufficient_privilege THEN
      failures := failures || format('%I.%I: %s', t.schemaname, t.tablename, SQLERRM);
    END;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'Nenhuma tabela encontrada no schema public.'; END IF;
  IF array_length(failures, 1) > 0 THEN RAISE EXCEPTION 'Sem permissão: %', array_to_string(failures, '; '); END IF;
  RAISE NOTICE 'tabelas conferidas: %', n;
  PERFORM set_config('rsd.checked', n::text, true);
END $$;
SELECT 'OK ' || current_setting('rsd.checked') || ' tabelas'
  || CASE WHEN EXISTS (SELECT 1 FROM information_schema.sequences s WHERE s.sequence_schema = 'public'
       AND NOT has_sequence_privilege(format('%I.%I', s.sequence_schema, s.sequence_name), 'USAGE'))
     THEN ' — FALTA USAGE em sequência' ELSE '' END;
ROLLBACK;
'@
}

# ---------------------------------------------------------------------------------------------
# Usuários do RSD (tabela "User"), usados pelo deploy\add-user.ps1. O login nunca cria usuário:
# procura o nome digitado, em minúsculas, nesta tabela.
# ---------------------------------------------------------------------------------------------
$script:RsdRoles = @('ADMIN', 'OPERATOR', 'VIEWER')

# Confere os dados ANTES de tocar no banco. Devolve o papel em maiúsculas.
function Assert-RsdUserInput {
  param([Parameter(Mandatory)][string]$Username, [Parameter(Mandatory)][AllowEmptyString()][string]$DisplayName, [Parameter(Mandatory)][string]$Role)
  # -cnotmatch: o -match do PowerShell não diferencia maiúsculas, e o banco exige minúsculas.
  if ($Username -cnotmatch '^[a-z0-9._-]{1,64}$') {
    throw "Usuário '$Username' inválido: só letras minúsculas, números, '.', '_' e '-' (1 a 64), sem @ (o domínio vem do LDAP_BIND_DN_TEMPLATE)."
  }
  if ($DisplayName.Trim().Length -eq 0 -or $DisplayName.Length -gt 200) { throw 'Nome de exibição: de 1 a 200 caracteres.' }
  if ($DisplayName -match '[\x00-\x1F\x7F]') { throw 'Nome de exibição com caractere de controle.' }
  $r = $Role.ToUpperInvariant()
  if ($script:RsdRoles -cnotcontains $r) { throw "Papel '$Role' inválido: $($script:RsdRoles -join ', ')." }
  return $r
}

# Texto -> literal SQL (standard_conforming_strings, padrão do PostgreSQL: só a aspa simples é
# especial, e é dobrada).
function ConvertTo-SqlLiteral([string]$Text) { return "'" + $Text.Replace("'", "''") + "'" }

# SQL do add-user.ps1. Colunas NOT NULL sem padrão no banco: id, username, "displayName", role
# (o id do Prisma, @default(uuid()), é gerado pelo cliente; "createdAt" tem DEFAULT no banco).
# Usuário que já existe não muda. Saída (psql -t -A): "ANTES|<0 ou 1>" e
# "DEPOIS|<username>|<role>|<displayName>".
function Get-AddUserSql {
  param([Parameter(Mandatory)][string]$Username, [Parameter(Mandatory)][string]$DisplayName, [Parameter(Mandatory)][string]$Role)
  $r = Assert-RsdUserInput -Username $Username -DisplayName $DisplayName -Role $Role
  $u = ConvertTo-SqlLiteral $Username
  $d = ConvertTo-SqlLiteral $DisplayName.Trim()
  $roleLiteral = ConvertTo-SqlLiteral $r
  return @"
\set ON_ERROR_STOP on
\encoding UTF8
DO `$`$ BEGIN
  IF to_regclass('public."User"') IS NULL THEN
    RAISE EXCEPTION 'Tabela "User" não existe: rode o primeiro deploy (migrações) antes.';
  END IF;
END `$`$;
SELECT 'ANTES|' || count(*) FROM "User" WHERE username = $u;
INSERT INTO "User" (id, username, "displayName", role)
VALUES (gen_random_uuid(), $u, $d, $roleLiteral::"UserRole")
ON CONFLICT (username) DO NOTHING;
SELECT 'DEPOIS|' || username || '|' || role::text || '|' || "displayName" FROM "User" WHERE username = $u;
"@
}

# ---------------------------------------------------------------------------------------------
# Conferência de segredos no audit log do New Relic (deploy\check-newrelic-secrets.ps1). Os valores
# nunca saem destas funções: o resultado só traz NOMES, contagens e números de linha.
# ---------------------------------------------------------------------------------------------
$script:NewRelicLicenseName = 'NEW_RELIC_LICENSE_KEY'

# Segredos do backend.env (os mesmos que o backend mascara: observability/redact.ts), com o nome.
# A senha do DATABASE_URL entra crua e decodificada. Valores com menos de 4 caracteres ficam de fora.
function Get-BackendSecrets {
  param([Parameter(Mandatory)][hashtable]$EnvValues)
  $list = New-Object Collections.Generic.List[object]
  foreach ($name in @('JWT_SECRET', 'LDAP_SEARCH_BIND_PASSWORD', 'WINRM_PASSWORD', $script:NewRelicLicenseName)) {
    $v = "$($EnvValues[$name])".Trim()
    if ($v.Length -ge 4) { $list.Add([pscustomobject]@{ Name = $name; Value = $v }) }
  }
  $m = [regex]::Match("$($EnvValues['DATABASE_URL'])".Trim(), '^postgres(?:ql)?://[^:/@]+:([^@]+)@')
  if ($m.Success) {
    $raw = $m.Groups[1].Value
    foreach ($v in @($raw, [uri]::UnescapeDataString($raw)) | Select-Object -Unique) {
      if ($v.Length -ge 4) { $list.Add([pscustomobject]@{ Name = 'DATABASE_URL (senha)'; Value = $v }) }
    }
  }
  return $list.ToArray() # um item por segredo no pipeline (quem chama usa @(...))
}

# Texto que o agente grava a cada envio ao coletor (newrelic 14.12.0, lib/collector/remote-method.js,
# com o log em trace). Sem nenhuma linha assim, a conferência não viu envio nenhum: é inconclusiva.
$script:AgentPostMarker = 'Posting to'

# Linhas com envio do agente ao coletor.
function Measure-AgentPosts {
  param([Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines)
  return @($Lines | Where-Object { $_ -and $_.Contains($script:AgentPostMarker) }).Count
}

# Logs da conferência: os que mudaram desde a subida do serviço E, sempre, o rsd-backend.out.log e o
# rsd-backend.err.log do WinSW. Com o serviço segurando o arquivo aberto, o Windows não atualiza o
# LastWriteTime nem o tamanho na listagem (visto na APP-RSD: 9:27 com o serviço subindo às 9:31), e
# o arquivo principal ficava de fora.
function Get-NewRelicCheckFiles {
  param([Parameter(Mandatory)][string]$LogDir, [Parameter(Mandatory)][datetime]$Since, [string]$ServiceName = 'rsd-backend')
  $always = @("$ServiceName.out.log", "$ServiceName.err.log")
  return @(Get-ChildItem -LiteralPath $LogDir -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $Since -or $always -contains $_.Name } | Sort-Object FullName)
}

# Métodos do coletor cujo corpo é o JSON de configuração do agente (com a license key em texto).
$script:AgentConfigMethods = '(?:connect|preconnect|agent_settings)'

# Linha de trace do próprio agente que leva o JSON de configuração ao coletor (newrelic 14.12.0,
# lib/collector/remote-method.js), só nos métodos connect, preconnect e agent_settings:
#  - "Calling <método> on collector API" (component "remote_method", com o corpo em "data"), gravada
#    antes do envio;
#  - "Posting to https://.../invoke_raw_method?...&method=<método>", com o corpo em "body".
function Test-AgentConfigLine {
  param([AllowEmptyString()][string]$Line)
  if (-not $Line) { return $false }
  $m = $script:AgentConfigMethods
  if ($Line.Contains($script:AgentPostMarker) -and $Line -match "[?&]method=$m(?:[&`"\\\s]|$)") { return $true }
  return ($Line -match '"component"\s*:\s*"remote_method"' -and $Line -match "Calling $m on collector API")
}

# Conta, linha a linha, onde cada segredo aparece. Qualquer ocorrência é vazamento, com UMA exceção
# para a chave do New Relic: como valor de "license_key" no JSON de configuração do agente, numa linha
# de trace do próprio agente com esse JSON (Test-AgentConfigLine: "Calling connect|preconnect|
# agent_settings on collector API" ou o "Posting to" desses métodos). No 14.12.0, o corpo desses
# métodos é o config.publicSettings() (lib/collector/facts.js e api.js), que só mascara proxy e
# certificados: a chave vai em texto, só para o coletor (collector.newrelic.com). No log, esse corpo é
# uma string dentro do JSON, então as aspas podem vir escapadas (\"license_key\":\"...\"). Na URL do
# "Posting to" a chave já sai mascarada (redacted_license_key); a chave em texto em qualquer outro
# lugar — outro método (ex.: metric_data), log comum, URL, cabeçalho — é vazamento.
function Find-SecretOccurrences {
  param([Parameter(Mandatory)][AllowEmptyCollection()][AllowEmptyString()][string[]]$Lines, [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Secrets)
  $results = foreach ($s in $Secrets) {
    $escaped = [regex]::Escape($s.Value)
    $expectedContexts = '\\*"license_key\\*"\s*:\s*\\*"' + $escaped + '\\*"'
    $expected = 0; $leaks = 0; $leakLines = New-Object Collections.Generic.List[int]
    for ($i = 0; $i -lt $Lines.Count; $i++) {
      $line = $Lines[$i]
      if ($null -eq $line -or -not $line.Contains($s.Value)) { continue }
      $rest = $line
      if ($s.Name -eq $script:NewRelicLicenseName -and (Test-AgentConfigLine -Line $line)) {
        $expectedHere = ([regex]::Matches($line, $expectedContexts)).Count
        $expected += $expectedHere
        $rest = [regex]::Replace($line, $expectedContexts, '')
      }
      $leaksHere = ([regex]::Matches($rest, $escaped)).Count
      if ($leaksHere -gt 0) { $leaks += $leaksHere; $leakLines.Add($i + 1) }
    }
    [pscustomobject]@{ Name = $s.Name; Expected = $expected; Leaks = $leaks; LeakLines = $leakLines.ToArray() }
  }
  return $results
}

# URL do Prisma -> partes para o pg_dump, com a senha separada (vai por PGPASSWORD, não pela linha
# de comando).
function Split-PgUrl {
  param([Parameter(Mandatory)][string]$DatabaseUrl)
  $m = [regex]::Match($DatabaseUrl, '^postgres(?:ql)?://([^:@/]+)(?::([^@/]*))?@([^:/?]+)(?::(\d+))?/([^?]+)')
  if (-not $m.Success) { throw 'DATABASE_URL fora do formato postgresql://usuario:senha@host:porta/banco.' }
  [pscustomobject]@{
    User     = [uri]::UnescapeDataString($m.Groups[1].Value)
    Password = [uri]::UnescapeDataString($m.Groups[2].Value)
    Host     = $m.Groups[3].Value
    Port     = $(if ($m.Groups[4].Success) { $m.Groups[4].Value } else { '5432' })
    Database = $m.Groups[5].Value
  }
}

<#
  Confere o site pelo Caddy (só AVISO: não decide rollback). Primeiro pelo domínio público; se a
  rede do Azure não deixar a VM falar com o próprio IP público, pelo Caddy local (curl --resolve
  para 127.0.0.1, com o mesmo nome — o certificado continua sendo conferido).
#>
function Test-PublicSite {
  param([Parameter(Mandatory)][string]$PublicHost)
  $paths = @('/api/health', '/')
  $viaPublic = $true
  foreach ($p in $paths) {
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri "https://$PublicHost$p" -TimeoutSec 10; if ($r.StatusCode -ne 200) { $viaPublic = $false } } catch { $viaPublic = $false }
  }
  if ($viaPublic) { return "Site ok pelo domínio público (https://$PublicHost)." }
  $viaLocal = $true
  foreach ($p in $paths) {
    $code = & curl.exe -s -o NUL -w '%{http_code}' --max-time 10 --resolve "${PublicHost}:443:127.0.0.1" "https://$PublicHost$p"
    if ($code -ne '200') { $viaLocal = $false }
  }
  if ($viaLocal) {
    Write-RsdLog "O domínio público não respondeu de dentro da VM (rede do Azure?); pelo Caddy local, ok." 'WARN'
    return 'Site ok pelo Caddy local (domínio público sem resposta de dentro da VM).'
  }
  Write-RsdLog "O site não respondeu nem pelo domínio público nem pelo Caddy local (https://$PublicHost). O backend está ok; confira o Caddy." 'WARN'
  return 'Site sem resposta pelo Caddy (só aviso: o backend passou no health check).'
}

# ---------------------------------------------------------------------------------------------
# Log: console do job (e transcript) + resumo do GitHub Actions, quando houver.
# ---------------------------------------------------------------------------------------------
function Write-RsdLog {
  param([Parameter(Mandatory)][string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO')
  $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, $Message
  if ($Level -eq 'WARN') { Write-Host "::warning::$Message" } elseif ($Level -eq 'ERROR') { Write-Host "::error::$Message" }
  Write-Host $line
}

function Add-JobSummary {
  param([Parameter(Mandatory)][string]$Markdown)
  if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $Markdown -Encoding UTF8 }
}

function Add-DeployHistory {
  param([Parameter(Mandatory)]$Paths, [Parameter(Mandatory)][hashtable]$Entry)
  $Entry['at'] = (Get-Date).ToString('o')
  Add-Content -LiteralPath $Paths.History -Value ($Entry | ConvertTo-Json -Compress) -Encoding UTF8
}

# Um deploy (ou rollback) por vez: arquivo aberto com acesso exclusivo enquanto o script roda.
function Enter-DeployLock {
  param([Parameter(Mandatory)]$Paths)
  try {
    return [IO.File]::Open($Paths.Lock, 'OpenOrCreate', 'ReadWrite', 'None')
  } catch {
    throw 'Outro deploy ou rollback está em andamento nesta máquina.'
  }
}
