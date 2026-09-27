@echo off
rem SPDX-License-Identifier: Apache-2.0
rem Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
rem Publishing a new version, step 1 of 2 - nothing goes public. Checks the build, scans the Setup
rem on VirusTotal and writes the release notes and the file list into dist-installer\ for review.
rem Details in scripts\release.ps1; the log is dist-installer\release-<version>-prepare.txt.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" -Step prepare
