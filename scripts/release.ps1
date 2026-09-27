# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
#
# Puts a new version on the official GitHub page in two steps, so nothing goes public unseen.
#
#   release-1-prepare.cmd  (-Step prepare)  LOCAL and VirusTotal only - nothing is published.
#       Checks that the Setup and latest.yml in dist-installer\ are this version's and belong
#       together (the app's updater refuses a Setup whose SHA-512 differs from latest.yml),
#       scans the Setup on VirusTotal, stages the source the way .gitignore says, refuses NVIDIA
#       runtime files, keys and personal files, and writes for review:
#           dist-installer\release-notes-<version>.md    the text of the release page
#           dist-installer\release-<version>-files.txt   what the commit adds, changes, removes
#   release-2-publish.cmd  (-Step publish)  PUBLIC - only after the owner has read both and said go.
#       Repeats every check, refuses if the source changed since prepare, commits with
#       dist-installer\commit-message-<version>.txt, tags v<version>, pushes (never forced),
#       creates the release with the Setup and latest.yml, and compares GitHub's copies with
#       the local SHA-256s.
#
# Before prepare, write into dist-installer\:
#   release-notes-<version>-body.md   the "## New in <version>" part of the release page
#   commit-message-<version>.txt      the commit message (needed only when the source changed)
# Needs git and gh signed in to the official account, and a VirusTotal key saved with
# scripts\virustotal-key.ps1. Every step is logged to dist-installer\release-<version>-<step>.txt.

param([Parameter(Mandatory = $true)][ValidateSet('prepare', 'publish')][string]$Step)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$dist = Join-Path $root 'dist-installer'
$repo = 'revingale32/dlss5-aio-installer'
$utf8 = New-Object Text.UTF8Encoding $false
if (-not (Test-Path -LiteralPath $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }

$version = [string](([IO.File]::ReadAllText((Join-Path $root 'package.json'), $utf8) | ConvertFrom-Json).version)
$tag = "v$version"
$setupName = "DLSS-5-AIO-Installer-$version-Setup.exe"
$setup = Join-Path $dist $setupName
$yml = Join-Path $dist 'latest.yml'
$notes = Join-Path $dist "release-notes-$version.md"
$body = Join-Path $dist "release-notes-$version-body.md"
$message = Join-Path $dist "commit-message-$version.txt"
$list = Join-Path $dist "release-$version-files.txt"
$vtReport = Join-Path $dist ('virustotal-' + [IO.Path]::GetFileNameWithoutExtension($setupName) + '.txt')
$log = Join-Path $dist "release-$version-$Step.txt"

[IO.File]::WriteAllText($log, "=== $Step $version - $(Get-Date -Format s)`r`n", $utf8)
function Say([string]$line) { Write-Host $line; [IO.File]::AppendAllText($log, "$line`r`n", $utf8) }
function Stop-Release([string]$why) { Say "FAILED: $why"; Say '=== stopped - nothing after this point was done'; exit 1 }

# git and gh write progress to stderr. Windows PowerShell turns redirected stderr into errors,
# so native programs run under 'Continue' and are judged by their exit code alone.
function Run([string]$exe, [string[]]$argList, [switch]$Quiet) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $exe @argList 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $saved }
  if (-not $Quiet) { foreach ($line in $out) { [IO.File]::AppendAllText($log, "    $line`r`n", $utf8) } }
  return New-Object PSObject -Property @{ Code = $code; Out = $out }
}
function Must([string]$exe, [string[]]$argList, [string]$what, [switch]$Quiet) {
  $r = Run $exe $argList -Quiet:$Quiet
  if ($r.Code -ne 0) {
    if ($Quiet) { foreach ($line in $r.Out) { [IO.File]::AppendAllText($log, "    $line`r`n", $utf8) } }
    Stop-Release "$what (exit $($r.Code))"
  }
  return $r
}
function First($r) { if ($r.Out.Count) { return ([string]$r.Out[0]).Trim() } else { return '' } }

