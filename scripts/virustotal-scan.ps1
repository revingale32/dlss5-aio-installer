# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
#
# Scans a release file on VirusTotal before it is published and writes what VirusTotal found
# (never the key) to virustotal-<file>.txt next to the file:
#   powershell -ExecutionPolicy Bypass -File scripts\virustotal-scan.ps1 -File <path>
# Uses the key saved by virustotal-key.ps1. A file VirusTotal already knows is not uploaded again.

param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$File = (Resolve-Path $File).Path
$report = Join-Path (Split-Path $File) ('virustotal-' + [IO.Path]::GetFileNameWithoutExtension($File) + '.txt')
function Say([string]$line) { Write-Host "  $line"; Add-Content -Path $report -Value $line -Encoding UTF8 }
Set-Content -Path $report -Value "VirusTotal scan - $(Get-Date -Format s)" -Encoding UTF8

try {
  $keyFile = Join-Path $env:APPDATA 'DLSS5-AIO-Publishing\virustotal.key'
  if (-not (Test-Path $keyFile)) { throw 'No VirusTotal key saved yet - run set-virustotal-key first.' }
  $secure = Get-Content $keyFile | ConvertTo-SecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $headers = @{ 'x-apikey' = $key }

  $sha = (Get-FileHash -Algorithm SHA256 -Path $File).Hash.ToLower()
  Say "file: $([IO.Path]::GetFileName($File))"
  Say "sha256: $sha"
  Say "link: https://www.virustotal.com/gui/file/$sha"

  function Known {
    try { return (Invoke-RestMethod -Uri "https://www.virustotal.com/api/v3/files/$sha" -Headers $headers).data.attributes }
    catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { return $null } else { throw } }
  }

  $attr = Known
  $stats = $null
  if ($attr -and $attr.last_analysis_stats -and $attr.last_analysis_date) {
    Say 'VirusTotal already had this file - no upload needed.'
    $stats = $attr.last_analysis_stats
  } else {
    Say 'Uploading (large files get a one-time upload address)...'
    $uploadUrl = (Invoke-RestMethod -Uri 'https://www.virustotal.com/api/v3/files/upload_url' -Headers $headers).data
    $json = & curl.exe -s -S --fail -X POST $uploadUrl -H "x-apikey: $key" -F "file=@$File"
    if ($LASTEXITCODE -ne 0) { throw "upload failed (curl exit $LASTEXITCODE)" }
    $analysis = (($json -join '') | ConvertFrom-Json).data.id
    Say 'Uploaded - waiting for the engines (free keys allow 4 requests a minute, so this polls every 30 s)...'
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Seconds 30
      $a = Invoke-RestMethod -Uri "https://www.virustotal.com/api/v3/analyses/$analysis" -Headers $headers
      if ($a.data.attributes.status -eq 'completed') { $stats = $a.data.attributes.stats; break }
    }
    if (-not $stats) { throw 'the analysis did not finish within 20 minutes - run this again later' }
  }
  $key = $null
  $engines = 0
  foreach ($p in $stats.PSObject.Properties) { $engines += [int]$p.Value }
  Say ("result: {0} malicious, {1} suspicious, {2} undetected, {3} harmless, {4} could not scan the type ({5} engines)" -f `
    $stats.malicious, $stats.suspicious, $stats.undetected, $stats.harmless, $stats.'type-unsupported', $engines)
  Say 'status: done'
} catch {
  $key = $null
  Say "status: failed - $($_.Exception.Message)"
  exit 1
}
