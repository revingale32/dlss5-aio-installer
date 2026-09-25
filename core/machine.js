// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const pe = require('./pe');

// Can this PC run these runtimes at all?
//
// Each NGX runtime carries kernels for some GPU generations and not others,
// and says which through its NVSDK_NGX_GetGPUArchitecture export: the lowest
// generation it will accept. The DLSS 5 neural renderer in circulation
// (310.8) answers Blackwell - its kernels are compiled for sm_120 only - so
// on an RTX 40, 30 or 20 it cannot run, and an install there is a dead add-on
// and a confused user. Reading the number off the file and comparing it with
// the card in the machine turns that into one plain sentence, before anything
// is written.
//
// The architecture codes are NVIDIA's own (NV_GPU_ARCHITECTURE_*): the
// runtime exports them, NvAPI reports them, and the driver compares them.

const ARCHITECTURES = [
  { code: 0x110, name: 'Maxwell', cards: 'GTX 900' },
  { code: 0x120, name: 'Maxwell', cards: 'GTX 900' },
  { code: 0x130, name: 'Pascal', cards: 'GTX 10' },
  { code: 0x140, name: 'Volta', cards: 'Titan V' },
  { code: 0x160, name: 'Turing', cards: 'RTX 20 / GTX 16' },
  { code: 0x170, name: 'Ampere', cards: 'RTX 30' },
  { code: 0x180, name: 'Hopper', cards: 'H100' },
  { code: 0x190, name: 'Ada', cards: 'RTX 40' },
  { code: 0x1a0, name: 'Blackwell', cards: 'B100' },
  { code: 0x1b0, name: 'Blackwell', cards: 'RTX 50' },
];

function architectureName(code) {
  if (code === null || code === undefined) return null;
  const hit = ARCHITECTURES.find(entry => entry.code === code);
  if (hit) return `${hit.name} (${hit.cards})`;
  const below = [...ARCHITECTURES].reverse().find(entry => entry.code < code);
  return below ? `newer than ${below.name} (0x${code.toString(16)})` : `0x${code.toString(16)}`;
}

// The generation, from the marketing name. Only the families that matter for
// an RTX feature are mapped; anything else is honestly unknown rather than
// guessed, and unknown never blocks an install.
const NAME_RULES = [
  // Workstation names first: "Quadro RTX 4000" is Turing, not an RTX 40.
  [/\bQuadro\s*RTX\b/i, 0x160],
  [/\bRTX\s*PRO\b.*\bBlackwell\b/i, 0x1b0],
  [/\bRTX\s*\d{4}\s*Ada\b/i, 0x190],
  [/\bRTX\s*A\d{3,4}\b/i, 0x170],
  [/\bRTX\s*50\d\d\b/i, 0x1b0],
  [/\bRTX\s*40\d\d\b/i, 0x190],
  [/\bRTX\s*30\d\d\b/i, 0x170],
  [/\bRTX\s*20\d\d\b/i, 0x160],
  [/\bGTX\s*16\d\d\b/i, 0x160],
  [/\bTITAN\s*RTX\b/i, 0x160],
  [/\bGTX\s*10\d\d\b/i, 0x130],
  [/\bGTX\s*9\d\d\b/i, 0x120],
];

function architectureFromName(name) {
  const text = String(name || '');
  for (const [pattern, code] of NAME_RULES) if (pattern.test(text)) return code;
  return null;
}

// ---------------------------------------------------------------- probes

function run(file, args, timeout = 6000) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

// nvidia-smi ships with every NVIDIA driver, in System32, and answers in one
// line. The WMI fallback covers a machine where it was stripped.
function probeGpu({ exec = run, platform = process.platform } = {}) {
  if (platform !== 'win32') return { available: false, reason: 'not Windows' };
  const smi = exec('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'])
    || exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'), ['--query-gpu=name,driver_version', '--format=csv,noheader']);
  if (smi) {
    const line = smi.split(/\r?\n/).map(l => l.trim()).find(Boolean);
    if (line) {
      const [name, driver] = line.split(',').map(part => part.trim());
      return fromName(name, driver, 'nvidia-smi');
    }
  }
  const wmi = exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1 Name,DriverVersion | ConvertTo-Json -Compress']);
  if (wmi) {
    try {
      const row = JSON.parse(wmi);
      if (row && row.Name) return fromName(row.Name, wmiDriverToPublic(row.DriverVersion), 'wmi');
    } catch { /* fall through */ }
  }
  return { available: false, reason: 'no NVIDIA GPU reported' };
}

function fromName(name, driver, source) {
  const architecture = architectureFromName(name);
  return { available: true, name, driver: driver || null, architecture, architectureName: architectureName(architecture), source };
}

// WMI reports 32.0.16.1692 for what NVIDIA calls 616.92: the public number is
// the last five digits with a dot before the final two.
function wmiDriverToPublic(value) {
  const digits = String(value || '').replace(/\./g, '');
  if (digits.length < 5) return value || null;
  const tail = digits.slice(-5);
  return `${tail.slice(0, 3)}.${tail.slice(3)}`;
}

