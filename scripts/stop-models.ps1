[CmdletBinding()]
param(
  [string]$RerankerServiceDir = $env:OWNAGENT_RERANKER_SERVICE_DIR
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$projectsRoot = Split-Path -Parent $projectRoot
$runtimeDir = Join-Path $projectRoot '.runtime'
if ([string]::IsNullOrWhiteSpace($RerankerServiceDir)) {
  $RerankerServiceDir = Join-Path $projectsRoot 'deno-supabase-express-nextjs-reactjs-agent\apps\reranker'
}

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

$rerankerCompose = Join-Path $RerankerServiceDir 'docker-compose.yml'
if (Test-Path -LiteralPath $rerankerCompose) {
  & docker compose -f $rerankerCompose stop
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to stop the reranker Docker service.'
  }
  Write-Host 'Stopped reranker Docker service. Its downloaded model volume was preserved.'
} else {
  Write-Warning "Reranker Compose configuration was not found at $RerankerServiceDir."
}
