[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

function Read-EnvFile([string]$path) {
  $result = @{}
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $result[$Matches[1]] = $Matches[2]
    }
  }
  return $result
}

function New-RandomBytes([int]$byteCount) {
  $bytes = New-Object byte[] $byteCount
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  return ,$bytes
}

function New-HexSecret([int]$byteCount) {
  return ([BitConverter]::ToString((New-RandomBytes $byteCount))).Replace('-', '').ToLowerInvariant()
}

function Set-EnvValue([string]$key, [string]$value) {
  $escaped = [regex]::Escape($key)
  for ($i = 0; $i -lt $script:envLines.Count; $i++) {
    if ($script:envLines[$i] -match "^$escaped=") {
      $script:envLines[$i] = "$key=$value"
      return
    }
  }
  $script:envLines.Add("$key=$value")
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is required.' }
if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) { throw 'Supabase CLI is required.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running.' }

$envPath = Join-Path $projectRoot '.env.development'
$templatePath = Join-Path $projectRoot '.env.development.example'
if (-not (Test-Path $envPath)) {
  Copy-Item $templatePath $envPath
  Write-Host "Created $envPath"
}
$script:envLines = [System.Collections.Generic.List[string]](Get-Content $envPath)
$current = Read-EnvFile $envPath

foreach ($key in @('ADMIN_EMAIL', 'ADMIN_PASSWORD')) {
  if (-not $current.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($current[$key])) {
    throw "Set $key in .env.development before setup."
  }
}
if ($current['ADMIN_PASSWORD'] -eq 'change-me-development-password' -or $current['ADMIN_PASSWORD'].Length -lt 12) {
  throw 'Replace ADMIN_PASSWORD with a development password of at least 12 characters.'
}

if (-not $current['AUTH_JWT_SECRET'] -or $current['AUTH_JWT_SECRET'].Length -lt 32) {
  Set-EnvValue 'AUTH_JWT_SECRET' (New-HexSecret 32)
}
foreach ($key in @('LANGFUSE_POSTGRES_PASSWORD', 'LANGFUSE_CLICKHOUSE_PASSWORD', 'LANGFUSE_REDIS_PASSWORD', 'LANGFUSE_MINIO_ROOT_PASSWORD', 'LANGFUSE_NEXTAUTH_SECRET', 'LANGFUSE_SALT')) {
  if (-not $current[$key]) { Set-EnvValue $key (New-HexSecret 24) }
}
if (-not $current['LANGFUSE_ENCRYPTION_KEY']) { Set-EnvValue 'LANGFUSE_ENCRYPTION_KEY' (New-HexSecret 32) }
if (-not $current['LANGFUSE_PUBLIC_KEY']) { Set-EnvValue 'LANGFUSE_PUBLIC_KEY' "pk-lf-$([Guid]::NewGuid())" }
if (-not $current['LANGFUSE_SECRET_KEY']) { Set-EnvValue 'LANGFUSE_SECRET_KEY' "sk-lf-$([Guid]::NewGuid())" }

[IO.File]::WriteAllLines($envPath, $script:envLines, [Text.UTF8Encoding]::new($false))
$envMap = Read-EnvFile $envPath
foreach ($key in $envMap.Keys) { Set-Item "Env:$key" $envMap[$key] }
$env:DOTENV_CONFIG_PATH = $envPath

$devDbVolumes = @(docker volume ls -q --filter 'label=com.supabase.cli.project=ownagent-dev')
$freshDevDb = $devDbVolumes.Count -eq 0
supabase start --workdir $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Supabase CLI failed to start.' }

if ($freshDevDb) {
  supabase db reset --workdir $projectRoot --local --yes
} else {
  supabase migration up --workdir $projectRoot --local
}
if ($LASTEXITCODE -ne 0) { throw 'Could not apply the development database migrations.' }

