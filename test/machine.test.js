// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// The fake neural runtime these tests scaffold has no known-good hash; the gate
// that refuses unknown copies is tested on its own in hardening.test.js.
process.env.DLSS5_AIO_ALLOW_UNKNOWN_RUNTIME = '1';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pe = require('../core/pe');
const machine = require('../core/machine');
const install = require('../core/install');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aio-machine-')); }

// A synthetic 64-bit DLL with an export table and a version resource - the
// same shape NVIDIA's runtimes have, so the reader is tested on the exact
// byte layout without shipping anyone's DLL. Two sections: .text holds the
// export directory, names and the constant-returning functions; .rsrc holds a
// VS_VERSION_INFO block.
function buildDll({ exports: table = {}, fileVersion = [310, 8, 0, 0] } = {}) {
  const align = 0x200;
  const textRva = 0x1000;
  const rsrcRva = 0x2000;
  // --- .text: functions first, then the export directory
  const names = Object.keys(table);
  const text = Buffer.alloc(0x400);
  let cursor = 0;
  const functionRvas = [];
  for (const name of names) {
    const value = table[name];
    if (typeof value === 'number') {
      text[cursor] = 0xb8; text.writeUInt32LE(value >>> 0, cursor + 1); text[cursor + 5] = 0xc3;
    } else {
      // real code: a jump, so readConstantExport must say null
      text[cursor] = 0x48; text[cursor + 1] = 0x8b; text[cursor + 2] = 0xc1; text[cursor + 3] = 0xc3;
    }
    functionRvas.push(textRva + cursor);
    cursor += 8;
  }
  const dirOffset = cursor; cursor += 40;
  const addressTable = cursor; cursor += names.length * 4;
  const nameTable = cursor; cursor += names.length * 4;
  const ordinalTable = cursor; cursor += names.length * 2;
  const nameRvas = [];
  for (const name of names) { nameRvas.push(textRva + cursor); text.write(name + '\0', cursor, 'latin1'); cursor += name.length + 1; }
  text.writeUInt32LE(names.length, dirOffset + 20);
  text.writeUInt32LE(names.length, dirOffset + 24);
  text.writeUInt32LE(textRva + addressTable, dirOffset + 28);
  text.writeUInt32LE(textRva + nameTable, dirOffset + 32);
  text.writeUInt32LE(textRva + ordinalTable, dirOffset + 36);
  names.forEach((name, index) => {
    text.writeUInt32LE(functionRvas[index], addressTable + index * 4);
    text.writeUInt32LE(nameRvas[index], nameTable + index * 4);
    text.writeUInt16LE(index, ordinalTable + index * 2);
  });
  // --- .rsrc: just the version block, found by its key and signature
  const rsrc = Buffer.alloc(0x200);
  Buffer.from('VS_VERSION_INFO', 'utf16le').copy(rsrc, 6);
  const fixed = 6 + 32 + 2;
  rsrc.writeUInt32LE(0xfeef04bd, fixed);
  rsrc.writeUInt32LE((fileVersion[0] << 16) | fileVersion[1], fixed + 8);
  rsrc.writeUInt32LE((fileVersion[2] << 16) | fileVersion[3], fixed + 12);
  // --- headers
  const headers = Buffer.alloc(align);
  headers.write('MZ', 0, 'latin1');
  headers.writeUInt32LE(0x80, 0x3c);
  const peOff = 0x80;
  headers.write('PE\0\0', peOff, 'latin1');
  headers.writeUInt16LE(0x8664, peOff + 4);            // machine
  headers.writeUInt16LE(2, peOff + 6);                 // sections
  headers.writeUInt16LE(240, peOff + 20);              // optional header size (PE32+)
  const opt = peOff + 24;
  headers.writeUInt16LE(0x20b, opt);                   // PE32+
  const dataDirectory = opt + 112;
  headers.writeUInt32LE(textRva + dirOffset, dataDirectory);    // export directory rva
  headers.writeUInt32LE(40, dataDirectory + 4);
  const sections = opt + 240;
  const section = (index, name, rva, size, raw) => {
    const at = sections + index * 40;
    headers.write(name, at, 'latin1');
    headers.writeUInt32LE(size, at + 8);
    headers.writeUInt32LE(rva, at + 12);
    headers.writeUInt32LE(size, at + 16);
    headers.writeUInt32LE(raw, at + 20);
  };
  section(0, '.text', textRva, text.length, align);
  section(1, '.rsrc', rsrcRva, rsrc.length, align + text.length);
  return Buffer.concat([headers, text, rsrc]);
}

