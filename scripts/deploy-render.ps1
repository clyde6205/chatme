<#
.SYNOPSIS
  Deploys the CHATme API to Render (temporary test host) from Windows PowerShell.

.DESCRIPTION
  Run from the repository root on branch claude/phase1-foundation:

    powershell -ExecutionPolicy Bypass -File scripts\deploy-render.ps1

  What it does, in order. It stops at the first failure.
    1. Checks the branch, that it matches GitHub, and that no secrets are committed.
    2. Collects secrets without echoing them: from environment variables of the same name,
       from the encrypted local cache, or from a hidden prompt. METRICS_TOKEN is generated
       with a cryptographic RNG. Secrets are cached per Windows user with DPAPI in
       %LOCALAPPDATA%\chatme\render-secrets.xml (outside the repo), so a rerun does not ask again.
    3. Checks with Resend that the EMAIL_FROM domain is verified (read-only, sends nothing).
    4. Builds the real Dockerfile and smoke-tests the image against a throwaway local Postgres.
    5. Runs the database migrations against Supabase (forward only, never drops anything).
    6. Boots the image locally with the production settings against Supabase as a preflight.
    7. Creates or updates the Render web service and its environment variables, deploys it,
       and follows the deploy until it is live or fails.
    8. Checks the live service: health, metrics guard, CORS, WebSocket upgrade.
    9. Adds the custom domain on Render and prints the DNS record to create.

  Render settings are fixed to the agreed configuration: Docker, apps/api/Dockerfile, build
  context = repo root, health check /health/ready, one instance, region ohio. Auto-deploy is off
  so that a deploy only happens through this script, which runs the migrations first (Render's
  free instance type has no Pre-Deploy Command).

.NOTES
  Secrets are never printed, logged, written to the repo, or passed on a command line.
