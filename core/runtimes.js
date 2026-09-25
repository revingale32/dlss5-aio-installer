// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Finding NVIDIA's runtime DLLs on the machine this is running on.
//
// These are not ours to ship. There is no public SDK for the DLSS 5 neural
// rendering runtime - the file in circulation came out of a shipped game - so
// the installer sources it from the user's own disk instead of carrying it in
// a zip. For anyone who owns a game that shipped it, that is one click.
//
// Search order is cheapest and most-likely first: a folder the user filled in
// deliberately, then the machine-wide set our own kit maintains, then any game
// that already has one.

const WANTED = {
  nr: 'nvngx_dlssnr.dll',       // required: the neural renderer
  sr: 'nvngx_dlss.dll',         // optional: super resolution / DLAA
  fg: 'nvngx_dlssg.dll',        // optional: frame generation
};

// A real runtime is tens of megabytes. A stub or a truncated download is not,
// and failing early with "that file is too small" beats a mystery crash inside
// NGX later.
const MINIMUM_BYTES = { nr: 40 * 1024 * 1024, sr: 4 * 1024 * 1024, fg: 1 * 1024 * 1024 };

// The exact runtime files this add-on build was validated with, by SHA-256.
// The neural renderer exists in exactly one public version (310.8.0.0, out of a
// shipped game) and the snippet itself refuses a modified copy with a permanent
// STANDBY/FAILED 0xBAD00002 that looks like "NR never starts" - so an unknown
// hash is refused here, early, with a message that says why. SR and FG come in
// many legitimate NVIDIA versions (the OTA feed alone has dozens); an unknown
// one there is a note, not a refusal. The 2026-09 lookalike/malware campaign in
// this scene is the other reason the check exists.
const KNOWN_GOOD = {
  nr: {
    'e16bcf15e16e13f527491cdf7845b2fe6521a738d8f7c9c721866a8496e1fc8e': { version: '310.8.0.0', bytes: 165840496 },
    // ShortFuse's cross-generation build of the same 310.8 runtime (RenoDX Discord, pinned
    // 2026-08-31; hash as published in the OptiScaler NR fork's install guide). Rewrites the
    // FP8 path to FP16 for RTX 20/30 and backports Blackwell-only functions for RTX 40; auto-
    // branches on hardware; RTX 50 path untouched. It is a modified NVIDIA binary, so
    // Windows reports its Authenticode signature as invalid - expected for this exact hash,
    // and the reason the hash, not the signature, is what we trust here.
    'e67dee209320cdafe0e93e45675d7aa34323a53acc57a72b2e40a181581c989a': {
      version: '310.8.0.0', bytes: null, modified: true,
      label: 'cross-generation build (RTX 20/30/40 capable; RTX 50 unchanged)',
    },
  },
  sr: { 'c85f971ce023c9f3492fc7455f0b01a24ba18ea39636407a846902c4360b0b7e': { version: '310.8.0.0', bytes: 58956400 } },
  fg: { '5d5cbf14d2727d47f93fd10bf77bd91708ae122482a6f86fd564971641ebd47b': { version: '310.8.0.0', bytes: 7453808 } },
};

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function fileVersion(file) {
  try { return require('./pe').getFileVersion(file) || null; } catch { return null; }
}