test('a constant-returning export is read off the disk, real code is not', () => {
  const dir = tmp();
  const file = path.join(dir, 'fake_nvngx_dlssnr.dll');
  fs.writeFileSync(file, buildDll({
    exports: { NVSDK_NGX_GetGPUArchitecture: 0x1b0, NVSDK_NGX_GetSnippetVersion: 0x01360800, NVSDK_NGX_D3D12_Init_Ext: 'code' },
    fileVersion: [310, 8, 0, 0],
  }));
  const table = pe.getExports(file);
  assert.deepStrictEqual(Object.keys(table).sort(), ['NVSDK_NGX_D3D12_Init_Ext', 'NVSDK_NGX_GetGPUArchitecture', 'NVSDK_NGX_GetSnippetVersion']);
  assert.strictEqual(pe.readConstantExport(file, 'NVSDK_NGX_GetGPUArchitecture'), 0x1b0);
  assert.strictEqual(pe.readConstantExport(file, 'NVSDK_NGX_GetSnippetVersion'), 0x01360800);
  assert.strictEqual(pe.readConstantExport(file, 'NVSDK_NGX_D3D12_Init_Ext'), null, 'real code is not a constant');
  assert.strictEqual(pe.readConstantExport(file, 'NotThere'), null);
  assert.strictEqual(pe.getFileVersion(file), '310.8.0.0');

  const described = machine.describeRuntime(file);
  assert.strictEqual(described.minArchitecture, 0x1b0);
  assert.strictEqual(described.minArchitectureName, 'Blackwell (RTX 50)');
  assert.strictEqual(described.snippetVersion, '310.8.0');
  assert.strictEqual(described.fileVersion, '310.8.0.0');
});

test('a file that is not a PE, or has no exports, gives nothing rather than throwing', () => {
  const dir = tmp();
  const junk = path.join(dir, 'junk.dll');
  fs.writeFileSync(junk, Buffer.alloc(5000, 7));
  assert.deepStrictEqual(pe.getExports(junk), {});
  assert.strictEqual(pe.readConstantExport(junk, 'x'), null);
  assert.strictEqual(pe.getFileVersion(junk), null);
  const bare = path.join(dir, 'bare.dll');
  fs.writeFileSync(bare, buildDll({ exports: {} }));
  assert.deepStrictEqual(pe.getExports(bare), {});
  assert.strictEqual(machine.describeRuntime(bare).minArchitecture, null);
});

test('card names map to generations, and unknown stays unknown', () => {
  const cases = {
    'NVIDIA GeForce RTX 5070 Ti': 0x1b0, 'NVIDIA GeForce RTX 4090': 0x190, 'NVIDIA GeForce RTX 3080 Ti': 0x170,
    'NVIDIA GeForce RTX 2080 Ti': 0x160, 'NVIDIA GeForce GTX 1660 SUPER': 0x160, 'NVIDIA GeForce GTX 1080': 0x130,
    'NVIDIA RTX A4000': 0x170, 'NVIDIA RTX 6000 Ada Generation': 0x190, 'NVIDIA RTX PRO 6000 Blackwell': 0x1b0,
    'Quadro RTX 4000': 0x160, 'NVIDIA TITAN RTX': 0x160, 'AMD Radeon RX 7900 XTX': null, 'Intel Arc A770': null, '': null,
  };
  for (const [name, code] of Object.entries(cases)) {
    assert.strictEqual(machine.architectureFromName(name), code, name);
  }
  assert.strictEqual(machine.architectureName(0x160), 'Turing (RTX 20 / GTX 16)');
  assert.strictEqual(machine.architectureName(0x1c0), 'newer than Blackwell (0x1c0)');
  assert.strictEqual(machine.wmiDriverToPublic('32.0.16.1692'), '616.92');
  assert.strictEqual(machine.wmiDriverToPublic('31.0.15.5222'), '552.22');
});

