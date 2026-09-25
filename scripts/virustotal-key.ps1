# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
#
# Saves your VirusTotal API key for the release scripts. You paste it here yourself; it is stored
# encrypted for your Windows account only (Windows DPAPI) in %APPDATA%\DLSS5-AIO-Publishing, never
# in this folder, the repo, a log or anything that gets published. Nothing else can read it back.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = Join-Path $env:APPDATA 'DLSS5-AIO-Publishing'
$file = Join-Path $dir 'virustotal.key'
$statusFile = Join-Path $PSScriptRoot '..\dist-installer\virustotal-key-status.txt'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host ''
Write-Host '  DLSS 5 AIO Installer - VirusTotal API key' -ForegroundColor Green
Write-Host ''
Write-Host '  Paste your key below (Ctrl+V or right-click) and press Enter.'
Write-Host '  It shows as stars, is saved encrypted for your Windows account only,'
Write-Host '  and is used just to scan release files before they are published.'
Write-Host ''
$secure = Read-Host -AsSecureString '  API key'
if ($secure.Length -lt 32) {
  Write-Host ''
  Write-Host '  That is too short for a VirusTotal key - nothing was saved.' -ForegroundColor Yellow
  "$(Get-Date -Format s) not saved - the pasted text was too short" | Set-Content -Path $statusFile -Encoding UTF8
  Read-Host '  Press Enter to close'
  exit 1
}
$secure | ConvertFrom-SecureString | Set-Content -Path $file -Encoding ASCII

# Check the key without uploading anything: ask about one file hash.
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$state = 'saved and working'
try {
  Invoke-RestMethod -Uri 'https://www.virustotal.com/api/v3/files/83983aaa95a5adbfd53a0c0f352f8bf37e7d7e80db3b821e3f07e45cddb0f071' -Headers @{ 'x-apikey' = $key } | Out-Null
} catch {
  $code = 0
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -ne 404) { $state = "saved, but VirusTotal did not accept it (HTTP $code)" }   # 404 = key fine, file not known yet
}
$key = $null
"$(Get-Date -Format s) $state" | Set-Content -Path $statusFile -Encoding UTF8
Write-Host ''
if ($state -eq 'saved and working') { Write-Host '  Saved - VirusTotal accepted the key.' -ForegroundColor Green }
else { Write-Host "  $state" -ForegroundColor Yellow }
Write-Host ''
Read-Host '  Press Enter to close'
