[CmdletBinding()]
param(
  [switch]$Docker
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

if ($Docker) {
  docker compose down
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose failed to stop the services.'
  }
  Write-Host 'OwnAgent Docker services stopped.' -ForegroundColor Green
  exit 0
}

$escapedRoot = [regex]::Escape($projectRoot)
$services = @(
  @{ Name = 'api'; Command = 'npm run dev' },
  @{ Name = 'worker'; Command = 'npm run dev:worker' },
  @{ Name = 'document-worker'; Command = 'npm run dev:document-worker' },
  @{ Name = 'memory-worker'; Command = 'npm run dev:memory-worker' }
)

$stopped = 0
foreach ($service in $services) {
  $escapedCommand = [regex]::Escape($service.Command)
  $launchers = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessId -ne $PID -and
      $_.CommandLine -and
      $_.CommandLine -match $escapedRoot -and
      $_.CommandLine -match $escapedCommand
    }

  foreach ($launcher in $launchers) {
    Stop-ProcessTree -ProcessId $launcher.ProcessId
    $stopped++
    Write-Host "Stopped $($service.Name) (PID $($launcher.ProcessId))."
  }
}

docker compose stop redis
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to stop the OwnAgent Redis container.'
}

if ($stopped -eq 0) {
  Write-Host 'No local OwnAgent service launcher processes were found.'
}
Write-Host 'OwnAgent local services stopped. Redis container stopped.' -ForegroundColor Green