test('the GPU probe reads nvidia-smi, falls back to WMI, and admits defeat', () => {
  const smi = (file, args) => (file === 'nvidia-smi' ? 'NVIDIA GeForce RTX 2080 Ti, 616.92\n' : null);
  let gpu = machine.probeGpu({ exec: smi, platform: 'win32' });
  assert.deepStrictEqual({ name: gpu.name, driver: gpu.driver, arch: gpu.architecture, source: gpu.source },
    { name: 'NVIDIA GeForce RTX 2080 Ti', driver: '616.92', arch: 0x160, source: 'nvidia-smi' });

  const wmi = (file) => (file === 'powershell' ? '{"Name":"NVIDIA GeForce RTX 3070","DriverVersion":"32.0.16.1692"}' : null);
  gpu = machine.probeGpu({ exec: wmi, platform: 'win32' });
  assert.strictEqual(gpu.architecture, 0x170);
  assert.strictEqual(gpu.driver, '616.92');
  assert.strictEqual(gpu.source, 'wmi');

  assert.strictEqual(machine.probeGpu({ exec: () => null, platform: 'win32' }).available, false);
  assert.strictEqual(machine.probeGpu({ exec: smi, platform: 'linux' }).available, false);

  const reg = (file) => (file === 'reg' ? '\r\nHKEY_LOCAL_MACHINE\\...\\GraphicsDrivers\r\n    HwSchMode    REG_DWORD    0x2\r\n' : null);
  assert.strictEqual(machine.probeHags({ exec: reg, platform: 'win32' }).state, 'on');
  assert.strictEqual(machine.probeHags({ exec: () => 'HwSchMode REG_DWORD 0x1', platform: 'win32' }).state, 'off');
  assert.strictEqual(machine.probeHags({ exec: () => null, platform: 'win32' }).state, 'unknown');
});

test('the verdict: an RTX 20 cannot run the neural renderer, an RTX 50 can, an unknown card is not judged', () => {
  const runtimes = {
    nr: { file: 'C:\\x\\nvngx_dlssnr.dll', fileVersion: '310.8.0.0', minArchitecture: 0x1b0, minArchitectureName: machine.architectureName(0x1b0) },
    sr: { file: 'C:\\x\\nvngx_dlss.dll', fileVersion: '310.8.0.0', minArchitecture: 0x160, minArchitectureName: machine.architectureName(0x160) },
    fg: { file: 'C:\\x\\nvngx_dlssg.dll', fileVersion: '310.8.0.0', minArchitecture: 0x190, minArchitectureName: machine.architectureName(0x190) },
  };
  const turing = { available: true, name: 'NVIDIA GeForce RTX 2080 Ti', architecture: 0x160, architectureName: machine.architectureName(0x160) };
  let verdict = machine.assess({ gpu: turing, hags: { available: true, state: 'on' }, runtimes });
  assert.strictEqual(verdict.problems.length, 1);
  assert.match(verdict.problems[0], /RTX 2080 Ti is Turing.*nvngx_dlssnr\.dll 310\.8\.0\.0 needs Blackwell \(RTX 50\).*nothing to install/);
  assert.match(verdict.problems[0], /cross-generation build.*OpenNR \(github\.com\/clshortfuse\/openNR\).*e67dee20/, 'an RTX 20/30/40 is told the way forward');
  assert.strictEqual(verdict.notes.length, 1, 'frame generation is a note, not a blocker');
  assert.match(verdict.notes[0], /frame generation cannot run here/);
  assert.deepStrictEqual([verdict.verdicts.nr.ok, verdict.verdicts.sr.ok, verdict.verdicts.fg.ok], [false, true, false]);

  const blackwell = { available: true, name: 'NVIDIA GeForce RTX 5070 Ti', architecture: 0x1b0, architectureName: machine.architectureName(0x1b0) };
  verdict = machine.assess({ gpu: blackwell, hags: { available: true, state: 'off' }, runtimes });
  assert.deepStrictEqual(verdict.problems, []);
  assert.deepStrictEqual([verdict.verdicts.nr.ok, verdict.verdicts.sr.ok, verdict.verdicts.fg.ok], [true, true, true]);
  assert.strictEqual(verdict.notes.length, 1);
  assert.match(verdict.notes[0], /GPU scheduling is off/);

  const unknown = { available: true, name: 'NVIDIA Mystery 9000', architecture: null, architectureName: null };
  verdict = machine.assess({ gpu: unknown, hags: { available: false }, runtimes });
  assert.deepStrictEqual(verdict.problems, []);
  assert.deepStrictEqual(verdict.notes, []);
  assert.strictEqual(verdict.verdicts.nr.ok, null);

  verdict = machine.assess({ gpu: { available: false }, hags: { available: false }, runtimes: {} });
  assert.deepStrictEqual(verdict, { problems: [], notes: [], verdicts: {} });
});