#>
[CmdletBinding()]
param(
  [ValidateSet('free', 'starter', 'standard')] [string] $Plan = 'free',
  [ValidateSet('ohio', 'virginia', 'oregon', 'frankfurt', 'singapore')] [string] $Region = 'ohio',
  [string] $ServiceName = 'chatme-api',
  [string] $OwnerId,
  [string] $EmailFrom = 'CHATme <no-reply@mail.chatme.pro>',
  [string] $WebOrigins = 'https://chatme.pro,https://www.chatme.pro',
  [string] $WebBaseUrl = 'https://chatme.pro',
  [string] $ApiDomain = 'api.chatme.pro',
  [string] $TrustProxyHops = '1',
  # Base image override if Docker Hub rate-limits you, e.g. mirror.gcr.io/library/node:22-slim.
  [string] $NodeImage,
  # Skip the local Docker build, smoke test and preflight (migrations then need pnpm, or a paid plan).
  [switch] $SkipDocker,
  # Do not add the custom domain on Render.
  [switch] $NoCustomDomain,
  # Validate and plan only: no migrations, no Render changes.
  [switch] $DryRun,
  # Do not ask for the final confirmation.
  [switch] $Yes,
  # Delete the local secret cache and ask for every secret again.
  [switch] $ResetSecrets,
  [string] $ApiBase = 'https://api.render.com/v1',
  [string] $ResendApiBase = 'https://api.resend.com'
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($PSVersionTable.PSEdition -eq 'Desktop') {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$Branch = 'claude/phase1-foundation'
$RequiredCommit = 'decbc338'
$Image = 'chatme-api:render-test'
$HealthPath = '/health/ready'
$RealtimePath = '/v1/realtime'
$OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or ((Test-Path variable:IsWindows) -and $IsWindows)
$CacheFile = if ($OnWindows) { Join-Path $env:LOCALAPPDATA 'chatme\render-secrets.xml' } else { $null }
$Secrets = @{}
$Results = New-Object System.Collections.Generic.List[string]

# ---------------------------------------------------------------- output helpers

function Write-Step([string] $Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string] $Text) { Write-Host "    OK   $Text" -ForegroundColor Green; $Results.Add("PASS  $Text") }
function Write-Warn2([string] $Text) { Write-Host "    WARN $Text" -ForegroundColor Yellow; $Results.Add("WARN  $Text") }
function Write-Info([string] $Text) { foreach ($line in ($Text -split "`n")) { Write-Host "         $line" } }

# Replaces every known secret value in a message before it reaches the screen.
function Protect-Text([string] $Text) {
  if (-not $Text) { return $Text }
  foreach ($s in $Secrets.Values) {
    $p = Get-Plain $s
    if ($p -and $p.Length -ge 6) { $Text = $Text.Replace($p, '***') }
  }
  return $Text
}

function Stop-Deploy([string] $Text) {
  Write-Host ''
  Write-Host "BLOCKED: $(Protect-Text $Text)" -ForegroundColor Red
  Write-Summary
  exit 1
}

function Write-Summary {
  Write-Host ''
  Write-Host '---------------- summary ----------------'
  foreach ($r in $Results) { Write-Host $r }
}

# ---------------------------------------------------------------- secret helpers

function Get-Plain($Secure) {
  if ($null -eq $Secure) { return $null }
  return (New-Object System.Net.NetworkCredential('', $Secure)).Password
}

function New-Secure([string] $Plain) { return (ConvertTo-SecureString -String $Plain -AsPlainText -Force) }

function New-RandomToken {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-SecretCache {
  if (-not $CacheFile -or -not (Test-Path $CacheFile)) { return @{} }
  try { return [hashtable](Import-Clixml -Path $CacheFile -ErrorAction Stop) } catch { Write-Warn2 'Secret cache unreadable; asking again.'; return @{} }
}

function Save-SecretCache {
  if (-not $CacheFile) { return }
  $dir = Split-Path $CacheFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  # Export-Clixml encrypts SecureString values with DPAPI for the current Windows user.
  $Secrets | Export-Clixml -Path $CacheFile
}

# Environment variable of the same name, then the cache, then a hidden prompt.
function Get-Secret([string] $Name, [string] $Prompt, [hashtable] $Cache, [switch] $AllowEmpty) {
  $fromEnv = [Environment]::GetEnvironmentVariable($Name)
  if ($fromEnv) { Write-Info "$Name taken from the environment"; return (New-Secure $fromEnv) }
  if ($Cache.ContainsKey($Name) -and $Cache[$Name]) { Write-Info "$Name taken from the local encrypted cache"; return $Cache[$Name] }
  while ($true) {
    $value = Read-Host -AsSecureString -Prompt $Prompt
    if ($value.Length -gt 0) { return $value }
    if ($AllowEmpty) { return $null }
    Write-Host '    A value is required.' -ForegroundColor Yellow
  }
}

function Test-PostgresUrl([string] $Name, $Secure) {
  $u = $null
  $plain = Get-Plain $Secure
  if (-not ($plain -match '^postgres(ql)?://')) { Stop-Deploy "$Name must start with postgres:// or postgresql://" }
  try { $u = [Uri] $plain } catch { Stop-Deploy "$Name is not a valid URL" }
  if (-not $u.UserInfo -or -not $u.UserInfo.Contains(':')) { Stop-Deploy "$Name has no user:password part" }
  if ($u.Host -match '^(localhost|127\.|::1)') { Stop-Deploy "$Name points at localhost; it must be the Supabase connection string" }
  if ($plain -match '\[YOUR-PASSWORD\]') { Stop-Deploy "$Name still contains the [YOUR-PASSWORD] placeholder from Supabase" }
  if ($u.Host -notmatch 'supabase\.(co|com)$') { Write-Warn2 "$Name host is not a supabase.co/supabase.com host (host: $($u.Host))" }
  return $u
}

# ---------------------------------------------------------------- process helpers

function Invoke-Native([string] $Exe, [string[]] $ArgList, [switch] $Quiet, [switch] $AllowFail) {
  # Native tools write progress to stderr; Windows PowerShell 5.1 would turn that into a
  # terminating error under 'Stop', so failures are judged by exit code only.
  $ErrorActionPreference = 'Continue'
  $text = ''
  if ($Quiet) {
    $out = & $Exe @ArgList 2>&1
    $text = (($out | ForEach-Object { "$_" }) -join "`n").Trim()
  } else { & $Exe @ArgList }
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFail) {
    if ($text) { Write-Host (Protect-Text $text) }
    Stop-Deploy "$Exe $($ArgList[0]) failed (exit $code)"
  }
  return @{ Code = $code; Output = $text }
}

# Case-insensitive header lookup that works on Windows PowerShell 5.1 and PowerShell 7.
function Get-Header($Headers, [string] $Name) {
  if ($null -eq $Headers) { return $null }
  foreach ($k in @($Headers.Keys)) { if ($k -ieq $Name) { return (@($Headers[$k]) -join ',') } }
  return $null
}

# Sets secrets as process environment variables so `docker run -e NAME` can inherit them
# without the value ever appearing on a command line.
function Set-ProcessSecrets([string[]] $Names) {
  foreach ($n in $Names) { [Environment]::SetEnvironmentVariable($n, (Get-Plain $Secrets[$n]), 'Process') }
}
function Clear-ProcessSecrets([string[]] $Names) {
  foreach ($n in $Names) { [Environment]::SetEnvironmentVariable($n, $null, 'Process') }
}

function Get-Http([string] $Url, [hashtable] $Headers = @{}, [string] $Method = 'GET', [int] $TimeoutSec = 15) {
  try {
    $r = Invoke-WebRequest -Uri $Url -Method $Method -Headers $Headers -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
    return @{ Status = [int]$r.StatusCode; Body = [string]$r.Content; Headers = $r.Headers }
  } catch {
    $resp = $null
    if ($_.Exception.PSObject.Properties['Response']) { $resp = $_.Exception.Response }
    if ($null -ne $resp) {
      $body = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { '' }
      return @{ Status = [int]$resp.StatusCode; Body = [string]$body; Headers = @{} }
    }
    return @{ Status = 0; Body = $_.Exception.Message; Headers = @{} }
  }
}

function Wait-Ready([string] $BaseUrl, [int] $Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $last = Get-Http "$BaseUrl$HealthPath" -TimeoutSec 5
    if ($last.Status -eq 200) { return $last }
    Start-Sleep -Seconds 2
  }
  return $last
}

# Opens a WebSocket without credentials. The API must accept the upgrade and then close with 4001
# (unauthenticated), which proves the host passes WebSocket upgrades through.
function Test-WebSocket([string] $WsUrl) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $cts = New-Object System.Threading.CancellationTokenSource 15000
  try {
    $ws.ConnectAsync([Uri]$WsUrl, $cts.Token).Wait()
    $buf = New-Object 'System.ArraySegment[byte]' -ArgumentList (, (New-Object byte[] 4096))
    while ($ws.State -eq 'Open') {
      $res = $ws.ReceiveAsync($buf, $cts.Token).Result
      if ($res.MessageType -eq 'Close') { break }
    }
    return [int]$ws.CloseStatus
  } catch {
    return -1
  } finally { $ws.Dispose(); $cts.Dispose() }
}

