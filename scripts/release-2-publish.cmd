@echo off
rem SPDX-License-Identifier: Apache-2.0
rem Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
rem Publishing a new version, step 2 of 2 - PUBLIC. Run it only after the owner has read what step 1
rem wrote and said go. Commits, tags, pushes and creates the GitHub release, then checks GitHub's copies.
rem Details in scripts\release.ps1; the log is dist-installer\release-<version>-publish.txt.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" -Step publish
