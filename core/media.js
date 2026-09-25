// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');

// DLSS 5 on pictures, videos and the live desktop.
//
// The work itself happens in payload\media\dlss5-media.exe, a small D3D12
// program that reaches NVIDIA's neural rendering runtime the same way the
// game add-on does (the runtime's own exports, through our nvngx.dll caller
// bridge) - so it runs on the driver versions the add-on runs on. This module
// is everything around it that can be tested without a GPU: which files are
// pictures or videos, where results go, what the settings are allowed to be,
// the exact command line, and reading the worker's one-JSON-object-per-line
// progress stream.

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.jfif', '.bmp', '.tif', '.tiff', '.gif', '.webp', '.heic', '.heif', '.avif', '.jxr', '.wdp'];
const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.avi', '.wmv', '.webm', '.ts', '.m2ts', '.mts', '.3gp', '.flv'];

// Every knob, its default and its range. Conservative on purpose: one pass,
// the lightest style, full strength, nothing the user did not ask for.
const DEFAULTS = Object.freeze({
  style: 0,            // 0 Default, 1 Natural, 2 Cinematic (DLSSNR.Style)
  intensity: 1,        // 0..1 - the runtime caps it at 1
  tone: 1,             // local tone 0..2
  structure: 1,        // local structure 0..2
  skin: -1,            // -1 = follow structure, else 0..0.99 (needs the skin mask)
  autoMask: true,      // automatic skin mask
  passes: 1,           // 1..3
  mix: 1,              // 0..1 strength of the effect on the picture
  maxWorkMP: 8.3,      // work size cap in megapixels (0 = always full size); 8.3 = 3840x2160
  refine: 1,           // stills: evaluations of the same frame
  imageFormat: 'png',  // png | jpg | keep
  jpegQuality: 95,
  codec: 'h264',       // h264 | hevc
  quality: 'high',     // standard | high | max
  audio: 'copy',       // copy | aac | none
  stabilize: 0.6,      // 0..1 anti-shimmer for video and desktop
  motionToNr: false,
  sceneCut: 0.24,
  suffix: '_dlss5',
  outputDir: '',       // '' = next to each original
  monitor: -1,         // -1 = primary
  fpsCap: 60,          // desktop mode, 0 = uncapped
  split: false,        // desktop mode: left half original, right half DLSS 5
});

