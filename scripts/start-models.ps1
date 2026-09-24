[CmdletBinding()]
param(
  [string]$EmbeddingServiceDir = $env:OWNAGENT_EMBEDDING_SERVICE_DIR,
  [string]$RerankerServiceDir = $env:OWNAGENT_RERANKER_SERVICE_DIR,
  [ValidateRange(10, 600)]
  [int]$StartupTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$projectsRoot = Split-Path -Parent $projectRoot
$runtimeDir = Join-Path $projectRoot '.runtime'

if ([string]::IsNullOrWhiteSpace($EmbeddingServiceDir)) {
  $EmbeddingServiceDir = Join-Path $projectsRoot 'deno-supabase-express-nextjs-reactjs-agent\apps\embedding-directml'
}
if ([string]::IsNullOrWhiteSpace($RerankerServiceDir)) {
  $RerankerServiceDir = Join-Path $projectsRoot 'deno-supabase-express-nextjs-reactjs-agent\apps\reranker'
}

function Test-Health([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-ForHealth([string]$Name, [string]$Url) {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health $Url) {
      Write-Host "$Name is ready: $Url"
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "$Name did not become healthy within $StartupTimeoutSeconds seconds."
}

function Assert-PortAvailable([int]$Port, [string]$ServiceName) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    throw "$ServiceName port $Port is already occupied by PID $($listener.OwningProcess), but its health endpoint is not available."
  }
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

$embeddingHealth = 'http://127.0.0.1:8002/health'
if (Test-Health $embeddingHealth) {
  Write-Host "Embedding service is already ready: $embeddingHealth"
} else {
  Assert-PortAvailable 8002 'Embedding'
  $embeddingPython = Join-Path $EmbeddingServiceDir '.venv\Scripts\python.exe'
  $embeddingApp = Join-Path $EmbeddingServiceDir 'app.py'
  if (-not (Test-Path -LiteralPath $embeddingPython) -or -not (Test-Path -LiteralPath $embeddingApp)) {
    throw "Embedding service was not found at $EmbeddingServiceDir. Set OWNAGENT_EMBEDDING_SERVICE_DIR to its directory."
  }

  $outLog = Join-Path $runtimeDir 'embedding.out.log'
  $errLog = Join-Path $runtimeDir 'embedding.err.log'
  $pidFile = Join-Path $runtimeDir 'embedding.pid'
  # The complete ONNX snapshot is already cached locally. Prevent a metadata
  # request to Hugging Face from delaying or blocking startup on an offline PC.
  $previousHubOffline = $env:HF_HUB_OFFLINE
  $previousTransformersOffline = $env:TRANSFORMERS_OFFLINE
  $env:HF_HUB_OFFLINE = '1'
  $env:TRANSFORMERS_OFFLINE = '1'
  try {
    $process = Start-Process -FilePath $embeddingPython `
      -ArgumentList @('-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8002') `
      -WorkingDirectory $EmbeddingServiceDir `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    $env:HF_HUB_OFFLINE = $previousHubOffline
    $env:TRANSFORMERS_OFFLINE = $previousTransformersOffline
  }
  Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline

  try {
    Wait-ForHealth 'Embedding service' $embeddingHealth
  } catch {
    if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
      Stop-Process -Id $process.Id -Force
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    throw "$($_.Exception.Message) See $errLog for details."
  }
}

$rerankerHealth = 'http://127.0.0.1:8001/health'
if (Test-Health $rerankerHealth) {
  Write-Host "Reranker service is already ready: $rerankerHealth"
} else {
  Assert-PortAvailable 8001 'Reranker'
  $rerankerCompose = Join-Path $RerankerServiceDir 'docker-compose.yml'
  if (-not (Test-Path -LiteralPath $rerankerCompose)) {
    throw "Reranker Compose configuration was not found at $RerankerServiceDir. Set OWNAGENT_RERANKER_SERVICE_DIR to its directory."
  }
  & docker compose -f $rerankerCompose up -d
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to start the reranker Docker service.'
  }
  Wait-ForHealth 'Reranker service' $rerankerHealth
}

Write-Host 'Both model services are ready.'
