# dlss5-media — the Media view's worker

`payload\media\dlss5-media.exe` is the program behind the AIO's **Media** view. It runs DLSS 5 neural
rendering (NVIDIA's `nvngx_dlssnr.dll`, feature 0x12) outside a game, on:

- **pictures** — PNG, JPEG, TIFF, BMP, WebP, HEIC (whatever Windows' WIC can read). ICC profiles are
  converted to sRGB and EXIF rotation is applied first. Results are PNG / JPEG / TIFF.
- **videos** — anything Windows' Media Foundation can decode. Each frame goes through NR with NVIDIA
  Optical Flow motion and an anti-shimmer stabiliser; the result is an MP4 (H.264 or HEVC, NVENC when
  the driver offers it), tagged BT.709 limited range, no B-frames, with an edit list so the picture
  starts at 0:00 in step with the sound. AAC audio is copied untouched, anything else re-encoded to AAC.
- **the desktop** — one monitor is captured with DXGI Desktop Duplication, rendered, and shown in a
  click-through, topmost layer that is excluded from capture (so it never sees itself). The layer is a
  DirectComposition swap chain (`--present hwnd` swaps in a plain flip-model window, kept as a
  fallback). HDR desktops are handled in scRGB with Windows' SDR white level. Only a real change on
  screen is rendered — a still desktop costs next to nothing — and the capture is looked at no more
  often than the frame cap. Ctrl+Alt+N hides/shows it, Ctrl+Alt+S splits the screen into before
  (left) and after (right), Ctrl+Alt+End stops it.

The originals are never touched: every result is written under a new name, to a temporary file first,
and moved into place only when complete.

It is a plain console program that talks JSON lines on stdout (one event per line) and takes
`cancel` / `stop` on stdin. In desktop mode it also takes, one per line, `look style=2 passes=3
intensity=1 tone=1 structure=1 skin=-1 automask=1 mix=1 stabilize=0.6 work=8.3 fps=60` (any subset —
the look, working size and frame cap change on the next frame), `split 0|1` and `snapshot`. The app starts it; you normally never run it
yourself. For testing:

```
dlss5-media.exe --mode probe    --nr <nvngx_dlssnr.dll> --bridge <payload\nvngx.dll>
dlss5-media.exe --mode monitors
dlss5-media.exe --mode image    --nr ... --bridge ... --list pictures.txt   (lines: input<TAB>output)
dlss5-media.exe --mode video    --nr ... --bridge ... --list videos.txt [--stabilize 0.6] [--codec hevc]
dlss5-media.exe --mode desktop  --nr ... --bridge ... [--monitor 0] [--fps-cap 60] [--duration 20] [--split 1]
dlss5-media.exe --mode video --passthrough 1 --list ...   (no NR - checks decode/encode alone)
```

Desktop diagnostics: `--snapshot-dir <dir>` saves a before/after pair of PNGs three seconds in (and on
each `snapshot` command); `--overlay-check 1` shows the layer *visible* to capture with a magenta
corner and reports whether the capture saw it (proves the layer reaches the screen); `--overlay-check 2`
keeps it hidden from capture, presents for two seconds and reports whether the corner ever leaked in;
`--diff-dump <dir>` saves the first three frames the change detection flagged, with a map of what
changed.

It must not sit next to a file called `nvngx.dll`: NVIDIA's NGX loader looks beside the running exe
first. That is why it lives in `payload\media\` while the AIO's caller bridge is `payload\nvngx.dll`.

## Measured on the RTX 5070 Ti, driver 617.14 (2026-09-25)

| Job | Result |
|---|---|
| Probe (256×256) | NR created in 298 ms, 1.9 ms per evaluation |
| GTA V picture, 2560×1440 | 6.5–8.4 ms NR, about 0.6 s per picture including PNG encode |
| 8 s 1080p30 clip (240 frames) | 5.4 ms NR per frame, 57 frames per second steady, 6.6 s total, audio copied |
| Colour bars through decode/encode alone | Y/U/V within ±1 of the source (BT.709 tagged and untagged) |
| HDR desktop, 2560×1440 | 8.5 ms NR, 8.8 ms whole frame on the GPU, ~18 ms from capture to screen, 55 fps when the screen keeps changing |
| SDR desktop, 2560×1440 | 7.5–8.5 ms NR with one pass (4.9 ms at a 2.1 MP working size, 15.6 ms Cinematic with two passes, ~27 ms with three); capture to screen ~9 ms without the anti-shimmer, 16.5–18 ms with it |
| Layer checks (both present modes) | visible test: magenta read back exactly; hidden test: 108 frames over 2 s while presenting, never seen |
| Capture pacing | frames looked at on an idle desktop: ~300–350/s before, ≤ 60/s (the cap) after |

How strong the looks are, measured on a 1440p GTA V still and a 1080p RE2 still (the largest change of
R, G or B in each pixel, out of 255): the default style with one pass averages 4–6 levels and moves at
most 5% of the pixels by more than 20 — hard to see without the split. Three passes roughly doubles
any style. Cinematic with three passes averages 13–24 levels and moves 18–33% of the pixels by more
than 20.

Good to know: a window that hides itself from screen capture only part of the time makes the capture
flip between two pictures, and each flip is a "change" that gets rendered. Claude's "using your
computer" border does this while Claude is driving the PC (measured: ~16 renders a second on an
otherwise still desktop); nothing in normal use has shown it.

## Building

Cross-compiled on Linux with clang and the mingw-w64 headers (`build.sh`); the result links only
Windows system DLLs. Two things are not in this folder:

- `third_party/ngx/` — the NGX headers (`nvsdk_ngx.h`, `nvsdk_ngx_defs.h`, `nvsdk_ngx_params.h` and
  what they include). They are NVIDIA's, under the NVIDIA RTX SDKs licence; the copy used is the one
  in the add-on's source, `DLSS5-Reshade-AIO/external/DLSS5-Feeder/external/ngx/`.
- NVIDIA's runtime. `nvngx_dlssnr.dll` is read from the user's PC (the same hash-checked file the
  installs use) and is never shipped.

`third_party/nvof/nvof-motion-provider.*` is from kibblerz's DLSS5-Reshade-AIO (Apache 2.0);
`nvOpticalFlowCommon.h` / `nvOpticalFlowD3D12.h` are NVIDIA's Optical Flow SDK headers (MIT).
`test/mp4fix_test.cpp` is a small harness for the MP4 start fix (`src/mp4fix.cpp`), runnable under wine.

Copyright 2026 Revin (revingale32). Licence: Apache 2.0, like the rest of the AIO. Written for this app
by Revin, with Claude. Official download: https://github.com/revingale32/dlss5-aio-installer