# ---------------------------------------------------------------- Render API

function Invoke-Render([string] $Method, [string] $Path, $Body = $null) {
  $params = @{
    Method = $Method; Uri = "$ApiBase$Path"; UseBasicParsing = $true; ErrorAction = 'Stop'; TimeoutSec = 60
    Headers = @{ Authorization = "Bearer $(Get-Plain $Secrets['RENDER_API_KEY'])"; Accept = 'application/json' }
  }
  if ($null -ne $Body) {
    $params.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress))
    $params.ContentType = 'application/json'
  }
  try {
    $r = Invoke-WebRequest @params
    if ($r.Content) { return ($r.Content | ConvertFrom-Json) }
    return $null
  } catch {
    $code = 0
    if ($_.Exception.PSObject.Properties['Response'] -and $null -ne $_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    $detail = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { '' }
    if (-not $detail) { $detail = $_.Exception.Message }
    Stop-Deploy "Render API $Method $Path returned HTTP $code. $detail"
  }
}

function Get-Items($Response, [string] $Prop) {
  $list = @()
  foreach ($x in @($Response)) { if ($null -ne $x -and $x.PSObject.Properties[$Prop]) { $list += $x.$Prop } }
  return , $list
}

# =================================================================== 1. repository checks

Write-Step 'Checking the repository'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-Deploy 'git is not installed or not on PATH' }
$top = Invoke-Native git @('rev-parse', '--show-toplevel') -Quiet -AllowFail
if ($top.Code -ne 0 -or -not $top.Output) { Stop-Deploy 'Run this from inside the chatme repository' }
$root = $top.Output
Set-Location $root

$current = (& git branch --show-current).Trim()
if ($current -ne $Branch) { Stop-Deploy "Current branch is '$current'. This script deploys '$Branch' and does not switch branches. Run: git switch $Branch" }
Write-Ok "branch is $Branch"

$remote = (& git remote get-url origin).Trim()
if ($remote -notmatch 'github\.com[:/](.+?)(\.git)?$') { Stop-Deploy "origin is not a GitHub remote: $remote" }
$RepoUrl = "https://github.com/$($Matches[1])"
Write-Ok "repository is $RepoUrl"

Invoke-Native git @('fetch', '--quiet', 'origin', $Branch) | Out-Null
$head = (& git rev-parse HEAD).Trim()
$originHead = (& git rev-parse "origin/$Branch").Trim()
if ((Invoke-Native git @('merge-base', '--is-ancestor', $RequiredCommit, 'HEAD') -Quiet -AllowFail).Code -ne 0) { Stop-Deploy "HEAD does not contain commit $RequiredCommit. Run: git pull origin $Branch" }
if ($head -ne $originHead) {
  if ((Invoke-Native git @('merge-base', '--is-ancestor', 'HEAD', "origin/$Branch") -Quiet -AllowFail).Code -eq 0) { Stop-Deploy "Your local branch is behind GitHub. Run: git pull origin $Branch" }
  Stop-Deploy "Local HEAD $($head.Substring(0,8)) differs from GitHub $($originHead.Substring(0,8)). Render builds what is on GitHub; push or reset your local changes first."
}
Write-Ok "HEAD $($head.Substring(0,8)) matches GitHub and contains $RequiredCommit"

$dirty = (& git status --porcelain)
if ($dirty) { Write-Warn2 'Uncommitted local changes exist. Render builds the GitHub branch, not your working copy.' }

foreach ($f in @('apps/api/Dockerfile', 'apps/api/src/config.ts', 'apps/api/src/db/migrate-cli.ts', 'pnpm-lock.yaml')) {
  if (-not (Test-Path $f)) { Stop-Deploy "Missing $f" }
}

# Secret-commit check: tracked .env files and well-known key formats. Prints locations only.
$envFiles = @(& git ls-files | Where-Object { $_ -match '(^|/)\.env($|\.)' -and $_ -notmatch '\.env\.example$' })
if ($envFiles.Count -gt 0) { Stop-Deploy "Tracked env files found: $($envFiles -join ', '). Remove them from git." }
$pattern = 're_[A-Za-z0-9_]{20,}|rnd_[A-Za-z0-9]{16,}|sk-(proj-)?[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]+@'
$grep = Invoke-Native git @('grep', '-I', '-n', '-E', $pattern, '--', '.', ':!pnpm-lock.yaml') -Quiet -AllowFail
$hits = @($grep.Output -split "`n" | Where-Object { $_ } | Where-Object { $_ -notmatch '@(localhost|127\.0\.0\.1|postgres|db)[:/]' })
if ($hits.Count -gt 0) {
  $locations = $hits | ForEach-Object { ($_ -split ':')[0..1] -join ':' }
  Stop-Deploy "Possible committed secrets at: $($locations -join ', ')"
}
Write-Ok 'no committed secrets or .env files found'

# =================================================================== 2. secrets

Write-Step 'Collecting secrets (input is hidden; nothing is printed)'
if ($ResetSecrets -and $CacheFile -and (Test-Path $CacheFile)) { Remove-Item $CacheFile; Write-Info 'Local secret cache deleted' }
$cache = Read-SecretCache
if (-not $CacheFile) { Write-Warn2 'Not on Windows: secrets are not cached between runs' }

