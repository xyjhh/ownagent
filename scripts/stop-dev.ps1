[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
$envPath = Join-Path $projectRoot '.env.development'

$escapedRoot = [regex]::Escape($projectRoot)
function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) { Stop-ProcessTree $child.ProcessId }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}
$launchers = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match $escapedRoot -and $_.CommandLine -match 'DOTENV_CONFIG_PATH' }
foreach ($launcher in $launchers) { Stop-ProcessTree $launcher.ProcessId }

if (Test-Path $envPath) {
  docker compose -f docker-compose.dev.yml --env-file $envPath down
}
supabase stop --workdir $projectRoot --yes
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the development Supabase project.' }
Write-Host 'Development services stopped; development volumes were retained.' -ForegroundColor Green
