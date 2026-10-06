param(
  [switch]$Build,
  [switch]$Models,
  [switch]$Docker
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path '.env')) {
  throw 'Missing .env. Run: Copy-Item .env.example .env, then fill Supabase and DeepSeek settings.'
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker is not running. Start Docker Desktop and retry.'
}

if ($Models) { npm run models:start }

if ($Docker) {
  $composeArgs = @('compose', 'up', '-d')
  if ($Build) { $composeArgs += '--build' }
  & docker @composeArgs
  if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed to start the services. Check Docker registry/network access.' }
} else {
  & docker compose up -d redis
  if ($LASTEXITCODE -ne 0) { throw 'Redis failed to start. Check Docker Desktop.' }
  New-Item -ItemType Directory -Force -Path '.runtime' | Out-Null
  $commands = @(
    @{ Name = 'api'; Command = 'npm run dev' },
    @{ Name = 'worker'; Command = 'npm run dev:worker' },
    @{ Name = 'document-worker'; Command = 'npm run dev:document-worker' },
    @{ Name = 'memory-worker'; Command = 'npm run dev:memory-worker' }
  )
  foreach ($item in $commands) {
    $log = Join-Path (Resolve-Path '.runtime') "$($item.Name).log"
    Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "Set-Location '$projectRoot'; $($item.Command) *>> '$log'") -WindowStyle Hidden
  }
}

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health/live' -TimeoutSec 2
    if ($response.status -eq 'ok') { $ready = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}

if (-not $ready) {
  if ($Docker) { docker compose ps }
  throw 'API did not become healthy within 60 seconds. Check .runtime/*.log or Docker Compose logs.'
}

Write-Host ''
Write-Host 'OwnAgent services started:' -ForegroundColor Green
docker compose ps
Write-Host ''
Write-Host 'API:      http://127.0.0.1:8787'
Write-Host 'Health:   http://127.0.0.1:8787/health/ready'
if ($Docker) {
  Write-Host 'Logs:     docker compose logs -f api worker document-worker memory-worker'
  Write-Host 'Stop:     docker compose down'
} else {
  Write-Host 'Logs:     Get-Content .runtime/api.log -Wait (or another .runtime/*.log)'
  Write-Host 'Stop:     Get-Process powershell | ... ; docker compose stop redis'
}