$Secrets['RENDER_API_KEY'] = Get-Secret 'RENDER_API_KEY' 'Render API key (Render dashboard > Account Settings > API Keys)' $cache
if ((Get-Plain $Secrets['RENDER_API_KEY']) -notmatch '^rnd_') { Write-Warn2 'RENDER_API_KEY does not start with rnd_' }

$Secrets['DATABASE_URL'] = Get-Secret 'DATABASE_URL' 'Supabase DATABASE_URL (transaction pooler :6543 or direct)' $cache
$dbUri = Test-PostgresUrl 'DATABASE_URL' $Secrets['DATABASE_URL']

$rt = Get-Secret 'REALTIME_DATABASE_URL' 'Supabase REALTIME_DATABASE_URL (session pooler or direct, port 5432; Enter = same as DATABASE_URL)' $cache -AllowEmpty
if ($null -eq $rt) {
  if ($dbUri.Port -eq 6543) { Stop-Deploy 'DATABASE_URL uses the transaction pooler (6543); REALTIME_DATABASE_URL is required (session pooler or direct, port 5432)' }
  $rt = $Secrets['DATABASE_URL']
}
$Secrets['REALTIME_DATABASE_URL'] = $rt
$rtUri = Test-PostgresUrl 'REALTIME_DATABASE_URL' $rt
if ($rtUri.Port -eq 6543) { Stop-Deploy 'REALTIME_DATABASE_URL uses port 6543 (transaction pooler); LISTEN/NOTIFY needs the session pooler or direct connection (5432)' }

$mig = Get-Secret 'MIGRATION_DATABASE_URL' 'Supabase MIGRATION_DATABASE_URL (direct connection; Enter = same as REALTIME_DATABASE_URL)' $cache -AllowEmpty
if ($null -eq $mig) { $mig = $Secrets['REALTIME_DATABASE_URL'] }
$Secrets['MIGRATION_DATABASE_URL'] = $mig
$migUri = Test-PostgresUrl 'MIGRATION_DATABASE_URL' $mig
if ($migUri.Port -eq 6543) { Stop-Deploy 'MIGRATION_DATABASE_URL uses the transaction pooler (6543); use the direct connection or session pooler' }

$Secrets['RESEND_API_KEY'] = Get-Secret 'RESEND_API_KEY' 'Resend API key' $cache
if ((Get-Plain $Secrets['RESEND_API_KEY']) -notmatch '^re_') { Write-Warn2 'RESEND_API_KEY does not start with re_' }

if ($env:METRICS_TOKEN) { $Secrets['METRICS_TOKEN'] = New-Secure $env:METRICS_TOKEN; Write-Info 'METRICS_TOKEN taken from the environment' }
elseif ($cache.ContainsKey('METRICS_TOKEN') -and $cache['METRICS_TOKEN']) { $Secrets['METRICS_TOKEN'] = $cache['METRICS_TOKEN']; Write-Info 'METRICS_TOKEN taken from the local encrypted cache' }
else { $Secrets['METRICS_TOKEN'] = New-Secure (New-RandomToken); Write-Info 'METRICS_TOKEN generated (256-bit, cryptographic RNG)' }
if ((Get-Plain $Secrets['METRICS_TOKEN']).Length -lt 24) { Stop-Deploy 'METRICS_TOKEN must be at least 24 characters' }

Save-SecretCache
Write-Ok 'all required secrets present and well-formed'

# =================================================================== 3. config values

Write-Step 'Checking non-secret settings'
$origins = $WebOrigins.Split(',') | ForEach-Object { $_.Trim() }
foreach ($o in $origins) { if ($o -notmatch '^https://[^/]+$') { Stop-Deploy "WEB_ORIGINS entry '$o' must be an https origin with no path" } }
if ($WebBaseUrl -notmatch '^https://') { Stop-Deploy 'WEB_BASE_URL must be https://' }
if ($EmailFrom -notmatch '@([A-Za-z0-9.-]+)>?\s*$') { Stop-Deploy "EMAIL_FROM '$EmailFrom' has no domain" }
$emailDomain = $Matches[1].ToLower()
if ($emailDomain -eq 'localhost') { Stop-Deploy 'EMAIL_FROM must use a domain verified in Resend' }
Write-Ok "WEB_ORIGINS=$WebOrigins WEB_BASE_URL=$WebBaseUrl EMAIL_FROM domain=$emailDomain"

