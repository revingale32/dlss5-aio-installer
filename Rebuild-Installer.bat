@echo off
rem SPDX-License-Identifier: Apache-2.0
rem Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
title Rebuilding DLSS 5 AIO Installer...
cd /d "%~dp0"
echo Running the test suite first - a failing test means no build.
call npm test
if errorlevel 1 (
  echo.
  echo TESTS FAILED - nothing was built.
  pause
  exit /b 1
)
echo.
echo Making sure the app's own dependencies are installed ...
call npm install --no-audit --no-fund
echo Building the Windows installer into dist-installer\ ...
rem --publish never: releases are uploaded by hand, with their hashes, from the official account.
call npx --yes electron-builder --win --x64 --publish never
if errorlevel 1 (
  echo.
  echo BUILD FAILED.
  pause
  exit /b 1
)
node scripts\release-sums.js
echo.
echo Done. Hashes are in dist-installer\SHA256SUMS.txt. A release needs the Setup exe AND latest.yml -
echo the app's updater reads latest.yml. Upload the exe to VirusTotal before publishing.
pause
