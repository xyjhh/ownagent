[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
$envPath = Join-Path $projectRoot '.env.development'
if (-not (Test-Path $envPath)) { throw 'Missing .env.development. Run npm run setup:dev first.' }
try {
  $existingApi = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health/live' -TimeoutSec 2
  if ($existingApi.status -eq 'ok') { throw 'Development API is already running. Run npm run stop:dev first.' }
} catch {
  if ($_.Exception.Message -like 'Development API is already running*') { throw }
}

docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running.' }
supabase start --workdir $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Supabase CLI failed to start.' }
supabase migration up --workdir $projectRoot --local
if ($LASTEXITCODE -ne 0) { throw 'Could not apply pending development database migrations.' }
docker compose -f docker-compose.dev.yml --env-file $envPath up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'Development infrastructure failed to start.' }

New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot '.runtime\dev') | Out-Null
$commands = @(
  @{ Name = 'api'; Command = 'npm run dev' },
  @{ Name = 'worker'; Command = 'npm run dev:worker' },
  @{ Name = 'worker-2'; Command = 'npm run dev:worker' },
  @{ Name = 'document-worker'; Command = 'npm run dev:document-worker' },
  @{ Name = 'memory-worker'; Command = 'npm run dev:memory-worker' }
)
foreach ($item in $commands) {
  $log = Join-Path (Resolve-Path '.runtime\dev') "$($item.Name).log"
  $command = "`$env:DOTENV_CONFIG_PATH='$envPath'; Set-Location '$projectRoot'; $($item.Command) *>> '$log'"
  Start-Process powershell -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) -WindowStyle Hidden
}

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health/live' -TimeoutSec 2
    if ($response.status -eq 'ok') { $ready = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'Development API did not become healthy. Check .runtime/dev/*.log.' }

$dependenciesReady = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health/ready' -TimeoutSec 2
    if ($response.status -eq 'ok') { $dependenciesReady = $true; break }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $dependenciesReady) { throw 'Development API is live but Supabase is not ready. Check .runtime/dev/api.log.' }

Write-Host 'Development API and workers started.' -ForegroundColor Green
Write-Host 'Frontend: cd ..\ownagentweb; npm run dev'
Write-Host 'Logs: Get-Content .runtime\dev\api.log -Wait'