function Sha256([string]$path) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower() }
function Sha512Base64([string]$path) {
  $hex = (Get-FileHash -Algorithm SHA512 -LiteralPath $path).Hash
  $bytes = New-Object byte[] ([int]($hex.Length / 2))
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring(2 * $i, 2), 16) }
  return [Convert]::ToBase64String($bytes)
}
function Field([string]$text, [string]$pattern) {
  $m = [regex]::Match($text, $pattern, [Text.RegularExpressions.RegexOptions]::Multiline)
  if ($m.Success) { return $m.Groups[1].Value } else { return '' }
}
# The commit a ref on GitHub points at ('' when it does not exist); annotated tags are peeled.
function Get-RemoteCommit([string]$ref) {
  $r = Run 'git' @('ls-remote', 'origin', $ref) -Quiet
  if ($r.Code -ne 0) { Stop-Release "GitHub could not be reached (git ls-remote $ref, exit $($r.Code))" }
  $sha = ''
  foreach ($line in $r.Out) {
    $parts = @(([string]$line).Trim() -split '\s+')
    if ($parts.Count -lt 2) { continue }
    if ($parts[1] -eq "$ref^{}") { return $parts[0] }
    if ($parts[1] -eq $ref) { $sha = $parts[0] }
  }
  return $sha
}

# ------------------------------------------------------------------ the build
function Test-Build {
  Say '--- the build'
  if (-not (Test-Path -LiteralPath $setup)) { Stop-Release "$setupName is not in dist-installer - build version $version first" }
  if (-not (Test-Path -LiteralPath $yml)) { Stop-Release 'latest.yml is not in dist-installer - the build writes it next to the Setup' }
  $text = [IO.File]::ReadAllText($yml, $utf8)
  $size = (New-Object IO.FileInfo $setup).Length
  $sha512 = Sha512Base64 $setup
  $checks = @(
    @{ Name = 'latest.yml version'; Got = (Field $text '^version:\s*(\S+)\s*$'); Want = $version },
    @{ Name = 'latest.yml path'; Got = (Field $text '^path:\s*(\S+)\s*$'); Want = $setupName },
    @{ Name = 'latest.yml files url'; Got = (Field $text '^\s+-\s+url:\s*(\S+)\s*$'); Want = $setupName },
    @{ Name = 'latest.yml sha512'; Got = (Field $text '^sha512:\s*(\S+)\s*$'); Want = $sha512 }
  )
  # electron-builder writes a size only for some targets; when it is there it must match.
  $ymlSize = Field $text '^\s+size:\s*(\d+)\s*$'
  if ($ymlSize) { $checks += @{ Name = 'latest.yml size'; Got = $ymlSize; Want = [string]$size } }
  foreach ($c in $checks) {
    if ($c.Got -ne $c.Want) { Stop-Release "$($c.Name) is '$($c.Got)', the Setup needs '$($c.Want)' - latest.yml and the Setup must come from the same build" }
  }
  $script:setupSha = Sha256 $setup
  $script:ymlSha = Sha256 $yml
  Say "    $setupName  $size bytes  sha256 $setupSha"
  Say "    latest.yml  version $version, SHA-512 matches the Setup  sha256 $ymlSha"
  $mainJs = [IO.File]::ReadAllText((Join-Path $root 'main.js'), $utf8)
  $script:build = Field $mainJs "^const BUILD = '([^']+)';"
  if (-not $build) { Stop-Release "could not read the add-on build (const BUILD) from main.js" }
}