$statusErrorPath = [IO.Path]::GetTempFileName()
$statusErrorAction = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  $statusLines = supabase status --workdir $projectRoot -o env 2> $statusErrorPath
  $statusExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $statusErrorAction
  $statusError = if (Test-Path $statusErrorPath) { Get-Content $statusErrorPath } else { @() }
  Remove-Item -LiteralPath $statusErrorPath -Force -ErrorAction SilentlyContinue
}
if ($statusExitCode -ne 0) {
  if ($statusError.Count -gt 0) { Write-Warning ($statusError -join ' ') }
  throw 'Could not read local Supabase credentials.'
}
$status = @{}
foreach ($line in $statusLines) {
  if ($line -match '^([A-Z0-9_]+)="(.*)"$') { $status[$Matches[1]] = $Matches[2] }
}
foreach ($key in @('API_URL', 'DB_URL', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'STORAGE_S3_URL', 'S3_PROTOCOL_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_SECRET')) {
  if (-not $status.ContainsKey($key)) { throw "Supabase status did not return $key." }
}
$secretKey = if ($status.ContainsKey('SECRET_KEY') -and $status['SECRET_KEY']) {
  $status['SECRET_KEY']
} else {
  $status['SERVICE_ROLE_KEY']
}
$publishableKey = if ($status.ContainsKey('PUBLISHABLE_KEY') -and $status['PUBLISHABLE_KEY']) {
  $status['PUBLISHABLE_KEY']
} else {
  $status['ANON_KEY']
}
Set-EnvValue 'SUPABASE_URL' $status['API_URL']
Set-EnvValue 'SUPABASE_PUBLIC_URL' $status['API_URL']
Set-EnvValue 'DATABASE_URL' $status['DB_URL']
Set-EnvValue 'SUPABASE_JWT_SECRET' $status['JWT_SECRET']
Set-EnvValue 'SUPABASE_ANON_JWT_KEY' $status['ANON_KEY']
Set-EnvValue 'SUPABASE_SERVICE_ROLE_JWT_KEY' $status['SERVICE_ROLE_KEY']
Set-EnvValue 'SUPABASE_SERVICE_ROLE_KEY' $secretKey
Set-EnvValue 'SUPABASE_PUBLISHABLE_KEY' $publishableKey
Set-EnvValue 'SUPABASE_S3_ENDPOINT' $status['STORAGE_S3_URL']
Set-EnvValue 'SUPABASE_S3_PUBLIC_ENDPOINT' $status['STORAGE_S3_URL']
Set-EnvValue 'SUPABASE_S3_ACCESS_KEY' $status['S3_PROTOCOL_ACCESS_KEY_ID']
Set-EnvValue 'SUPABASE_S3_SECRET_KEY' $status['S3_PROTOCOL_ACCESS_KEY_SECRET']
$s3Region = 'local'
if ($status.ContainsKey('S3_PROTOCOL_REGION') -and $status['S3_PROTOCOL_REGION']) {
  $s3Region = $status['S3_PROTOCOL_REGION']
}
Set-EnvValue 'SUPABASE_S3_REGION' $s3Region
[IO.File]::WriteAllLines($envPath, $script:envLines, [Text.UTF8Encoding]::new($false))
$envMap = Read-EnvFile $envPath
foreach ($key in $envMap.Keys) { Set-Item "Env:$key" $envMap[$key] }

docker compose -f docker-compose.dev.yml --env-file $envPath up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'Development Redis/Langfuse failed to start.' }

npm run seed:dev
if ($LASTEXITCODE -ne 0) { throw 'Development seed failed.' }

Write-Host ''
Write-Host 'Development environment is ready.' -ForegroundColor Green
Write-Host 'Run npm run start:dev for API and workers.'
Write-Host 'Run npm --prefix ..\ownagentweb run dev for the frontend.'
Write-Host 'API:      http://127.0.0.1:8787'
Write-Host 'Frontend: http://127.0.0.1:5173'
Write-Host 'Studio:   http://127.0.0.1:54323'
Write-Host 'Langfuse: http://127.0.0.1:3002'