$EnvVars = [ordered]@{
  NODE_ENV               = 'production'
  PORT                   = '8080'
  DATABASE_SSL           = 'require'
  COOKIE_SECURE          = 'true'
  WEB_ORIGINS            = $WebOrigins
  WEB_BASE_URL           = $WebBaseUrl
  EMAIL_PROVIDER         = 'resend'
  EMAIL_FROM             = $EmailFrom
  TRUST_PROXY_HOPS       = $TrustProxyHops
  DATABASE_URL           = $null
  REALTIME_DATABASE_URL  = $null
  MIGRATION_DATABASE_URL = $null
  RESEND_API_KEY         = $null
  METRICS_TOKEN          = $null
}
$SecretNames = @('DATABASE_URL', 'REALTIME_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'RESEND_API_KEY', 'METRICS_TOKEN')

# =================================================================== 4. Resend domain

Write-Step "Checking with Resend that $emailDomain is verified (read-only)"
$resend = Get-Http "$ResendApiBase/domains" @{ Authorization = "Bearer $(Get-Plain $Secrets['RESEND_API_KEY'])" }
if ($resend.Status -eq 200) {
  $domains = @(($resend.Body | ConvertFrom-Json).data)
  $match = $domains | Where-Object { $_.name -eq $emailDomain } | Select-Object -First 1
  if (-not $match) {
    $names = ($domains | ForEach-Object { "$($_.name) ($($_.status))" }) -join ', '
    Stop-Deploy "Domain $emailDomain is not in your Resend account. Domains there: $names. Rerun with -EmailFrom 'CHATme <no-reply@YOUR-VERIFIED-DOMAIN>'"
  }
  if ($match.status -ne 'verified') { Stop-Deploy "Resend domain $emailDomain has status '$($match.status)', not verified. Finish DNS verification in Resend first." }
  Write-Ok "Resend domain $emailDomain is verified"
} elseif ($resend.Status -eq 401 -or $resend.Status -eq 403) {
  Write-Warn2 'This Resend key cannot list domains (sending-only key), so the domain could not be checked.'
  if (-not $Yes) {
    $ans = Read-Host "Is $emailDomain verified in Resend? Type YES to continue"
    if ($ans -ne 'YES') { Stop-Deploy 'Stopped: Resend domain not confirmed' }
  }
} else {
  Stop-Deploy "Resend API check failed: HTTP $($resend.Status) $($resend.Body)"
}

# =================================================================== 5. Render account

Write-Step 'Checking the Render API key'
$owners = Get-Items (Invoke-Render GET '/owners?limit=50') 'owner'
if ($owners.Count -eq 0) { Stop-Deploy 'The Render API key has no workspaces' }
if ($OwnerId) {
  $owner = $owners | Where-Object { $_.id -eq $OwnerId } | Select-Object -First 1
  if (-not $owner) { Stop-Deploy "Workspace $OwnerId not found for this API key" }
} elseif ($owners.Count -eq 1) {
  $owner = $owners[0]
} else {
  Write-Host '    Workspaces:'
  for ($i = 0; $i -lt $owners.Count; $i++) { Write-Host "      [$i] $($owners[$i].name) ($($owners[$i].id))" }
  $pick = Read-Host 'Number of the workspace to deploy into'
  $owner = $owners[[int]$pick]
}
Write-Ok "Render workspace: $($owner.name) ($($owner.id))"

$existing = Get-Items (Invoke-Render GET "/services?name=$([Uri]::EscapeDataString($ServiceName))&ownerId=$($owner.id)&limit=20") 'service'
$service = $existing | Where-Object { $_.name -eq $ServiceName } | Select-Object -First 1
if ($service) {
  Write-Ok "service $ServiceName exists ($($service.id)); it will be updated and redeployed"
  $d = $service.serviceDetails
  if ($service.type -ne 'web_service') { Stop-Deploy "$ServiceName exists but is a $($service.type), not a web service" }
  if ($service.branch -ne $Branch) { Write-Warn2 "service branch is '$($service.branch)', expected '$Branch' (change it in the dashboard)" }
  if ($d.runtime -ne 'docker') { Stop-Deploy "service runtime is '$($d.runtime)', expected docker" }
  if ($d.PSObject.Properties['healthCheckPath'] -and $d.healthCheckPath -ne $HealthPath) { Write-Warn2 "health check path is '$($d.healthCheckPath)', expected $HealthPath" }
  if ($d.numInstances -gt 1) { Write-Warn2 'service runs more than one instance; presence needs exactly one on Render' }
  $edd = $d.envSpecificDetails
  if ($edd -and $edd.dockerfilePath -notmatch '^(\./)?apps/api/Dockerfile$') { Write-Warn2 "Dockerfile path is '$($edd.dockerfilePath)', expected ./apps/api/Dockerfile" }
} else {
  Write-Info "service $ServiceName does not exist yet; it will be created"
}

# =================================================================== 6. local Docker build + smoke test

$haveDocker = $false
if (-not $SkipDocker) {
  Write-Step 'Building the API image with apps/api/Dockerfile'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Deploy 'Docker is not installed. Start Docker Desktop, or rerun with -SkipDocker.' }
  $info = Invoke-Native docker @('info', '--format', '{{.ServerVersion}}') -Quiet -AllowFail
  if ($info.Code -ne 0) { Stop-Deploy 'Docker is installed but not running. Start Docker Desktop and rerun.' }
  $env:DOCKER_BUILDKIT = '1'
  $buildArgs = @('build', '-f', 'apps/api/Dockerfile', '-t', $Image)
  if ($NodeImage) { $buildArgs += @('--build-arg', "NODE_IMAGE=$NodeImage") }
  Invoke-Native docker ($buildArgs + '.') | Out-Null
  Write-Ok "image $Image built from the real Dockerfile"
  $haveDocker = $true

  Write-Step 'Smoke-testing the image against a throwaway local Postgres'
  $tag = "chatme-smoke-$PID"
  $net = "$tag-net"; $db = "$tag-db"; $api = "$tag-api"
  $localDb = "postgres://chatme:chatme@${db}:5432/chatme"
  try {
    Invoke-Native docker @('network', 'create', $net) -Quiet | Out-Null
    Invoke-Native docker @('run', '-d', '--name', $db, '--network', $net, '-e', 'POSTGRES_USER=chatme', '-e', 'POSTGRES_PASSWORD=chatme', '-e', 'POSTGRES_DB=chatme', 'postgres:16') -Quiet | Out-Null
    $ready = $false
    for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
      Start-Sleep -Seconds 1
      $r = Invoke-Native docker @('exec', $db, 'pg_isready', '-h', '127.0.0.1', '-U', 'chatme', '-d', 'chatme') -Quiet -AllowFail
      $ready = ($r.Code -eq 0)
    }
    if (-not $ready) { Stop-Deploy 'Local Postgres did not start' }
    Invoke-Native docker @('run', '--rm', '--network', $net, '-e', "DATABASE_URL=$localDb", $Image, 'node', 'dist/migrate.js', 'latest') -Quiet | Out-Null
    Write-Ok 'migrations apply cleanly on an empty database'
    Invoke-Native docker @('run', '-d', '--name', $api, '--network', $net, '-p', '127.0.0.1:18080:8080', '-e', 'NODE_ENV=development', '-e', "DATABASE_URL=$localDb", '-e', 'EMAIL_PROVIDER=log', $Image) -Quiet | Out-Null
    $h = Wait-Ready 'http://127.0.0.1:18080' 60
    if ($h.Status -ne 200) {
      Write-Host (Invoke-Native docker @('logs', '--tail', '40', $api) -Quiet -AllowFail).Output
      Stop-Deploy "Local container not ready: HTTP $($h.Status) $($h.Body)"
    }
    Write-Ok "local container ready: $($h.Body)"
    $code = Test-WebSocket "ws://127.0.0.1:18080$RealtimePath"
    if ($code -ne 4001) { Stop-Deploy "Local WebSocket check: expected close code 4001 (unauthenticated), got $code" }
    Write-Ok 'local WebSocket upgrade works (unauthenticated socket closed with 4001)'
    Invoke-Native docker @('stop', '-t', '30', $api) -Quiet | Out-Null
    $exit = (Invoke-Native docker @('inspect', '-f', '{{.State.ExitCode}}', $api) -Quiet).Output
    if ($exit -ne '0') { Stop-Deploy "Container exited with code $exit on SIGTERM (expected 0)" }
    Write-Ok 'graceful shutdown on SIGTERM exits 0'
  } finally {
    Invoke-Native docker @('rm', '-f', $api, $db) -Quiet -AllowFail | Out-Null
    Invoke-Native docker @('network', 'rm', $net) -Quiet -AllowFail | Out-Null
  }
}

