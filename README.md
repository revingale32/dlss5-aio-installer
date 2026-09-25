# DLSS 5 AIO Installer

Installs the **Standalone DLSS-NR + SR** neural rendering build (`2.2.4-revin4`) into your games, and runs DLSS 5 neural rendering on your own pictures, videos and desktop. App version 0.4.0.

**Made by Revin ([revingale32](https://github.com/revingale32)).** The only official download is
[github.com/revingale32/dlss5-aio-installer](https://github.com/revingale32/dlss5-aio-installer/releases);
every release lists its SHA-256, and a copy from anywhere else did not come from Revin and may not be safe.
It is free and open source under the Apache License 2.0: you may share it or a version you changed, as
long as the NOTICE file and the copyright lines stay with it and your changes are marked; the licence gives
no right to use these names to promote another version. Not affiliated with, endorsed by or sponsored by
NVIDIA; NVIDIA and DLSS are trademarks of NVIDIA Corporation.

This is not the swapper it was inspired by. That app is a front end for other people's renderers and
installs whichever one fits. This one installs ours — with one deliberate exception: a game that ships
native ray reconstruction (PRAGMATA) structurally cannot host our standalone, so for those it lays down
the OptiScaler neural-rendering fork instead. Two routes, chosen by what is in the game folder, both
backed up and both restorable.

## Status

The core is built and tested; the app is built and checked both statically and by rendering it.

| Piece | State |
|---|---|
| `core/vdf.js` — Valve KeyValues reader | done, tested against real Steam files |
| `core/pe.js` — bitness + graphics API from the PE headers | done, tested against real game executables |
| `core/scan.js` — Steam libraries, Xbox Game Pass, executable ranking | done, tested |
| `core/journal.js` — write-ahead backup, rollback, crash recovery | done, tested |
| `core/ini.js` — CRLF-safe ReShade.ini editing | done, tested |
| `core/anticheat.js` — detection and the warning text | done, tested |
| `core/runtimes.js` — find NVIDIA's DLLs on this PC | done, tested |
| `core/install.js` — plan / apply / restore, with a manifest and history | done, tested |
| `core/logreport.js` — read `standalone-dlssnr.log` and grade it | done, verified against a real log |
| `core/profiles.js` — per-game settings, manual folders, runtime folders, app settings | done, tested |
| `core/covers.js` — cover art from disk: yours, the cache, Steam's own | done, tested |
| `core/artwork.js` — missing art from Steam's public store, cached beside the app | done, tested with a fake network |
| `core/activity.js` — what the app did this session | done, tested |
| `core/machine.js` — this PC against what each runtime needs: GPU generation, driver, HAGS | done, tested |
| `cli/cli.js` — headless driver for all of the above | done, tested end to end |
| `core/media.js` / `core/mediarun.js` — the Media view's settings, job lists and worker runner | done, tested |
| `media-worker/` — `dlss5-media.exe`: NR on pictures, videos and the live desktop | done, tested on the RTX 5070 Ti (see below) |
| `main.js` / `preload.js` / `ui/` — the Electron app | done, wiring verified, rendered in both themes |
| Windows installer | done — one file, `DLSS 5 AIO Installer <version> Setup.exe`, in `dist-installer\`; built for you, hash-verified |
| Hardening (2026-09-19): runtime hash gate, verify, safe restore, release hashes | done, tested — see below |

`npm test` runs 149 tests. They cover the things that would be expensive to get wrong: Windows path
escapes in `libraryfolders.vdf`, telling a launcher apart from the game, CRLF survival when editing
someone's ini, a failed install putting every byte back, a kit installed by hand being recognised
and left alone, and a network failure never being mistaken for "this game has no art".

The UI has two kinds of check. Nobody can open a window from where this is built, so the three files
that must agree — the page calling `window.api.X`, the preload bridge exposing `X`, and the main
process handling its channel — are checked against each other in both directions, along with every
element id the page looks up, every CSS class it applies, both themes defining the same tokens, and
the rules that it never builds DOM from a string, never carries a URL, and never reads a dropped
file's path itself. Then `node test/visual/shoot.js` renders the real page in headless Chromium with a
stand-in `window.api` and screenshots every view in both themes, which is how the layout was looked
at before it shipped.

## The app

A frameless window with its own title bar, a sidebar, and everything floating on one gradient. Dark
by default — it is a library of covers — with a light theme one click away, top right.

- **Home** — drop a game folder (or its executable) on the window, or browse for one; the games you
  installed into most recently; and what the app did this session, with a copy button.
- **Games** — every Steam and Xbox Game Pass title on the PC plus anything you added, as a grid of
  covers grouped by store. Search, filter by rendering API or add-on state, and the store switch
  (All / Steam / Xbox / Added) with the store's own colour. Each cover carries the API and whether
  the add-on is in.
- **The game sheet** — opens over the library: banner, cover, what was found (executable, bitness,
  API and how it was found, ReShade hook, add-on state, NVIDIA runtime, backup), the exact files
  that will be written, the start-up settings, and Install / Restore originals. Anti-cheat gets a
  red banner and an explicit "I understand" button before Install does anything, and that consent
  is never remembered.
- **Media** — DLSS 5 neural rendering on your own pictures and videos, or live on the desktop.
  See *Pictures, videos and the desktop* below.
- **Runtimes** — where NVIDIA's DLLs were found, and a button to point at a folder.
- **Log** — `standalone-dlssnr.log`, read and graded.
- **Settings** — theme, artwork fetching, the covers folder, extra runtime folders.
- **About** — what ships, what does not, the licences, and the two rules.

### What a fresh install starts at

Deliberately the lightest settings the kit has, not the prettiest: **one neural pass, model 1, frame
generation off.** That is a starting point, not a recommendation — every one of them is a live toggle
in the ReShade overlay (press Home in game), so whoever installed it decides what their own card and
their own eyes want. Frame generation starts off because it routes presentation through a composited
overlay that costs real latency; it is worth turning on in a slower game and usually not in a shooter.

### The neural relay (32-bit games)

A **32-bit** game cannot load a 64-bit add-on, so it takes the **neural relay** route. The 32-bit
ReShade goes beside the game with one tiny add-on, `neural-relay-launcher.addon32`, whose only job
is to start `neural-relay.exe` when the game starts and cap the game's frame rate at the monitor's
refresh (90 at most) so it does not starve the neural work. The relay lives in a `neural-relay`
folder beside the game with its own 64-bit ReShade, the same add-on and the same profile: it
captures the game window, runs neural rendering on those frames and shows the result in a
click-through overlay over the game. The game has to run windowed or borderless (the relay cannot
capture exclusive fullscreen); Ctrl+Alt+M hands input to the relay so Home opens its menu. That is
how Aliens vs. Predator has been running here all along; the sheet explains the route in plain words
before Install does anything. Restore removes both halves.

### Kits you installed by hand

The app does not assume it is the only way the kit ever got into a game. Every scan also looks for
the add-on on disk — in the game folder, or in a relay folder for a 32-bit game — and reads the
build number straight out of the binary. A game found that way is shown as **Installed · found**,
with "not installed by this app, so no backups yet" on its sheet: Install from there replaces the
kit with this build and backs up what is there now, while Restore stays off because there is nothing
recorded to put back.

### Three routes into a game

A **64-bit** game gets the kit in its own folder: ReShade (add-on build) as the hook DLL the game
will load, plus `standalone-dlssnr.addon64`, the two companion shaders, and a `[Standalone.DLSSNR]`
profile in `ReShade.ini`. A game that ships its own DLSS (Streamline and `nvngx_dlss*.dll` in the
folder — GTA V Enhanced, Black Ops III) runs this route fine; the plan just reminds you to leave the
game's *own* frame generation off, because two frame generators in one game break the presentation.

A **32-bit** game takes the **neural relay** route (above).

A game that ships **native ray reconstruction** — `nvngx_dlssd.dll` / `sl.dlss_d.dll` beside the
executable, RE Engine titles like PRAGMATA — takes the **OptiScaler route**. Ray reconstruction is
NVIDIA's neural denoiser wired deep into the engine's own DLSS pipeline; our standalone add-on runs a
second neural pipeline beside that, and the two fight (PRAGMATA froze at 1 fps this way, with every
neural frame reporting success). So for those games the installer lays down
[wilsjo2/OptiScaler-DLSSNR-PreSR-Multipass](https://github.com/wilsjo2/OptiScaler-DLSSNR-PreSR-Multipass)
instead — an OptiScaler fork that puts neural rendering *inside* the game's own DLSS pass, before its
upscaling and ray reconstruction. It is what the community runs PRAGMATA on. The plan places
`OptiScaler.dll` as `dxgi.dll` (or `winmm.dll` if another loader already owns `dxgi.dll`), its
`OptiScaler\` backend folder, an `OptiScaler.ini` with neural rendering on, before SR, one pass, and a
copy of **your own** `nvngx_dlssnr.dll` beside it, because that is where the fork looks. Turn DLSS on in
the game's settings; Insert opens OptiScaler's menu. Anything of the standalone kit already in that
folder is moved aside first — the fork's own guide says two neural injectors cannot coexist — and
Restore puts it back. The route is automatic but not forced: `plan(target, { route: 'game' })` (and the
CLI's `--route`) overrides it either way.

OptiScaler is GPL-3.0 and ships no NVIDIA files; its licence and the archive's own `SHA256SUMS.txt`
travel in `payload\optiscaler\`, and the bundled archive is verified against the release's published
SHA-256 before it goes in.

### The cross-generation runtime

The stock `nvngx_dlssnr.dll` 310.8 is RTX 50-only. ShortFuse published a modified build of the same
runtime (pinned in the RenoDX Discord) that rewrites its FP8 path to FP16 for RTX 20/30 and backports
the Blackwell-only functions for RTX 40, branching on the card at run time. The installer's runtime gate
knows that file by its published SHA-256 (`e67dee20…`) and accepts it as a second known-good — flagged
as modified, because Windows will call its NVIDIA signature invalid, which is expected for that exact
hash and nothing else. On such a runtime the "needs Blackwell" check is waived. The community's floor
for playable speed is an RTX 3080; on RTX 30 the hook-based tools need driver 616.56, which this kit
does not (it loads the runtime directly). Nothing here ships that file; it is imported from your PC
like every other runtime.

Since 2026-09-21 ShortFuse also publishes **OpenNR** ([clshortfuse/openNR](https://github.com/clshortfuse/openNR),
MIT), a source toolchain that rebuilds exactly that file (`e67dee20…`) from your own stock 310.8.0.0
runtime (`e16bcf15…`) - no patched binary to download. It needs Visual Studio 2022, CMake and the CUDA
Toolkit; on an RTX 20/30/40 the installer's readiness check points there.

### One runtime set, machine-wide

The add-on wants the NVIDIA runtimes (`nvngx_dlssnr.dll`, `nvngx_dlss.dll`, `nvngx_dlssg.dll`) and
the caller bridge `nvngx.dll` in **one** folder, and it looks in the add-on's own folder, the game
folder, the working directory and `%LOCALAPPDATA%\RHI\Custom\Addons`, in that order. The installer
does not scatter copies per game. It assembles the set once in `%LOCALAPPDATA%\RHI\Custom\Addons`:
a runtime already in that folder is used from there, the pieces it lacks are copied in from wherever
they were found (the app's own `runtimes/` folder first, if you filled it), and a file that is already
there byte-for-byte is skipped. So every game on the PC finds the same runtimes, and one place is all
that ever needs updating. Those shared files are listed in the plan as *machine-wide, shared*, and
Restore never touches them, because another game may be using them.

### Can this PC run it?

Every NGX runtime exports the lowest GPU generation it accepts (`NVSDK_NGX_GetGPUArchitecture`, a
constant read straight off the file), and the DLSS 5 neural renderer in circulation answers
**Blackwell** — its kernels are compiled for RTX 50 only. The installer reads that number from each
runtime it finds, asks the driver what card is in the machine (`nvidia-smi`, WMI as a fallback),
checks hardware-accelerated GPU scheduling (frame generation silently refuses without it), and says
so under **Runtimes → This PC** and on every game sheet. When the neural renderer cannot run on the
card, Install is blocked with one plain sentence instead of writing a dead add-on. An unrecognised
card is never guessed and never blocked.

A game folder that already holds an `nvngx.dll` that is not this kit's caller bridge (another DLSS
tool's, typically 10 KB) would be loaded by the add-on ahead of ours and crash DLSS SR creation
(upstream issue #6). The plan shows it, the install renames it to `nvngx.dll.dlss5-parked` with a
backup, and Restore originals puts it back.

### Artwork

Steam's client already caches library art for every Steam game, so those covers come straight off
the disk. Xbox and hand-added titles have no local art, so — if the setting is on, and it is on by
default — the app asks Steam's public store search for the title, then fetches `library_600x900.jpg`
and `library_hero.jpg` from Steam's CDN. No account, no key, nothing to register; a game bought on
Game Pass finds its art as long as the same game exists on Steam, which is nearly all of them.
Everything fetched lands in `covers/` beside the app, so it happens once, works offline afterwards,
and travels with a portable copy. Misses are remembered for a week so a game that is not on Steam is
not searched for on every launch; a network failure is never recorded as a miss.

Your own picture always wins: a `cover.jpg` (or `hero.jpg`) next to the game, or a file named after
the game in `covers/`.

## Pictures, videos and the desktop

New in 0.3.0 (0.3.1–0.3.2: local-time activity log; desktop mode renders only real changes, nothing extra;
0.3.3: desktop before/after split, look changes while it runs, a proper overlay layer). The idea came from the DLSS 5 tools people built this month to run neural rendering
outside games — MPCVR-DLSS5 for video playback, DLSS5-Image-Converter for stills — and the
"DLSS 5 manager/dashboard" lookalike repos that promise the same and ship something else. This is
our own, in the app, with the runtime check the installs already have.

- **Pictures** — drop them in or browse; PNG, JPEG, TIFF, BMP, WebP, HEIC. Colour profiles and
  camera rotation are honoured. Results go beside the originals (or to a folder you pick) as
  `name_dlss5.png`; an original is never overwritten. Click a finished one for a before/after wipe.
- **Videos** — anything Windows can play. Every frame goes through NR with NVIDIA Optical Flow
  motion and an anti-shimmer stabiliser (the MPCVR-DLSS5 idea), and the result is an MP4: H.264 or
  HEVC on NVENC, sound copied untouched, BT.709-tagged, starting at 0:00 in step with the sound. An
  8-second 1080p clip took 6.6 s on the RTX 5070 Ti (5.4 ms NR per frame). HDR videos come out SDR —
  Windows converts them before NR sees them — and the app says so.
- **Desktop** — one monitor, live: the desktop is captured, rendered, and shown in a click-through
  layer that is excluded from capture, so the real desktop and every click are underneath it.
  Ctrl+Alt+N hides/shows the effect, **Ctrl+Alt+S splits the screen** — left half as it is, right
  half DLSS 5 — and Ctrl+Alt+End stops it. Change the look while it runs and the screen follows on
  the next frame. HDR desktops work (Windows' SDR white level is read and followed). Only a real
  change on screen is rendered, so a still desktop costs nothing; a moving one measured 7.5–8.5 ms
  NR at 2560×1440 and about 9 ms from capture to screen — 16.5–18 ms with the anti-shimmer on, which
  runs NVIDIA Optical Flow on every frame.
  It cannot see a game in exclusive fullscreen — for games, install the add-on instead.

  The default look is light on purpose: one pass of the default style moves a picture by 4–6 levels
  out of 255 on average, which is easy to miss when the whole screen changes at once. Turn the split
  on to see it, or pick *Cinematic* with 2–3 passes for the strongest look (13–24 levels on average).

The look settings (style, strength, skin, passes, work size) are the add-on's, and start where the
add-on starts. It all runs through `payload\media\dlss5-media.exe`, a separate program written for
this app (source in `media-worker/`), so a crash in NVIDIA's runtime can never take the app down. It
uses the same `nvngx_dlssnr.dll` from your PC as the installs, under the same hash check.

## Updates

From 0.4.0 the app updates itself from its own GitHub releases. The first time it starts it asks
whether it may look for new versions. With a yes, it asks the official page
([github.com/revingale32/dlss5-aio-installer](https://github.com/revingale32/dlss5-aio-installer/releases))
for the newest version number each time it starts — nothing else is sent. When a newer release is out,
a bar offers **Update**: the new Setup downloads inside the app, its SHA-512 is checked against the
release's `latest.yml`, and **Restart to update** installs it over the old version, keeping settings,
per-game profiles and cover art. *Check for updates* on the About page works any time, and Settings
turns the start-up check on or off.

A release therefore carries two files: the Setup and `latest.yml`, both written to `dist-installer\` by
the build. Releases are uploaded by hand from the official account — the build never publishes by
itself (`--publish never`). Copies on 0.3.x have no updater; they need 0.4.0 installed by hand once.

## Two rules the code enforces, not just documents

**Never bypass anti-cheat.** `core/anticheat.js` finds EasyAntiCheat, BattlEye, Denuvo AC, Ricochet,
GameGuard and Vanguard, and says plainly what will happen and whose risk it is. Nothing disables,
patches or hides from any of them. A game with anti-cheat in it is a game to leave alone, or to run a
build of that has none.

**Never destroy a file.** Nothing is overwritten until a byte-for-byte copy exists on disk and
verifies by SHA-256. If an install throws halfway, every file goes back. If the process dies
mid-install, the next run finds the journal and puts the folder back before doing anything else.

There is a third rule the installer cannot enforce on its own, so it checks instead: **never write a
game's `ReShade.ini` while that game is running** — ReShade rewrites the whole file from memory when
it exits and silently discards anything changed underneath it.

## What ships in the box

Ours to ship: the add-on (`standalone-dlssnr.addon64`, Apache 2.0, built from kibblerz's
DLSS5-Reshade-AIO 2.2.4 with our changes), the AIO bridge `nvngx.dll`, the `[Standalone.DLSSNR]`
defaults, the two `.fx` shaders, the neural relay for 32-bit games (`neural-relay.exe` and
`neural-relay-launcher.addon32`, written for this kit; their source is in `payload/relay/src`), and
the media worker (`payload/media/dlss5-media.exe`, Apache 2.0, written for this app; source in
`media-worker/`, with kibblerz's optical-flow provider and NVIDIA's MIT-licensed Optical Flow headers). Our code
and our changes are Copyright 2026 Revin (revingale32); kibblerz's original add-on code is Copyright 2026
kibblerz. Both are Apache 2.0, and `NOTICE` carries both credits.

Shipped under its own licence: **ReShade 6.8.0**, the add-on-enabled build, 64-bit and 32-bit
(`ReShade64.dll`, `ReShade32.dll`), by Patrick Mours and contributors, BSD 3-Clause —
`payload/RESHADE-NOTICE.txt` and `payload/RESHADE-LICENSE.txt` travel with it.

Not ours to ship: **NVIDIA's runtime DLLs** (`nvngx_dlssnr.dll` and friends). There is no public SDK
for DLSS 5 neural rendering; the runtime in circulation was lifted out of a game build. The installer
therefore imports them from your own machine — it looks in `%LOCALAPPDATA%\RHI\Custom\Addons` and in
games that already have them, and offers a browse button. One click if you own any game that shipped
them, and nothing of NVIDIA's travels in a zip with your name on it.

If you want a fully self-contained copy for your own machine, drop the DLLs into `runtimes/` and the
installer will use them from there. That is your copy on your disk, which is a different thing from
handing it out.

## Running it

```
npm install          # once
npm test             # the suite above
npm run cli -- scan            # your Steam and Xbox games, with the executable and API detected
npm run cli -- runtimes        # where NVIDIA's DLLs were found on this PC
npm run cli -- plan "<folder>" # exactly what an install would do, touching nothing
npm run cli -- install "<folder>" [--passes 3] [--accept-anticheat]
npm run cli -- restore "<folder>"
npm run cli -- log             # read standalone-dlssnr.log and say what the numbers mean
npm start                      # the app, from source
node test/visual/shoot.js      # render every view in both themes to test/visual/shots (needs playwright)
```

## What changed on 2026-09-19 — trust and updates

The scene this app lives in picked up lookalike repos, a hijacked project account and repacked
installers carrying a miner in September 2026, and NVIDIA's neural runtime refuses a modified copy
*silently* (`0xBAD00002`, "NR never starts"). So:

- **Runtime hash gate.** `nvngx_dlssnr.dll` must be the exact 310.8.0.0 file this build was
  validated with (SHA-256 `e16bcf15…1fc8e`, 165,840,496 bytes) or the install is refused with a
  message that says why. `nvngx_dlss.dll` / `nvngx_dlssg.dll` come in many legitimate versions, so
  an unknown one there is a note, not a refusal. The Runtimes page shows every file's version,
  SHA-256, whether it is a validated copy and who signed it (Windows' own Authenticode verdict).
  Settings → "Allow an unvalidated neural runtime" turns the refusal into a warning; CLI:
  `--allow-unknown-runtime`. Off by default, on purpose.
- **Verify.** Every installed file's hash is recorded in the manifest. The game sheet's **Verify**
  button (CLI `verify <folder>`) checks that what we installed is still on disk unchanged; a game
  update or a Steam file verification that overwrote the add-on shows up as *Changed since the
  install* instead of looking installed while being gone.
- **Restore that cannot corrupt a game.** "Restore originals" leaves alone any file that changed
  after the install (the newer file is what the game wants) and says so; `restore --force`
  overrides. A reinstall keeps the *first* original ever backed up, however many installs later —
  our own previous file is never mistaken for the game's.
- **Not writable = refused first.** Xbox app game folders are locked until *Enable mod support*
  in the Xbox app (some also need the installer run as administrator); the plan says exactly that
  before a single backup starts.
- **Releases carry their hashes.** `Rebuild-Installer.bat` runs the tests, builds, and writes
  `dist-installer\SHA256SUMS.txt` plus a `RELEASE-NOTES-hashes.txt` block to paste; the app logs
  its own version, add-on build and payload hash on its first activity line. Publish the hashes and
  a VirusTotal link with every release, and never from an account that is not yours.

## One file to run, one file to hand out

`dist-installer\DLSS 5 AIO Installer <version> Setup.exe` is the whole product. Run it and it installs
like any Windows program — per-user, so no admin prompt; pick a folder if you like; Start Menu and
desktop shortcuts; an entry in Add/Remove Programs with a working uninstaller. The app you then open
from the Start Menu is the app. The same file is what anyone else gets.

An update is a new Setup run over the old one; the installer replaces the program and leaves your
settings, per-game profiles and cover art where they are (in your per-user app-data folder). There is
no separate portable build and no folder of DLLs to carry around — that was tried and it only added
copies to keep straight.

The Setup is built for you — Claude builds it in the cloud workspace (Linux + wine handles NSIS's
two-pass uninstaller) and delivers the finished file, hash-verified against the one it built.
`Rebuild-Installer.bat` is the local fallback if you ever want to build it yourself: it runs the full
test suite first (a failing test means no build), then builds, then writes the release hashes.

Your NVIDIA runtime DLLs are **not** inside the Setup — same rule as always, they are read from
your PC. The OptiScaler payload is, which is why the file is a few hundred megabytes.