// ---------------------------------------------------------------- through the planner

function fakeApp() {
  const app = tmp();
  process.env.LOCALAPPDATA = path.join(app, 'localappdata');
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  fs.mkdirSync(path.join(app, 'payload'));
  fs.mkdirSync(path.join(app, 'runtimes'));
  fs.writeFileSync(path.join(app, 'payload', 'ReShade64.dll'), 'reshade');
  fs.writeFileSync(path.join(app, 'payload', 'standalone-dlssnr.addon64'), 'addon');
  fs.writeFileSync(path.join(app, 'payload', 'nvngx.dll'), 'our bridge, the real one is 89 KB');
  fs.writeFileSync(path.join(app, 'runtimes', 'nvngx_dlssnr.dll'), Buffer.alloc(41 * 1024 * 1024));
  return app;
}

function fakeGame() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'game.exe'), 'x');
  return dir;
}

const exe = { name: 'game.exe', bitness: 64, api: 'd3d12', apiSource: 'import', renders: true };

test('the planner refuses a card the neural renderer cannot run on, and says why', () => {
  const app = fakeApp();
  const dir = fakeGame();
  const turing = () => ({
    gpu: { available: true, name: 'NVIDIA GeForce RTX 2080 Ti', architecture: 0x160, architectureName: 'Turing (RTX 20 / GTX 16)' },
    hags: { available: true, state: 'on' }, runtimes: {},
    problems: ['This PC\'s NVIDIA GeForce RTX 2080 Ti is Turing (RTX 20 / GTX 16). nvngx_dlssnr.dll 310.8.0.0 needs Blackwell (RTX 50) or newer - its kernels do not exist for this card, so neural rendering cannot run here. There is nothing to install.'],
    notes: [], verdicts: { nr: { ok: false } },
  });
  const planned = install.plan({ dir, exe }, { appRoot: app, probe: turing });
  assert.strictEqual(planned.installable, false);
  assert.match(planned.problems.join('\n'), /RTX 2080 Ti.*Blackwell/);
  assert.strictEqual(planned.machine.gpu.name, 'NVIDIA GeForce RTX 2080 Ti');
  assert.throws(() => install.apply(planned), /Cannot install/);

  const fine = () => ({ gpu: { available: false }, hags: { available: false }, runtimes: {}, problems: [], notes: [], verdicts: {} });
  const okPlan = install.plan({ dir, exe }, { appRoot: app, probe: fine });
  assert.strictEqual(okPlan.installable, true);
});

test('a foreign nvngx.dll beside the game is parked with a backup and comes back on restore', () => {
  const app = fakeApp();
  const dir = fakeGame();
  const foreign = path.join(dir, 'nvngx.dll');
  fs.writeFileSync(foreign, Buffer.alloc(10240, 0x11));       // the 10 KB bridge from upstream issue #6
  const quiet = () => ({ gpu: { available: false }, hags: { available: false }, runtimes: {}, problems: [], notes: [], verdicts: {} });

  const planned = install.plan({ dir, exe }, { appRoot: app, probe: quiet });
  const park = planned.files.find(file => file.action === 'park');
  assert.ok(park, 'the plan shows the park step');
  assert.strictEqual(park.to, `${foreign}.dlss5-parked`);
  assert.match(planned.notes.join('\n'), /already has an nvngx\.dll \(10 KB\)/);
  assert.strictEqual(planned.installable, true);

  install.apply(planned, { logFile: path.join(dir, 'no.log') });
  assert.ok(!fs.existsSync(foreign), 'the foreign bridge is out of the way');
  assert.ok(fs.existsSync(`${foreign}.dlss5-parked`));
  const manifest = install.readManifest(dir);
  assert.ok(manifest.files.some(file => file.parked === foreign));

  const outcome = install.restore(dir);
  assert.deepStrictEqual(outcome.failures, []);
  assert.ok(fs.existsSync(foreign), 'restore put it back');
  assert.ok(!fs.existsSync(`${foreign}.dlss5-parked`));
  assert.strictEqual(fs.readFileSync(foreign)[0], 0x11);

  // Our own bridge beside the game is left alone.
  fs.copyFileSync(path.join(app, 'payload', 'nvngx.dll'), foreign);
  const again = install.plan({ dir, exe }, { appRoot: app, probe: quiet });
  assert.ok(!again.files.some(file => file.action === 'park'));
});
