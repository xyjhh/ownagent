[CmdletBinding()]

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.runtime'

function Stop-ProcessTree([int]$ProcessId) {
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$pidFile = Join-Path $runtimeDir 'embedding.pid'
if (Test-Path -LiteralPath $pidFile) {
  $pidText = Get-Content -LiteralPath $pidFile -Raw
  [int]$embeddingPid = $pidText.Trim()
  $process = Get-Process -Id $embeddingPid -ErrorAction SilentlyContinue
  if ($process) {
    Stop-ProcessTree -ProcessId $embeddingPid
    Write-Host "Stopped embedding service process $embeddingPid."
  } else {
    Write-Host 'Embedding service process was already stopped.'
  }
  Remove-Item -LiteralPath $pidFile -Force
} else {
  Write-Host 'No embedding process PID file was found in this project.'
}
