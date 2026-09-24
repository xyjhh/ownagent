[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-HealthStatus([string]$Name, [string]$Url) {
  try {
    $response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
    [PSCustomObject]@{ Service = $Name; Status = 'ready'; Detail = ($response | ConvertTo-Json -Compress) }
  } catch {
    [PSCustomObject]@{ Service = $Name; Status = 'stopped or unavailable'; Detail = $_.Exception.Message }
  }
}

Get-HealthStatus 'Embedding' 'http://127.0.0.1:8002/health'
Get-HealthStatus 'Reranker' 'http://127.0.0.1:8001/health'