# ------------------------------------------------------------------ VirusTotal
function Read-VirusTotal {
  if (-not (Test-Path -LiteralPath $vtReport)) { Stop-Release 'there is no VirusTotal report for this Setup - run prepare' }
  $vt = [IO.File]::ReadAllText($vtReport, $utf8)
  if ((Field $vt '^status:\s*(.+?)\s*$') -ne 'done') { Stop-Release "VirusTotal did not finish: $(Field $vt '^status:\s*(.+?)\s*$')" }
  if ((Field $vt '^sha256:\s*([0-9a-f]{64})\s*$') -ne $setupSha) { Stop-Release 'the VirusTotal report is for a different file - the Setup changed since it was scanned; run prepare again' }
  $m = [regex]::Match($vt, '^result: (\d+) malicious, (\d+) suspicious, (\d+) undetected, (\d+) harmless', [Text.RegularExpressions.RegexOptions]::Multiline)
  if (-not $m.Success) { Stop-Release 'the VirusTotal report has no result line' }
  $flagged = [int]$m.Groups[1].Value + [int]$m.Groups[2].Value
  $scanned = $flagged + [int]$m.Groups[3].Value + [int]$m.Groups[4].Value
  $link = "https://www.virustotal.com/gui/file/$setupSha"
  if ($flagged -gt 0) { Stop-Release "VirusTotal: $flagged of $scanned engines flagged the Setup. Nothing is published with a detection - read the report first: $link" }
  $when = Field $vt 'VirusTotal scan - (\d{4}-\d{2}-\d{2})'
  $script:vtLine = "**VirusTotal: 0 of $scanned engines flagged it** (scanned $when) - [full report]($link)"
  Say "    VirusTotal: 0 of $scanned engines flagged it ($when)"
}

function Invoke-VirusTotal {
  Say '--- VirusTotal'
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'virustotal-scan.ps1') -File $setup
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $saved }
  if ($code -ne 0 -and (Test-Path -LiteralPath $vtReport)) {
    foreach ($line in [IO.File]::ReadAllLines($vtReport, $utf8)) { [IO.File]::AppendAllText($log, "    $line`r`n", $utf8) }
  }
  if ($code -ne 0) { Stop-Release "the VirusTotal scan failed (exit $code) - see $([IO.Path]::GetFileName($vtReport))" }
  Read-VirusTotal
}

# ------------------------------------------------------------------ the source
$forbidden = @(
  @{ Why = 'an NVIDIA runtime DLL'; Pattern = '(^|/)nvngx_[^/]+\.dll$' },
  @{ Why = 'an NVIDIA Streamline DLL'; Pattern = '(^|/)sl\.[^/]+\.dll$' },
  @{ Why = "NVIDIA's NGX SDK headers"; Pattern = '^media-worker/third_party/ngx/' },
  @{ Why = 'a runtime from this PC'; Pattern = '^runtimes/(?!README\.txt$)' },
  @{ Why = 'personal app data'; Pattern = '(^|/)(settings\.json|art\.json)$|^covers/' },
  @{ Why = 'a key or certificate'; Pattern = '\.(key|pem|pfx|p12|snk)$|(^|/)\.env' },
  @{ Why = 'build output or dependencies'; Pattern = '(^|/)(node_modules|dist|dist-installer|dist-test)/' }
)

function Update-Stage {
  Say '--- the source'
  Must 'git' @('add', '-A') 'git add' | Out-Null
  # Files published before but ignored now leave the repo (they stay on this PC).
  foreach ($f in (Run 'git' @('ls-files', '-ci', '--exclude-standard') -Quiet).Out) {
    if (-not $f) { continue }
    Must 'git' @('rm', '-q', '--cached', '--', $f) "git rm --cached $f" | Out-Null
    Say "    leaves the repo (ignored now, kept on this PC): $f"
  }
  $tracked = @((Must 'git' @('ls-files') 'git ls-files' -Quiet).Out | Where-Object { $_ })
  $bad = @()
  foreach ($f in $tracked) {
    foreach ($rule in $forbidden) { if ($f -match $rule.Pattern) { $bad += "$f ($($rule.Why))" } }
    $full = Join-Path $root $f
    $info = New-Object IO.FileInfo $full
    if ($info.Exists -and $info.Length -gt 95MB) { $bad += "$f (over GitHub's 100 MB file limit)" }
  }
  if ($bad.Count) { Stop-Release ("these must never be published: " + ($bad -join '; ')) }
  $secrets = Run 'git' @('grep', '--cached', '-n', '-I', '-E', '-e', 'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----') -Quiet
  if ($secrets.Code -eq 0) { Stop-Release ("something that looks like a token or private key is in: " + (($secrets.Out | ForEach-Object { ($_ -split ':')[0] } | Select-Object -Unique) -join ', ')) }
  if ($secrets.Code -ne 1) { Stop-Release "the token check could not run (git grep exit $($secrets.Code))" }
  $script:trackedCount = $tracked.Count
  $script:tree = First (Must 'git' @('write-tree') 'git write-tree' -Quiet)
  $script:changes = @((Run 'git' @('diff', '--cached', '--name-status') -Quiet).Out | Where-Object { $_ })
  Say "    $trackedCount files in the repo, $($changes.Count) changed since the last commit"
}