if ($DryRun) {
  Write-Step 'Dry run: planned Render configuration (secrets redacted)'
  Write-Info "service=$ServiceName type=web_service runtime=docker plan=$Plan region=$Region instances=1 branch=$Branch autoDeploy=no"
  Write-Info "dockerfilePath=./apps/api/Dockerfile dockerContext=. healthCheckPath=$HealthPath"
  foreach ($k in $EnvVars.Keys) { if ($SecretNames -contains $k) { Write-Info "$k=(secret, set)" } else { Write-Info "$k=$($EnvVars[$k])" } }
  Write-Ok 'dry run finished; no migrations run and nothing changed on Render'
  Write-Summary
  exit 0
}

# =================================================================== 7. confirmation

Write-Host ''
Write-Host "Ready to: migrate the Supabase database (forward only), then $(if ($service) { 'update and redeploy' } else { 'create' }) Render service '$ServiceName' ($Plan, $Region, 1 instance) from $Branch @ $($head.Substring(0,8))."
if (-not $Yes) {
  $ans = Read-Host 'Type YES to continue'
  if ($ans -ne 'YES') { Stop-Deploy 'Stopped at confirmation; nothing was changed' }
}

# =================================================================== 8. migrations on Supabase

Write-Step 'Running database migrations on Supabase (node dist/migrate.js latest)'
$migrated = $false
try {
  if ($haveDocker) {
    Set-ProcessSecrets @('MIGRATION_DATABASE_URL')
    $m = Invoke-Native docker @('run', '--rm', '-e', 'MIGRATION_DATABASE_URL', '-e', 'DATABASE_SSL=require', $Image, 'node', 'dist/migrate.js', 'latest') -Quiet -AllowFail
    if ($m.Code -ne 0) { Stop-Deploy "Migrations failed: $($m.Output)" }
    Write-Info (Protect-Text $m.Output)
    $migrated = $true
  } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
    Set-ProcessSecrets @('MIGRATION_DATABASE_URL')
    $env:DATABASE_SSL = 'require'
    Invoke-Native pnpm @('install', '--frozen-lockfile') | Out-Null
    $m = Invoke-Native pnpm @('db:migrate') -Quiet -AllowFail
    if ($m.Code -ne 0) { Stop-Deploy "Migrations failed: $($m.Output)" }
    Write-Info (Protect-Text $m.Output)
    $migrated = $true
  } elseif ($Plan -ne 'free') {
    Write-Warn2 'No Docker or pnpm here; relying on the Render Pre-Deploy Command for migrations'
  } else {
    Stop-Deploy 'Migrations need Docker or pnpm on this machine (the free plan has no Pre-Deploy Command)'
  }
} finally {
  Clear-ProcessSecrets @('MIGRATION_DATABASE_URL')
  Remove-Item Env:DATABASE_SSL -ErrorAction SilentlyContinue
}
if ($migrated) { Write-Ok 'Supabase schema is at the latest migration' }