const WORK_SIZES = [0, 8.3, 3.7, 2.1];   // full, 4K, 1440p, 1080p

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function int(value, fallback, min, max) {
  const n = num(value, NaN, min, max);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// Only known keys, only valid values; anything else becomes the default.
function normalize(input) {
  const s = input && typeof input === 'object' ? input : {};
  const skinRaw = num(s.skin, DEFAULTS.skin, -1, 0.99);
  const suffix = typeof s.suffix === 'string' ? s.suffix.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').slice(0, 40) : DEFAULTS.suffix;
  return {
    style: int(s.style, DEFAULTS.style, 0, 2),
    intensity: num(s.intensity, DEFAULTS.intensity, 0, 1),
    tone: num(s.tone, DEFAULTS.tone, 0, 2),
    structure: num(s.structure, DEFAULTS.structure, 0, 2),
    skin: skinRaw < 0 ? -1 : skinRaw,
    autoMask: typeof s.autoMask === 'boolean' ? s.autoMask : DEFAULTS.autoMask,
    passes: int(s.passes, DEFAULTS.passes, 1, 3),
    mix: num(s.mix, DEFAULTS.mix, 0, 1),
    maxWorkMP: num(s.maxWorkMP, DEFAULTS.maxWorkMP, 0, 268),
    refine: int(s.refine, DEFAULTS.refine, 1, 16),
    imageFormat: oneOf(s.imageFormat, ['png', 'jpg', 'keep'], DEFAULTS.imageFormat),
    jpegQuality: int(s.jpegQuality, DEFAULTS.jpegQuality, 1, 100),
    codec: oneOf(s.codec, ['h264', 'hevc'], DEFAULTS.codec),
    quality: oneOf(s.quality, ['standard', 'high', 'max'], DEFAULTS.quality),
    audio: oneOf(s.audio, ['copy', 'aac', 'none'], DEFAULTS.audio),
    stabilize: num(s.stabilize, DEFAULTS.stabilize, 0, 1),
    motionToNr: typeof s.motionToNr === 'boolean' ? s.motionToNr : DEFAULTS.motionToNr,
    sceneCut: num(s.sceneCut, DEFAULTS.sceneCut, 0.02, 1),
    suffix: suffix === '' && (typeof s.outputDir !== 'string' || s.outputDir === '') ? DEFAULTS.suffix : suffix,
    outputDir: typeof s.outputDir === 'string' ? s.outputDir : DEFAULTS.outputDir,
    monitor: int(s.monitor, DEFAULTS.monitor, -1, 15),
    fpsCap: int(s.fpsCap, DEFAULTS.fpsCap, 0, 480),
    split: typeof s.split === 'boolean' ? s.split : DEFAULTS.split,
  };
}

function classify(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  return null;
}

function imageExtension(input, format) {
  if (format === 'jpg') return '.jpg';
  if (format === 'png') return '.png';
  const ext = path.extname(input).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.jfif') return '.jpg';
  if (ext === '.tif' || ext === '.tiff') return '.tif';
  return '.png';   // WebP / HEIC / AVIF / GIF / BMP: Windows has no encoder for most of these, PNG keeps it lossless
}

// Where a result goes: beside the original (or in the chosen folder), named
// "<name><suffix>.<ext>", never over an existing file and never over another
// result of the same job. The original is never a possible target.
function outputPathFor(input, kind, settings, taken = new Set(), exists = fs.existsSync) {
  const s = normalize(settings);
  const dir = s.outputDir || path.dirname(input);
  const stem = path.basename(input, path.extname(input));
  const ext = kind === 'video' ? '.mp4' : imageExtension(input, s.imageFormat);
  const suffix = s.suffix || (s.outputDir ? '' : DEFAULTS.suffix);
  const key = candidate => candidate.toLowerCase();
  for (let n = 1; n < 10000; n += 1) {
    const name = `${stem}${suffix}${n === 1 ? '' : ` (${n})`}${ext}`;
    const candidate = path.join(dir, name);
    if (key(candidate) === key(path.resolve(input))) continue;
    if (taken.has(key(candidate)) || exists(candidate)) continue;
    taken.add(key(candidate));
    return candidate;
  }
  throw new Error(`No free file name for ${stem} in ${dir}`);
}

function formatNumber(value) {
  return String(Math.round(value * 1000) / 1000);
}

// The worker's command line for one run. Paths are passed as separate
// arguments (spawn quotes them); nothing here is ever a shell string.
function buildArgs(mode, settings, { nr, bridge, list, log } = {}) {
  if (!['image', 'video', 'desktop', 'probe', 'monitors'].includes(mode)) throw new Error(`Unknown mode ${mode}`);
  const s = normalize(settings);
  const args = ['--mode', mode];
  if (mode !== 'monitors') {
    if (!nr || !bridge) throw new Error('The runtime and bridge paths are required.');
    args.push('--nr', nr, '--bridge', bridge);
  }
  if (log) args.push('--log', log);
  if (mode === 'monitors') return args;
  args.push(
    '--style', String(s.style),
    '--intensity', formatNumber(s.intensity),
    '--tone', formatNumber(s.tone),
    '--structure', formatNumber(s.structure),
    '--skin', formatNumber(s.skin),
    '--automask', s.autoMask ? '1' : '0',
    '--passes', String(s.passes),
    '--mix', formatNumber(s.mix),
    '--max-work-mp', formatNumber(s.maxWorkMP),
  );
  if (mode === 'image') args.push('--refine', String(s.refine), '--jpeg-quality', String(s.jpegQuality));
  if (mode === 'video') {
    args.push('--codec', s.codec, '--quality', s.quality, '--audio', s.audio,
      '--stabilize', formatNumber(s.stabilize), '--motion-to-nr', s.motionToNr ? '1' : '0',
      '--scene-cut', formatNumber(s.sceneCut));
  }
  if (mode === 'desktop') {
    args.push('--monitor', String(s.monitor), '--fps-cap', String(s.fpsCap),
      '--stabilize', formatNumber(s.stabilize), '--motion-to-nr', s.motionToNr ? '1' : '0',
      '--split', s.split ? '1' : '0');
  }
  if (mode === 'image' || mode === 'video') {
    if (!list) throw new Error('A job list is required.');
    args.push('--list', list);
  }
  return args;
}

// Live commands for a running desktop worker (one line each on its stdin): the
// look and strength without a restart, and the before/after split.
function lookCommand(settings) {
  const s = normalize(settings);
  return `look style=${s.style} passes=${s.passes} intensity=${formatNumber(s.intensity)} tone=${formatNumber(s.tone)}`
    + ` structure=${formatNumber(s.structure)} skin=${formatNumber(s.skin)} automask=${s.autoMask ? 1 : 0}`
    + ` mix=${formatNumber(s.mix)} stabilize=${formatNumber(s.stabilize)} work=${formatNumber(s.maxWorkMP)} fps=${s.fpsCap}`;
}

function splitCommand(on) { return `split ${on ? 1 : 0}`; }

// The job list the worker reads: UTF-8, one "input<TAB>output" per line.
// Windows paths cannot contain tabs or newlines, so no escaping is needed -
// and a path that somehow does is refused rather than split wrongly.
function writeList(file, items) {
  const lines = items.map(({ input, output }) => {
    for (const value of [input, output]) {
      if (typeof value !== 'string' || !value || /[\t\r\n]/.test(value)) throw new Error(`Unusable path: ${JSON.stringify(value)}`);
    }
    return `${input}\t${output}`;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

// One stdout line -> an event object, or null for anything that is not one.
function parseLine(line) {
  const text = String(line || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.event === 'string' ? value : null;
  } catch { return null; }
}

// Splits a growing stdout buffer into complete lines; returns the remainder.
function splitLines(buffer, onLine) {
  let rest = buffer;
  let index;
  while ((index = rest.indexOf('\n')) >= 0) {
    onLine(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  return rest;
}

// In the installed app the payload sits unpacked beside app.asar; starting a
// process or loading a DLL needs that real path, not the archive's virtual one.
function unpacked(file) { return String(file).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'); }
function workerPath(appRoot) { return unpacked(path.join(appRoot, 'payload', 'media', 'dlss5-media.exe')); }
function bridgePath(appRoot) { return unpacked(path.join(appRoot, 'payload', 'nvngx.dll')); }

// The runtime the worker gets: the same located, hash-checked file installs
// use, under the same rule (an unvalidated neural runtime only when the user
// turned that on in Settings).
function resolveRuntime(located, verification, { allowUnknownNeural = false } = {}) {
  if (!located || !located.nr) {
    return { ok: false, message: 'nvngx_dlssnr.dll was not found on this PC. See Runtimes - it comes from a game that shipped it and is never downloaded by this app.' };
  }
  if (!located.nr.plausible) return { ok: false, message: `The nvngx_dlssnr.dll at ${located.nr.from} is too small to be the real runtime.` };
  const detail = verification && verification.details && verification.details.nr;
  if (!detail) return { ok: false, message: 'The neural runtime could not be checked.' };
  if (!detail.known && !allowUnknownNeural) {
    return { ok: false, message: `The nvngx_dlssnr.dll at ${located.nr.from} is not a validated copy (SHA-256 ${String(detail.sha).slice(0, 16)}…). `
      + 'Pictures, videos and desktop mode use the same hash check as installs; "Allow an unvalidated neural runtime" in Settings overrides it.' };
  }
  return { ok: true, nr: located.nr.file, known: detail.known, version: detail.version || null, modified: Boolean(detail.modified) };
}

// Plain-language line for the activity log.
function describeEvent(event) {
  if (!event) return null;
  switch (event.event) {
    case 'ready': return event.passthrough ? 'media worker ready (no GPU pass)' : `neural rendering ready on ${event.gpu} (driver ${event.driver || '?'})`;
    case 'file-done': return `${path.basename(event.output || '')} written${event.nrMs ? ` - NR ${Number(event.nrMs).toFixed(1)} ms${event.frames ? '/frame' : ''}` : ''}`;
    case 'file-error': return `${path.basename(event.input || '')}: ${event.message}`;
    case 'warning': return event.message;
    case 'error': return event.message;
    case 'crash': return `the media worker crashed (${event.code} in ${event.module})`;
    case 'desktop-ready': return `desktop mode running on ${event.width}x${event.height}${event.hdr ? ' HDR' : ''}`;
    case 'desktop-stopped': return 'desktop mode stopped';
    case 'desktop-look': return `desktop look changed live (style ${event.style}, ${event.passes} pass${event.passes === 1 ? '' : 'es'}, strength ${Math.round((event.mix ?? 1) * 100)}%)`;
    case 'probe': return event.ok ? `probe passed - NR ${Number(event.nrMs || 0).toFixed(1)} ms on 256x256` : `probe failed${event.message ? `: ${event.message}` : ''}`;
    default: return null;
  }
}

function settingsFromState(state) {
  return normalize(state && state.media);
}

module.exports = {
  IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, DEFAULTS, WORK_SIZES,
  normalize, classify, outputPathFor, buildArgs, lookCommand, splitCommand, writeList, parseLine, splitLines,
  workerPath, bridgePath, unpacked, resolveRuntime, describeEvent, settingsFromState,
};