# ------------------------------------------------------------------ prepare
function Invoke-Prepare {
  Test-Build
  if (-not (Test-Path -LiteralPath $body)) { Stop-Release "write dist-installer\release-notes-$version-body.md first (the ## New in $version part of the page)" }
  Invoke-VirusTotal
  Update-Stage

  $template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release-notes-template.md'), $utf8)
  $page = $template.Replace('{{SETUP}}', $setupName).Replace('{{BUILD}}', $build).Replace('{{NEW}}', [IO.File]::ReadAllText($body, $utf8).Trim())
  $page = $page.Replace('{{SETUP_SHA256}}', $setupSha).Replace('{{YML_SHA256}}', $ymlSha).Replace('{{VIRUSTOTAL}}', $vtLine).Replace('{{VERSION}}', $version)
  if ($page -match '\{\{[A-Z_0-9]+\}\}') { Stop-Release "the notes template has a placeholder this script does not fill: $($Matches[0])" }
  [IO.File]::WriteAllText($notes, $page.Replace("`r`n", "`n"), $utf8)
  Say "--- written: $([IO.Path]::GetFileName($notes))"

  $review = @(
    "version: $version",
    "setup: $setupName",
    "setup sha256: $setupSha",
    "latest.yml sha256: $ymlSha",
    "tree: $tree",
    "files in the repo: $trackedCount",
    '',
    "Changes since the last commit (A added, M changed, D removed):"
  ) + $(if ($changes.Count) { $changes | ForEach-Object { "  $_" } } else { @('  (none - the source is already on GitHub as it is here)') })
  [IO.File]::WriteAllText($list, (($review -join "`r`n") + "`r`n"), $utf8)
  Say "--- written: $([IO.Path]::GetFileName($list))"
  if ($changes.Count -and -not (Test-Path -LiteralPath $message)) { Say "    note: publish will need dist-installer\commit-message-$version.txt" }
  Say '=== prepared - nothing was published'
}

