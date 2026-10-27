[CmdletBinding()]
param(
  [string]$SupabaseProject,
  [string]$LangfuseProject
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$projectParent = Split-Path -Parent $projectRoot
if (-not $SupabaseProject) { $SupabaseProject = Join-Path $projectParent 'supabase' }
if (-not $LangfuseProject) {
  $LangfuseProject = Join-Path $projectParent 'deno-supabase-express-nextjs-reactjs-agent\infra\langfuse'
}
Set-Location $projectRoot

if (-not (Test-Path '.env')) { throw 'Missing .env. Copy .env.example to .env and configure it first.' }
$hasSupabaseProject = Test-Path $SupabaseProject
$langfuseComposeFile = Join-Path $LangfuseProject 'docker-compose.yml'
$hasLangfuseProject = Test-Path $langfuseComposeFile

docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running.' }

function Read-EnvFile([string]$path) {
  $result = @{}
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $result[$Matches[1]] = $Matches[2]
    }
  }
  return $result
}

function Set-EnvValue([string]$key, [string]$value) {
  $escaped = [regex]::Escape($key)
  for ($i = 0; $i -lt $envLines.Count; $i++) {
    if ($envLines[$i] -match "^$escaped=") {
      $envLines[$i] = "$key=$value"
      return
    }
  }
  $envLines.Add("$key=$value")
}

function New-RandomBytes([int]$byteCount) {
  $bytes = New-Object byte[] $byteCount
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  return ,$bytes
}

function New-HexSecret([int]$byteCount) {
  $bytes = New-RandomBytes $byteCount
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function New-Base64Url([byte[]]$bytes) {
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-SupabaseRoleToken([string]$secret, [string]$role) {
  $header = New-Base64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
  $expires = [DateTimeOffset]::UtcNow.AddYears(10).ToUnixTimeSeconds()
  $payloadJson = @{ iss = 'supabase'; role = $role; exp = $expires } | ConvertTo-Json -Compress
  $payload = New-Base64Url ([Text.Encoding]::UTF8.GetBytes($payloadJson))
  $body = "$header.$payload"
  $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secret))
  try { $signature = New-Base64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body))) }
  finally { $hmac.Dispose() }
  return "$body.$signature"
}

$rootEnv = Read-EnvFile (Join-Path $projectRoot '.env')
if (-not $rootEnv.ContainsKey('PUBLIC_BASE_URL') -or $rootEnv['PUBLIC_BASE_URL'] -notmatch '^https://[^/]+$') {
  throw 'Set PUBLIC_BASE_URL to the public HTTPS hostname in .env.'
}
if (-not $rootEnv.ContainsKey('CLOUDFLARE_TUNNEL_TOKEN') -or [string]::IsNullOrWhiteSpace($rootEnv['CLOUDFLARE_TUNNEL_TOKEN'])) {
  throw 'Set CLOUDFLARE_TUNNEL_TOKEN in .env.'
}
foreach ($key in @('ADMIN_EMAIL', 'ADMIN_PASSWORD')) {
  if (-not $rootEnv.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($rootEnv[$key])) {
    throw "Set $key in .env before initializing the clean Compose project."
  }
}
if ($rootEnv['ADMIN_PASSWORD'].Length -lt 12) { throw 'ADMIN_PASSWORD must be at least 12 characters.' }

Write-Host 'This clean initialization permanently deletes the old OwnAgent, Supabase, and Langfuse data volumes.' -ForegroundColor Yellow
$confirmation = Read-Host 'Type DELETE OLD DATA to continue'
if ($confirmation -cne 'DELETE OLD DATA') { throw 'Initialization cancelled. No containers or volumes were removed.' }

$envPath = Join-Path $projectRoot '.env'
$envLines = [System.Collections.Generic.List[string]](Get-Content $envPath)
$jwtSecret = New-Base64Url (New-RandomBytes 32)
$anonJwt = New-SupabaseRoleToken $jwtSecret 'anon'
$serviceJwt = New-SupabaseRoleToken $jwtSecret 'service_role'
$publicBase = $rootEnv['PUBLIC_BASE_URL'].TrimEnd('/')

Set-EnvValue 'SUPABASE_DB_PASSWORD' (New-HexSecret 24)
Set-EnvValue 'SUPABASE_JWT_SECRET' $jwtSecret
Set-EnvValue 'SUPABASE_ANON_JWT_KEY' $anonJwt
Set-EnvValue 'SUPABASE_SERVICE_ROLE_JWT_KEY' $serviceJwt
Set-EnvValue 'SUPABASE_SERVICE_ROLE_KEY' "sb_secret_$(New-HexSecret 32)"
Set-EnvValue 'SUPABASE_PUBLISHABLE_KEY' "sb_publishable_$(New-HexSecret 32)"
Set-EnvValue 'SUPABASE_S3_ACCESS_KEY' (New-HexSecret 10)
Set-EnvValue 'SUPABASE_S3_SECRET_KEY' (New-HexSecret 20)
Set-EnvValue 'SUPABASE_S3_REGION' 'local'
Set-EnvValue 'SUPABASE_REALTIME_SECRET_KEY' (New-HexSecret 32)
Set-EnvValue 'SUPABASE_REALTIME_DB_ENC_KEY' (New-HexSecret 8)
Set-EnvValue 'AUTH_JWT_SECRET' (New-HexSecret 32)
Set-EnvValue 'AUTH_JWT_PREVIOUS_SECRET' ''
Set-EnvValue 'SUPABASE_PUBLIC_URL' $publicBase
Set-EnvValue 'SUPABASE_S3_ENDPOINT' 'http://kong:8000/storage/v1/s3'
Set-EnvValue 'SUPABASE_S3_PUBLIC_ENDPOINT' "$publicBase/storage/v1/s3"
Set-EnvValue 'AUTH_COOKIE_SECURE' 'true'
Set-EnvValue 'WEB_ORIGIN' $publicBase
Set-EnvValue 'SUPABASE_DISABLE_SIGNUP' 'true'