// Hardware-accelerated GPU scheduling. DLSS frame generation refuses to start
// without it, silently, so the state is worth one registry read.
function probeHags({ exec = run, platform = process.platform } = {}) {
  if (platform !== 'win32') return { available: false };
  const out = exec('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', '/v', 'HwSchMode']);
  if (!out) return { available: true, state: 'unknown' };
  const match = out.match(/HwSchMode\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  if (!match) return { available: true, state: 'unknown' };
  const value = parseInt(match[1], 16);
  return { available: true, state: value === 2 ? 'on' : value === 1 ? 'off' : 'unknown', value };
}

// ---------------------------------------------------------------- runtimes

// What one runtime file says about itself.
function describeRuntime(file) {
  const architecture = pe.readConstantExport(file, 'NVSDK_NGX_GetGPUArchitecture');
  const snippet = pe.readConstantExport(file, 'NVSDK_NGX_GetSnippetVersion');
  return {
    file,
    fileVersion: pe.getFileVersion(file),
    snippetVersion: snippet === null ? null : `${snippet >>> 16}.${(snippet >>> 8) & 0xff}.${snippet & 0xff}`,
    minArchitecture: architecture,
    minArchitectureName: architectureName(architecture),
  };
}

const ROLE = { nr: 'neural rendering', sr: 'DLSS super resolution', fg: 'frame generation' };

// The verdict for this machine, in sentences. `problems` stop an install;
// `notes` do not. Nothing here guesses: an unknown card or a runtime with no
// architecture export produces no verdict at all.
function assess({ gpu, hags, runtimes = {} }) {
  const problems = [];
  const notes = [];
  const verdicts = {};
  for (const kind of ['nr', 'sr', 'fg']) {
    const runtime = runtimes[kind];
    if (!runtime || runtime.minArchitecture === null || runtime.minArchitecture === undefined) continue;
    const verdict = { kind, minArchitecture: runtime.minArchitecture, minArchitectureName: runtime.minArchitectureName, ok: null };
    if (gpu && gpu.available && gpu.architecture !== null && gpu.architecture !== undefined) {
      verdict.ok = gpu.architecture >= runtime.minArchitecture;
      if (!verdict.ok) {
        const sentence = `This PC's ${gpu.name} is ${gpu.architectureName}. ${path.basename(runtime.file)}`
          + `${runtime.fileVersion ? ` ${runtime.fileVersion}` : ''} needs ${runtime.minArchitectureName} or newer - its kernels do not exist `
          + `for this card, so ${ROLE[kind]} cannot run here.`;
        // RTX 20/30/40 have a way forward: ShortFuse's cross-generation build of the same
        // runtime (FP16 path for Turing/Ampere, Blackwell functions backported for Ada). Since
        // 2026-09-21 it can be rebuilt from the stock file with his open-source OpenNR instead
        // of downloading a patched binary; the runtime gate knows it by hash (runtimes.js).
        const crossGeneration = kind === 'nr' && gpu.architecture >= 0x160 && gpu.architecture < 0x1a0;
        if (crossGeneration) {
          problems.push(`${sentence} There is nothing to install with this file. The cross-generation build of the same runtime `
            + 'does run on RTX 20/30/40 (an RTX 3080 is the community\'s floor for playable speed): rebuild it from this exact file '
            + 'with ShortFuse\'s open-source OpenNR (github.com/clshortfuse/openNR), or take it from the pin in the RenoDX Discord, '
            + 'then add it on the Runtimes page - it is recognised by its SHA-256, e67dee20.');
        } else if (kind === 'nr') problems.push(`${sentence} There is nothing to install.`);
        else notes.push(`${sentence} It will stay off.`);
      }
    }
    verdicts[kind] = verdict;
  }
  if (hags && hags.available && hags.state === 'off' && runtimes.fg) {
    notes.push('Hardware-accelerated GPU scheduling is off. DLSS frame generation needs it on '
      + '(Windows Settings > System > Display > Graphics > Default graphics settings), then restart.');
  }
  return { problems, notes, verdicts };
}

// Everything the UI shows about this PC, probed once and cached by the caller.
function inspect({ runtimeFiles = {}, exec, platform } = {}) {
  const gpu = probeGpu({ exec, platform });
  const hags = probeHags({ exec, platform });
  const runtimes = {};
  for (const [kind, file] of Object.entries(runtimeFiles)) {
    if (file) { try { runtimes[kind] = describeRuntime(file); } catch { /* unreadable: no verdict */ } }
  }
  return { gpu, hags, runtimes, ...assess({ gpu, hags, runtimes }) };
}

module.exports = {
  ARCHITECTURES, architectureName, architectureFromName, wmiDriverToPublic,
  probeGpu, probeHags, describeRuntime, assess, inspect,
};