// Hash and version every located runtime and say whether each is a file this
// build was validated with. `allowUnknownNeural` turns the neural refusal into
// a warning - a deliberate user choice, off by default.
function verify(result, { allowUnknownNeural = false } = {}) {
  const details = {};
  const notes = [];
  let ok = true;
  let message = null;
  for (const kind of Object.keys(WANTED)) {
    const hit = result[kind];
    if (!hit) continue;
    let sha = null;
    try { sha = sha256(hit.file); } catch (error) { notes.push(`${WANTED[kind]} could not be read: ${error.message}`); continue; }
    const known = KNOWN_GOOD[kind][sha] || null;
    const version = fileVersion(hit.file);
    details[kind] = { sha, version, known: Boolean(known), knownVersion: known ? known.version : null, modified: Boolean(known && known.modified), label: known ? known.label || null : null };
    hit.sha = sha; hit.version = version; hit.known = Boolean(known); hit.modified = Boolean(known && known.modified);
    if (known && known.modified) {
      notes.push(`${WANTED[kind]} at ${hit.from} is the ${known.label} - a community-modified 310.8 runtime, matched by its `
        + 'published SHA-256. Windows will call its signature invalid; that is expected for this exact file. It runs on '
        + 'RTX 20/30/40 as well as 50; the community floor for playable speed is an RTX 3080.');
      continue;
    }
    if (known) continue;
    if (kind === 'nr') {
      const text = `${WANTED.nr} at ${hit.from} is not a validated copy (SHA-256 ${sha.slice(0, 16)}…`
        + `${version ? `, version ${version}` : ''}). The only public neural runtime is 310.8.0.0, `
        + 'SHA-256 e16bcf15…1fc8e, 165,840,496 bytes. A modified or truncated copy makes NVIDIA\'s runtime '
        + 'refuse with 0xBAD00002 and neural rendering silently never starts - and there are tampered copies '
        + 'circulating. Get it from a game that shipped it.';
      if (allowUnknownNeural) notes.push(`Allowed by your setting: ${text}`);
      else { ok = false; message = text; }
    } else {
      notes.push(`${WANTED[kind]}${version ? ` ${version}` : ''} at ${hit.from} is not the version this build was `
        + 'validated with (310.8.0.0). NVIDIA ships many versions of it and it will probably work; '
        + 'if upscaling or frame generation misbehaves, this is the first thing to swap.');
    }
  }
  return { ok, message, notes, details };
}

function localAppData() {
  return process.env.LOCALAPPDATA || (process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'AppData', 'Local')
    : null);
}

function defaultSearchDirs(appRoot) {
  const dirs = [];
  if (appRoot) dirs.push(path.join(appRoot, 'runtimes'));
  const local = localAppData();
  if (local) dirs.push(path.join(local, 'RHI', 'Custom', 'Addons'));
  return dirs;
}

function inspectDir(dir) {
  const found = {};
  for (const [kind, file] of Object.entries(WANTED)) {
    const full = path.join(dir, file);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    found[kind] = { file: full, bytes: stat.size, plausible: stat.size >= MINIMUM_BYTES[kind] };
  }
  return found;
}

// Merge candidates, preferring the first directory that offers each file.
function locate({ appRoot = null, extraDirs = [], games = [] } = {}) {
  const searched = [];
  const result = { nr: null, sr: null, fg: null, searched };
  const dirs = [...defaultSearchDirs(appRoot), ...extraDirs, ...games.map(game => game.dir)];
  for (const dir of dirs) {
    if (!dir) continue;
    const found = inspectDir(dir);
    searched.push({ dir, found: Object.keys(found) });
    for (const kind of Object.keys(WANTED)) {
      if (!result[kind] && found[kind]) result[kind] = { ...found[kind], from: dir };
    }
    if (result.nr && result.sr && result.fg) break;
  }
  return result;
}

function describe(result) {
  if (!result.nr) {
    return {
      ok: false,
      message: 'nvngx_dlssnr.dll was not found on this PC. It is NVIDIA\'s neural rendering '
        + 'runtime and is not shipped with this installer. Point at a game that already has '
        + 'it, or drop it into the runtimes folder.',
    };
  }
  if (!result.nr.plausible) {
    return {
      ok: false,
      message: `The nvngx_dlssnr.dll found at ${result.nr.from} is only `
        + `${(result.nr.bytes / (1024 * 1024)).toFixed(1)} MB. The real runtime is around 158 MB, `
        + 'so this one is a stub or an incomplete copy.',
    };
  }
  const optional = ['sr', 'fg'].filter(kind => !result[kind]);
  return {
    ok: true,
    message: optional.length
      ? `Neural rendering runtime found. ${optional.map(k => WANTED[k]).join(' and ')} `
        + 'not found - upscaling and frame generation will be unavailable until they are.'
      : 'All three NVIDIA runtimes found.',
  };
}

module.exports = { WANTED, MINIMUM_BYTES, KNOWN_GOOD, locate, inspectDir, describe, verify, sha256, defaultSearchDirs };
