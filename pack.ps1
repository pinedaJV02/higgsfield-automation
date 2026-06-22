# ============================================================
#  Zips the whole project (including node_modules, the bundled
#  Chromium browser, and your saved login in profile\) so it can
#  be copied to another Windows computer.
#
#  SECURITY: the resulting zip contains your logged-in Higgsfield
#  session. Treat it like a password — do not share it publicly.
# ============================================================

$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$projectName = Split-Path $projectDir -Leaf
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# Write the zip to the PARENT folder so we never zip the zip itself.
$zipPath = Join-Path (Split-Path $projectDir -Parent) "$projectName-$stamp.zip"

Write-Host "Packing '$projectName' ..." -ForegroundColor Cyan

# Exclude generated images and any stray zips; keep node_modules + profile.
$itemsToZip = Get-ChildItem -Path $projectDir -Force |
  Where-Object { $_.Name -ne 'output' -and $_.Extension -ne '.zip' }

Compress-Archive -Path $itemsToZip.FullName -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "Created: $zipPath" -ForegroundColor Green
Write-Host "Copy this zip to the other computer, unzip it, install Node.js if needed, then run run.bat." -ForegroundColor Green