# ------------------------------------------------------------------ publish
function Invoke-Publish {
  Test-Build
  Say '--- VirusTotal'
  Read-VirusTotal
  if (-not (Test-Path -LiteralPath $notes)) { Stop-Release 'there are no release notes for this version - run prepare' }
  if (-not ([IO.File]::ReadAllText($notes, $utf8).Contains($setupSha))) { Stop-Release 'the release notes are for a different Setup - run prepare again' }
  if (-not (Test-Path -LiteralPath $list)) { Stop-Release 'there is no reviewed file list for this version - run prepare' }
  $prepared = [IO.File]::ReadAllText($list, $utf8)
  Update-Stage
  if ((Field $prepared '^tree:\s*([0-9a-f]+)\s*$') -ne $tree) { Stop-Release 'the source changed since prepare - run prepare again and review the new list' }
  if ((Field $prepared '^setup sha256:\s*([0-9a-f]+)\s*$') -ne $setupSha) { Stop-Release 'the Setup changed since prepare - run prepare again' }

  # Everything that can refuse is checked before anything is committed here or sent there.
  Say '--- GitHub before'
  if ($changes.Count -and -not (Test-Path -LiteralPath $message)) { Stop-Release "write dist-installer\commit-message-$version.txt first" }
  $before = First (Must 'git' @('rev-parse', 'HEAD') 'git rev-parse HEAD' -Quiet)
  $remoteMain = Get-RemoteCommit 'refs/heads/main'
  if ($remoteMain) {
    Must 'git' @('fetch', '-q', 'origin', 'refs/heads/main') 'git fetch (main)' -Quiet | Out-Null
    if ((Run 'git' @('merge-base', '--is-ancestor', $remoteMain, $before) -Quiet).Code -ne 0) {
      Stop-Release "GitHub's main ($remoteMain) has commits this PC does not have - bring them in first; this script never overwrites GitHub"
    }
  }
  $remoteTag = Get-RemoteCommit "refs/tags/$tag"
  if ($remoteTag -and ($changes.Count -or $remoteTag -ne $before)) { Stop-Release "tag $tag is already on GitHub on another commit ($remoteTag) - a published version is never moved by this script" }
  $local = Run 'git' @('rev-parse', '-q', '--verify', "refs/tags/$tag^{commit}") -Quiet
  if ($local.Code -eq 0 -and ($changes.Count -or (First $local) -ne $before)) { Stop-Release "tag $tag already exists on this PC on another commit ($(First $local))" }
  Say "    main on GitHub: $(if ($remoteMain) { $remoteMain } else { 'empty' }); tag ${tag}: $(if ($remoteTag) { $remoteTag } else { 'not there yet' })"

  Say '--- commit and tag'
  if ($changes.Count) { Must 'git' @('commit', '-q', '-F', $message) 'git commit' | Out-Null }
  $head = First (Must 'git' @('rev-parse', 'HEAD') 'git rev-parse HEAD' -Quiet)
  if ((First (Must 'git' @('rev-parse', 'HEAD^{tree}') 'git rev-parse HEAD^{tree}' -Quiet)) -ne $tree) { Stop-Release 'the commit does not hold the reviewed source' }
  if ($local.Code -ne 0) { Must 'git' @('tag', $tag) "git tag $tag" | Out-Null }
  Say "    commit $head, tag $tag"

  Say '--- push'
  Must 'git' @('push', 'origin', 'HEAD:refs/heads/main') 'git push (main)' | Out-Null
  Must 'git' @('push', 'origin', "refs/tags/$tag") "git push ($tag)" | Out-Null

  Say '--- release'
  if ((Run 'gh' @('release', 'view', $tag, '--repo', $repo, '--json', 'url') -Quiet).Code -eq 0) {
    Say "    release $tag already exists - checking it, not changing it"
  } else {
    Must 'gh' @('release', 'create', $tag, $setup, $yml, '--repo', $repo, '--verify-tag', '--title', "DLSS 5 AIO Installer $version", '--notes-file', $notes) 'gh release create' | Out-Null
  }

  Say '--- what GitHub has now'
  $rel = ((Must 'gh' @('release', 'view', $tag, '--repo', $repo, '--json', 'url,tagName,isDraft,isPrerelease,assets') 'gh release view' -Quiet).Out -join '') | ConvertFrom-Json
  if ($rel.isDraft -or $rel.isPrerelease) { Stop-Release "release $tag is a draft or a pre-release - installed apps only see full releases" }
  foreach ($want in @(@{ Name = $setupName; Sha = $setupSha }, @{ Name = 'latest.yml'; Sha = $ymlSha })) {
    $asset = @($rel.assets | Where-Object { $_.name -eq $want.Name })
    if (-not $asset.Count) { Stop-Release "the release has no $($want.Name)" }
    $digest = if ($asset[0].PSObject.Properties['digest']) { [string]$asset[0].digest } else { '' }
    if ($digest -ne "sha256:$($want.Sha)") { Stop-Release "GitHub's $($want.Name) is '$digest', expected sha256:$($want.Sha)" }
    Say "    $($want.Name): GitHub's copy matches ($($want.Sha))"
  }
  foreach ($ref in @('refs/heads/main', "refs/tags/$tag")) {
    $at = Get-RemoteCommit $ref
    if ($at -ne $head) { Stop-Release "GitHub's $ref is '$at', not the commit just published ($head)" }
  }
  Say "    main and $tag on GitHub are $head"
  Say "=== published: $($rel.url)"
}

if ($Step -eq 'prepare') { Invoke-Prepare } else { Invoke-Publish }
exit 0