Set-EnvValue 'LANGFUSE_POSTGRES_PASSWORD' (New-HexSecret 24)
Set-EnvValue 'LANGFUSE_CLICKHOUSE_PASSWORD' (New-HexSecret 24)
Set-EnvValue 'LANGFUSE_REDIS_PASSWORD' (New-HexSecret 24)
Set-EnvValue 'LANGFUSE_MINIO_ROOT_USER' "ownagent$(New-HexSecret 4)"
Set-EnvValue 'LANGFUSE_MINIO_ROOT_PASSWORD' (New-HexSecret 24)
Set-EnvValue 'LANGFUSE_NEXTAUTH_SECRET' (New-HexSecret 32)
Set-EnvValue 'LANGFUSE_SALT' (New-HexSecret 32)
Set-EnvValue 'LANGFUSE_ENCRYPTION_KEY' (New-HexSecret 32)
Set-EnvValue 'LANGFUSE_PUBLIC_KEY' "pk-lf-$([Guid]::NewGuid())"
Set-EnvValue 'LANGFUSE_SECRET_KEY' "sk-lf-$([Guid]::NewGuid())"
Set-EnvValue 'LANGFUSE_PUBLIC_URL' 'http://localhost:3001'
Set-EnvValue 'LANGFUSE_BASE_URL' 'http://langfuse-web:3000'
[IO.File]::WriteAllLines($envPath, $envLines, [Text.UTF8Encoding]::new($false))

$configOutput = docker compose config --quiet 2>&1
if ($LASTEXITCODE -ne 0) { throw "Docker Compose configuration is invalid: $configOutput" }

docker compose down
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the current OwnAgent Compose project.' }
if ($hasLangfuseProject) {
  docker compose --project-directory $LangfuseProject -f $langfuseComposeFile down
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the old Langfuse project.' }
}
if ($hasSupabaseProject) {
  & supabase stop --workdir $SupabaseProject --project-id supabase --yes
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the old Supabase CLI project.' }
}

$legacyContainers = @(docker ps -aq --filter 'label=com.docker.compose.project=ownagent')
if ($legacyContainers.Count -gt 0) {
  docker rm -f $legacyContainers | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop all old OwnAgent containers.' }
}

$oldVolumes = @(
  'supabase_db_supabase',
  'supabase_storage_supabase',
  'ownagent_ownagent-redis',
  'langfuse_langfuse-postgres',
  'langfuse_langfuse-clickhouse',
  'langfuse_langfuse-redis',
  'langfuse_langfuse-minio',
  'ownagent-compose-supabase-db',
  'ownagent-compose-supabase-storage',
  'ownagent_ownagent-redis-compose',
  'ownagent_langfuse-postgres',
  'ownagent_langfuse-clickhouse',
  'ownagent_langfuse-redis',
  'ownagent_langfuse-minio',
  'ownagent_caddy-data',
  'ownagent_caddy-config'
)
$existingVolumes = @(docker volume ls --quiet)
foreach ($volume in $oldVolumes) {
  if ($existingVolumes -contains $volume) {
    docker volume rm $volume | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not remove old volume $volume." }
  }
}

docker compose up -d --build --wait db
if ($LASTEXITCODE -ne 0) { throw 'Fresh Supabase PostgreSQL failed to start.' }

# The Supabase image creates these login roles without passwords. Set them before
# starting Auth, REST, or Storage, which connect using the shared database secret.
$supabaseRolePasswordScript = @'
set -eu
psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres <<SQL
ALTER ROLE supabase_auth_admin PASSWORD '$POSTGRES_PASSWORD';
ALTER ROLE supabase_storage_admin PASSWORD '$POSTGRES_PASSWORD';
ALTER ROLE authenticator PASSWORD '$POSTGRES_PASSWORD';
SQL
'@
docker compose exec -T db sh -ec $supabaseRolePasswordScript
if ($LASTEXITCODE -ne 0) { throw 'Could not configure Supabase internal database role passwords.' }

docker compose up -d --build --wait storage
if ($LASTEXITCODE -ne 0) { throw 'Fresh Supabase Storage failed to start.' }
docker compose exec -T db mkdir -p /tmp/ownagent-migrations
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the migration directory in PostgreSQL.' }
foreach ($migration in (Get-ChildItem (Join-Path $projectRoot 'supabase/migrations') -Filter '*.sql' | Sort-Object Name)) {
  docker compose cp $migration.FullName "db:/tmp/ownagent-migrations/$($migration.Name)"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy migration $($migration.Name)." }
}
docker compose exec -T db sh -ec 'for f in /tmp/ownagent-migrations/*.sql; do psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres -f "$f"; done'
if ($LASTEXITCODE -ne 0) { throw 'OwnAgent database migrations failed.' }

docker compose up -d --build --wait
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose services failed to become healthy.' }
docker compose run --rm --no-deps api node dist/src/scripts/bootstrap-admin.js
if ($LASTEXITCODE -ne 0) { throw 'Could not create the initial OwnAgent administrator.' }

Write-Host ''
Write-Host 'Fresh OwnAgent Compose initialization completed.' -ForegroundColor Green
Write-Host 'Supabase, Langfuse, and OwnAgent started with empty data volumes.'
Write-Host 'The generated service credentials are stored in the ignored .env file.'
Write-Host 'Check service health with: docker compose ps'
