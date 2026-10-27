[CmdletBinding()]
param([string]$BackupRoot = '.runtime\compose-backups')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
$storageVolume = 'ownagent-compose-supabase-storage'
docker volume inspect $storageVolume *> $null
if ($LASTEXITCODE -ne 0) { throw "Missing Compose Storage volume: $storageVolume. Run init:compose first." }
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path (Join-Path $projectRoot $BackupRoot) $timestamp
New-Item -ItemType Directory -Force -Path $backupPath | Out-Null

docker compose exec -T db pg_dumpall -U postgres -f /tmp/ownagent-backup.sql
if ($LASTEXITCODE -ne 0) { throw 'Supabase database backup failed.' }
docker compose cp db:/tmp/ownagent-backup.sql (Join-Path $backupPath 'supabase.sql')
if ($LASTEXITCODE -ne 0) { throw 'Could not copy the database backup.' }
$backupBind = (Resolve-Path $backupPath).Path -replace '\\', '/'
docker run --rm -v "${storageVolume}:/source:ro" -v "${backupBind}:/backup" alpine:3.20 tar czf /backup/supabase-storage.tar.gz -C /source .
if ($LASTEXITCODE -ne 0) { throw 'Supabase Storage backup failed.' }
Write-Host "Compose backup completed: $backupPath" -ForegroundColor Green
