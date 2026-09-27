**Made by Revin ([revingale32](https://github.com/revingale32)).** This page is the only official download — a copy from anywhere else did not come from me and may not be safe. Check the SHA-256 below.

## Download

**`{{SETUP}}`** (below, under Assets). Run it: it installs per-user (no admin prompt), lets you pick the folder, and adds Start Menu and desktop shortcuts plus an uninstaller. Already on 0.4.0 or newer? The app offers this version by itself — or press *Check for updates* on its About page.

It is not code-signed, so Windows SmartScreen says "unknown publisher" the first time: **More info → Run anyway**.

## What it does

- **Games** — installs the Standalone DLSS-NR + SR neural rendering add-on (build `{{BUILD}}`) into your games. Every file it touches is backed up first and verified by checksum; *Restore originals* puts a folder back exactly as it was. 32-bit games run through the neural relay; games with native ray reconstruction get the OptiScaler NR route. Anti-cheat is detected and named — never bypassed.
- **Media** — DLSS 5 neural rendering on your own pictures and videos (new files next to the originals, never over them) and live on your desktop, with a before/after split (Ctrl+Alt+S).

## What you need

- An NVIDIA GeForce RTX 50-series card and a current driver (older RTX cards only with the community-patched runtime — see the README).
- NVIDIA's neural rendering runtime, `nvngx_dlssnr.dll` 310.8.0.0, already on your PC from a game that shipped it. **It is not included and never will be** — the app finds it and checks its SHA-256.

{{NEW}}

## Checksums (SHA-256)

| File | SHA-256 |
|---|---|
| `{{SETUP}}` | `{{SETUP_SHA256}}` |
| `latest.yml` (read by the app's updater) | `{{YML_SHA256}}` |

Verify on Windows: `certutil -hashfile {{SETUP}} SHA256`
{{VIRUSTOTAL}}

---

Free and open source under the Apache License 2.0 — keep the credit and the NOTICE file if you share it. Built from kibblerz's [DLSS5-Reshade-AIO](https://github.com/kibblerz/DLSS5-Reshade-AIO) (Apache 2.0), with ReShade 6.8 (BSD 3-Clause) and wilsjo2's OptiScaler NR fork v0.8.8 (GPL-3.0). Not affiliated with, endorsed by or sponsored by NVIDIA; NVIDIA and DLSS are trademarks of NVIDIA Corporation.