# =================================================================== 9. production preflight

if ($haveDocker) {
  Write-Step 'Preflight: booting the image locally with the production settings against Supabase'
  $pf = "chatme-preflight-$PID"
  $passNames = @('DATABASE_URL', 'REALTIME_DATABASE_URL', 'RESEND_API_KEY', 'METRICS_TOKEN')
  $runArgs = @('run', '-d', '--name', $pf, '-p', '127.0.0.1:18081:8080', '-e', 'WORKERS_ENABLED=false')
  foreach ($k in $EnvVars.Keys) {
    if ($k -eq 'MIGRATION_DATABASE_URL') { continue }
    if ($SecretNames -contains $k) { $runArgs += @('-e', $k) } else { $runArgs += @('-e', "$k=$($EnvVars[$k])") }
  }
  $runArgs += $Image
  try {
    Set-ProcessSecrets $passNames
    Invoke-Native docker $runArgs -Quiet | Out-Null
    $h = Wait-Ready 'http://127.0.0.1:18081' 45
    if ($h.Status -ne 200) {
      $logs = (Invoke-Native docker @('logs', '--tail', '40', $pf) -Quiet -AllowFail).Output
      Write-Host (Protect-Text $logs)
      Stop-Deploy "Production preflight failed: HTTP $($h.Status) $($h.Body)"
    }
    $j = $h.Body | ConvertFrom-Json
    if (-not $j.checks.realtime.ok) { Write-Warn2 'preflight: realtime bus not connected (check REALTIME_DATABASE_URL)' } else { Write-Ok 'preflight: realtime LISTEN/NOTIFY connected to Supabase' }
    Write-Ok "preflight: production config accepted and Supabase reachable over TLS (db latency $($j.checks.database.latencyMs) ms from this PC)"
  } finally {
    Clear-ProcessSecrets $passNames
    Invoke-Native docker @('stop', '-t', '30', $pf) -Quiet -AllowFail | Out-Null
    Invoke-Native docker @('rm', '-f', $pf) -Quiet -AllowFail | Out-Null
  }
}

# =================================================================== 10. Render service + env vars

Write-Step 'Configuring the Render service'
$deployId = $null
if (-not $service) {
  $envList = @()
  foreach ($k in $EnvVars.Keys) {
    $v = $EnvVars[$k]
    if ($SecretNames -contains $k) { $v = Get-Plain $Secrets[$k] }
    $envList += @{ key = $k; value = $v }
  }
  $details = [ordered]@{
    runtime            = 'docker'
    plan               = $Plan
    region             = $Region
    numInstances       = 1
    healthCheckPath    = $HealthPath
    envSpecificDetails = [ordered]@{ dockerfilePath = './apps/api/Dockerfile'; dockerContext = '.' }
  }
  # Render runs Pre-Deploy Commands only on paid instance types; on free the script migrated above.
  if ($Plan -ne 'free') { $details.preDeployCommand = 'node dist/migrate.js latest' }
  $body = [ordered]@{
    type           = 'web_service'
    name           = $ServiceName
    ownerId        = $owner.id
    repo           = $RepoUrl
    branch         = $Branch
    autoDeploy     = 'no'
    envVars        = $envList
    serviceDetails = $details
  }
  $created = Invoke-Render POST '/services' $body
  $service = $created.service
  if ($created.PSObject.Properties['deployId']) { $deployId = $created.deployId }
  Write-Ok "created service $ServiceName ($($service.id))"
} else {
  foreach ($k in $EnvVars.Keys) {
    $v = $EnvVars[$k]
    if ($SecretNames -contains $k) { $v = Get-Plain $Secrets[$k] }
    Invoke-Render PUT "/services/$($service.id)/env-vars/$k" @{ value = $v } | Out-Null
  }
  Write-Ok "updated $($EnvVars.Count) environment variables (others on the service left untouched)"
}
Write-Info "Dashboard: $($service.dashboardUrl)"

if (-not $deployId) {
  $dep = Invoke-Render POST "/services/$($service.id)/deploys" @{}
  if ($dep -and $dep.PSObject.Properties['id']) { $deployId = $dep.id }
  else {
    $latest = Get-Items (Invoke-Render GET "/services/$($service.id)/deploys?limit=1") 'deploy'
    if ($latest.Count -gt 0) { $deployId = $latest[0].id }
  }
}
if (-not $deployId) { Stop-Deploy 'Render did not return a deploy id' }

# =================================================================== 11. follow the deploy

Write-Step "Following deploy $deployId (Docker builds on Render can take several minutes)"
$failed = @('build_failed', 'update_failed', 'canceled', 'pre_deploy_failed', 'deactivated')
$deadline = (Get-Date).AddMinutes(30)
$status = ''
while ((Get-Date) -lt $deadline) {
  $d = Invoke-Render GET "/services/$($service.id)/deploys/$deployId"
  if ($d.status -ne $status) { $status = $d.status; Write-Info "$(Get-Date -Format HH:mm:ss) $status" }
  if ($status -eq 'live') { break }
  if ($failed -contains $status) { Stop-Deploy "Deploy ended with status '$status'. Open the Logs tab: $($service.dashboardUrl)" }
  Start-Sleep -Seconds 10
}
if ($status -ne 'live') { Stop-Deploy "Deploy not live after 30 minutes (last status '$status'). Check $($service.dashboardUrl)" }
Write-Ok "deploy $deployId is live"

# =================================================================== 12. verify the live service

