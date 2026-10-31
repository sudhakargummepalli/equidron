# Back up the marketplace database, and keep the last few.
#
#   pwsh -File scripts/backup-equidron.ps1
#
# A backup that has never been restored is a hope, not a backup: docs/CUTOVER.md says how to restore one,
# and the first restore should happen on a copy before the day it is needed.
param(
  [string]$Database = "equidron_live",
  [string]$OutDir = "data/backups",
  [int]$Keep = 14,
  [string]$PsqlBin = "C:\Program Files\PostgreSQL\16\bin"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$file = Join-Path $OutDir "$Database-$stamp.sql"
$env:PGPASSWORD = if ($env:DATABASE_PASSWORD) { $env:DATABASE_PASSWORD } else { "equidron-local" }
try {
  & (Join-Path $PsqlBin "pg_dump.exe") -U equidron -h 127.0.0.1 -d $Database --no-owner --file $file
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with $LASTEXITCODE" }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

$size = [Math]::Round((Get-Item $file).Length / 1KB)
if ($size -lt 10) { throw "the backup is $size KB, which is too small to be real" }
Write-Host "backup: $file ($size KB)"

# Old backups go, newest kept: a folder that only grows is a folder nobody checks.
$old = Get-ChildItem $OutDir -Filter "$Database-*.sql" | Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep
foreach ($f in $old) { Remove-Item $f.FullName -Force; Write-Host "removed old backup: $($f.Name)" }