Write-Step 'Verifying the live service'
$service = Invoke-Render GET "/services/$($service.id)"
$url = $service.serviceDetails.url.TrimEnd('/')
$renderHost = ([Uri]$url).Host
Write-Info "Render URL (for testing only; clients use https://$ApiDomain): $url"

$live = Get-Http "$url/health/live" -TimeoutSec 60
if ($live.Status -ne 200) { Stop-Deploy "GET /health/live returned HTTP $($live.Status)" }
Write-Ok 'GET /health/live 200'

$ready = Get-Http "$url$HealthPath" -TimeoutSec 30
if ($ready.Status -ne 200) { Stop-Deploy "GET $HealthPath returned HTTP $($ready.Status): $($ready.Body)" }
$rj = $ready.Body | ConvertFrom-Json
Write-Ok "GET $HealthPath 200, database ok ($($rj.checks.database.latencyMs) ms)"
if ($rj.checks.realtime.ok) { Write-Ok 'realtime bus connected on Render' } else { Write-Warn2 'realtime bus not connected on Render (check REALTIME_DATABASE_URL)' }

$m1 = Get-Http "$url/metrics"
if ($m1.Status -eq 401) { Write-Ok '/metrics refuses requests without the token (401)' } else { Write-Warn2 "/metrics without token returned HTTP $($m1.Status), expected 401" }
$m2 = Get-Http "$url/metrics" @{ Authorization = "Bearer $(Get-Plain $Secrets['METRICS_TOKEN'])" }
if ($m2.Status -eq 200) { Write-Ok '/metrics accepts the generated METRICS_TOKEN' } else { Write-Warn2 "/metrics with token returned HTTP $($m2.Status)" }

$origin = $origins[0]
$cors = Get-Http "$url/v1/auth/login" @{ Origin = $origin; 'Access-Control-Request-Method' = 'POST'; 'Access-Control-Request-Headers' = 'content-type,x-chatme-csrf' } 'OPTIONS'
$acao = Get-Header $cors.Headers 'Access-Control-Allow-Origin'
if ($acao -eq $origin) { Write-Ok "CORS allows $origin" } else { Write-Warn2 "CORS preflight from $origin returned HTTP $($cors.Status), allow-origin '$acao'" }

$wsScheme = if ($url.StartsWith('https://')) { 'wss' } else { 'ws' }
$ws = Test-WebSocket "${wsScheme}://$(([Uri]$url).Authority)$RealtimePath"
if ($ws -eq 4001) { Write-Ok 'Render passes WebSocket upgrades (unauthenticated socket closed with 4001)' } else { Write-Warn2 "WebSocket check returned close code $ws, expected 4001" }

# =================================================================== 13. custom domain

if (-not $NoCustomDomain) {
  Write-Step "Custom domain $ApiDomain"
  $domains = Get-Items (Invoke-Render GET "/services/$($service.id)/custom-domains?limit=20") 'customDomain'
  $cd = $domains | Where-Object { $_.name -eq $ApiDomain } | Select-Object -First 1
  if (-not $cd) {
    $null = Invoke-Render POST "/services/$($service.id)/custom-domains" @{ name = $ApiDomain }
    $domains = Get-Items (Invoke-Render GET "/services/$($service.id)/custom-domains?limit=20") 'customDomain'
    $cd = $domains | Where-Object { $_.name -eq $ApiDomain } | Select-Object -First 1
    Write-Ok "added $ApiDomain to the Render service"
  }
  $label = $ApiDomain.Split('.')[0]
  Write-Host ''
  Write-Host '    Create this DNS record at the DNS provider for chatme.pro:' -ForegroundColor White
  Write-Host "      Type: CNAME   Name: $label   Value: $renderHost   TTL: auto/300" -ForegroundColor White
  Write-Host '      (If chatme.pro uses Cloudflare, set this record to "DNS only", not proxied.)'
  $resolved = $null
  if (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue) {
    try { $resolved = (Resolve-DnsName -Name $ApiDomain -Type CNAME -DnsOnly -ErrorAction Stop | Where-Object { $_.Type -eq 'CNAME' } | Select-Object -First 1).NameHost } catch { $resolved = $null }
  }
  if ($resolved -and $resolved.TrimEnd('.') -eq $renderHost) {
    Write-Ok "DNS: $ApiDomain is a CNAME to $renderHost"
    if ($cd -and $cd.verificationStatus -ne 'verified') { $null = Invoke-Render POST "/services/$($service.id)/custom-domains/$($cd.id)/verify" @{} }
    $viaDomain = Get-Http "https://$ApiDomain$HealthPath" -TimeoutSec 30
    if ($viaDomain.Status -eq 200) { Write-Ok "https://$ApiDomain$HealthPath 200 (certificate issued)" }
    else { Write-Warn2 "https://$ApiDomain not serving yet (HTTP $($viaDomain.Status)); Render issues the certificate after verification. Rerun later to recheck." }
  } elseif ($resolved) {
    Write-Warn2 "DNS: $ApiDomain is a CNAME to $resolved, not $renderHost"
  } else {
    Write-Warn2 "DNS: no CNAME for $ApiDomain yet. Create the record above, then rerun this script to verify."
  }
}

Write-Summary
Write-Host ''
Write-Host "Service: $($service.dashboardUrl)"
Write-Host 'METRICS_TOKEN is stored only in Render and in your encrypted local cache. It was not printed.'
