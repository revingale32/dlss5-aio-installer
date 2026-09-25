// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');

// Minimal PE reader: bitness and imported DLL names.
//
// We need two facts about a candidate executable and nothing more: is it 32- or
// 64-bit, and which graphics runtime does it import. Both come out of the
// headers, so we read a bounded window rather than the whole file - game
// executables run to 100 MB and there may be dozens of candidates in a folder.

const MACHINE_I386 = 0x014c;
const MACHINE_AMD64 = 0x8664;
const MACHINE_ARM64 = 0xaa64;

function readWindow(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function headerOffset(buffer) {
  if (!buffer || buffer.length < 0x40) return -1;
  if (buffer.readUInt16LE(0) !== 0x5a4d) return -1;             // MZ
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 24 > buffer.length) return -1;
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return -1;  // PE\0\0
  return peOffset;
}

function getBitness(file) {
  const buffer = readWindow(file, 4096);
  const pe = headerOffset(buffer);
  if (pe < 0) return 0;
  const machine = buffer.readUInt16LE(pe + 4);
  if (machine === MACHINE_I386) return 32;
  if (machine === MACHINE_AMD64 || machine === MACHINE_ARM64) return 64;
  return 0;
}

// Section table -> file offset for a relative virtual address.
function rvaToOffset(buffer, pe, rva) {
  const sectionCount = buffer.readUInt16LE(pe + 6);
  const optionalSize = buffer.readUInt16LE(pe + 20);
  const sectionStart = pe + 24 + optionalSize;
  for (let s = 0; s < sectionCount; s++) {
    const entry = sectionStart + s * 40;
    if (entry + 40 > buffer.length) break;
    const virtualSize = buffer.readUInt32LE(entry + 8);
    const virtualAddress = buffer.readUInt32LE(entry + 12);
    const rawSize = buffer.readUInt32LE(entry + 16);
    const rawPointer = buffer.readUInt32LE(entry + 20);
    const span = Math.max(virtualSize, rawSize);
    if (rva >= virtualAddress && rva < virtualAddress + span) {
      const offset = rva - virtualAddress + rawPointer;
      return offset < buffer.length ? offset : -1;
    }
  }
  return -1;
}

function readCString(buffer, offset, max = 128) {
  if (offset < 0 || offset >= buffer.length) return '';
  let end = offset;
  const limit = Math.min(buffer.length, offset + max);
  while (end < limit && buffer[end] !== 0) end++;
  return buffer.toString('latin1', offset, end);
}

// Imports live near the front of the file in practice, but "near" is not a
// guarantee, so the window grows once if the directory points past it.
function getImports(file, window = 2 * 1024 * 1024) {
  let buffer = readWindow(file, window);
  let pe = headerOffset(buffer);
  if (pe < 0) return [];
  const magic = buffer.readUInt16LE(pe + 24);
  const plus = magic === 0x20b;
  const dataDirectory = pe + 24 + (plus ? 112 : 96);
  if (dataDirectory + 8 > buffer.length) return [];
  const importRva = buffer.readUInt32LE(dataDirectory + 8);       // entry 1
  if (!importRva) return [];

  let offset = rvaToOffset(buffer, pe, importRva);
  if (offset < 0 && window < 64 * 1024 * 1024) {
    buffer = readWindow(file, 64 * 1024 * 1024);
    pe = headerOffset(buffer);
    if (pe < 0) return [];
    offset = rvaToOffset(buffer, pe, importRva);
  }
  if (offset < 0) return [];

  const names = [];
  for (let entry = 0; entry < 512; entry++) {
    const base = offset + entry * 20;
    if (base + 20 > buffer.length) break;
    const nameRva = buffer.readUInt32LE(base + 12);
    const originalFirstThunk = buffer.readUInt32LE(base);
    const firstThunk = buffer.readUInt32LE(base + 16);
    if (!nameRva && !originalFirstThunk && !firstThunk) break;    // null terminator
    if (!nameRva) continue;
    const nameOffset = rvaToOffset(buffer, pe, nameRva);
    const name = readCString(buffer, nameOffset);
    if (name) names.push(name.toLowerCase());
  }
  return names;
}

// Which graphics runtime does this executable actually talk to?
//
// Order matters: a DX12 game still imports dxgi, and plenty of DX11 games load
// d3d11 lazily through dxgi, so the most specific evidence wins. "unknown" is
// an honest answer - a launcher, or a game that loads its renderer with
// LoadLibrary, has no import to read.
const GRAPHICS = [
  { api: 'd3d12', dlls: ['d3d12.dll'] },
  { api: 'd3d11', dlls: ['d3d11.dll'] },
  { api: 'vulkan', dlls: ['vulkan-1.dll'] },
  { api: 'd3d9', dlls: ['d3d9.dll'] },
  { api: 'd3d8', dlls: ['d3d8.dll'] },
  { api: 'ddraw', dlls: ['ddraw.dll'] },
  { api: 'opengl', dlls: ['opengl32.dll'] },
  { api: 'dxgi', dlls: ['dxgi.dll'] },
];

function detectApi(imports) {
  const set = new Set(imports);
  for (const candidate of GRAPHICS) {
    if (candidate.dlls.some(d => set.has(d))) return candidate.api;
  }
  return 'unknown';
}

// Most modern engines never import a graphics runtime at all: Unreal loads
// D3D12RHI.dll at startup, Unity does the same, so the import table of the
// real game executable is empty while its own crash reporter - a Slate app -
// imports d3d11 outright. Reading only the imports therefore picks the crash
// reporter and calls the game a launcher, which is exactly what happened with
// Aliens: Fireteam Elite. The DLL names are still in the binary as strings,
// because that is what gets handed to LoadLibrary.
const DYNAMIC_NAMES = ['d3d12.dll', 'vulkan-1.dll', 'd3d11.dll', 'd3d9.dll', 'dxgi.dll'];
const DYNAMIC_API = {
  'd3d12.dll': 'd3d12', 'vulkan-1.dll': 'vulkan', 'd3d11.dll': 'd3d11',
  'd3d9.dll': 'd3d9', 'dxgi.dll': 'dxgi',
};

function findDynamicNames(file, { maxBytes = 192 * 1024 * 1024, chunkSize = 4 * 1024 * 1024 } = {}) {
  const needles = DYNAMIC_NAMES.map(name => ({ name, buffer: Buffer.from(name, 'latin1') }));
  const found = new Set();
  const overlap = 32;                       // a name must not be missed across a chunk edge
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(chunkSize + overlap);
    let position = 0;
    while (position < size && found.size < needles.length) {
      const want = Math.min(chunkSize + overlap, size - position);
      const read = fs.readSync(fd, buffer, 0, want, position);
      if (read <= 0) break;
      const window = buffer.subarray(0, read);
      for (const needle of needles) {
        if (!found.has(needle.name) && window.includes(needle.buffer)) found.add(needle.name);
      }
      position += Math.max(1, read - overlap);
    }
  } catch { /* unreadable: fall back to imports alone */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return [...found];
}

function inspect(file, { deep = true } = {}) {
  const bitness = getBitness(file);
  if (!bitness) return { file, bitness: 0, api: 'unknown', apiSource: 'none', imports: [], dynamic: [] };
  const imports = getImports(file);
  const fromImports = detectApi(imports);
  if (fromImports !== 'unknown') {
    return { file, bitness, api: fromImports, apiSource: 'import', imports, dynamic: [] };
  }
  if (!deep) return { file, bitness, api: 'unknown', apiSource: 'none', imports, dynamic: [] };

  const dynamic = findDynamicNames(file);
  // Most specific first, same as the import path. An engine that carries names
  // for several runtimes gets the highest one; the ReShade hook is dxgi.dll for
  // 10/11/12 regardless, so the ambiguity costs nothing.
  const name = DYNAMIC_NAMES.find(entry => dynamic.includes(entry));
  return {
    file, bitness, imports, dynamic,
    api: name ? DYNAMIC_API[name] : 'unknown',
    apiSource: name ? 'dynamic' : 'none',
  };
}

// ---------------------------------------------------------------- exports
//
// NVIDIA's NGX runtimes answer two questions through tiny exported functions
// that return a constant: NVSDK_NGX_GetGPUArchitecture (the lowest GPU
// generation the runtime's kernels exist for) and NVSDK_NGX_GetSnippetVersion.
// Both compile to `mov eax, imm32; ret` (B8 xx xx xx xx C3), so the value can
// be read straight off the disk without running anything. The export table
// sits near the front of even a 165 MB runtime, so the window starts small and
// grows only if the directory points past it.

function withHeaders(file, work, windows = [8 * 1024 * 1024, 64 * 1024 * 1024, Infinity]) {
  for (const window of windows) {
    const buffer = window === Infinity ? (() => { try { return fs.readFileSync(file); } catch { return null; } })() : readWindow(file, window);
    const pe = headerOffset(buffer);
    if (pe < 0) return null;
    const result = work(buffer, pe);
    if (result !== undefined) return result;        // undefined means "window too small"
  }
  return null;
}

function getExports(file) {
  return withHeaders(file, (buffer, pe) => {
    const magic = buffer.readUInt16LE(pe + 24);
    const dataDirectory = pe + 24 + (magic === 0x20b ? 112 : 96);
    if (dataDirectory + 8 > buffer.length) return undefined;
    const exportRva = buffer.readUInt32LE(dataDirectory);            // entry 0
    if (!exportRva) return {};
    const table = rvaToOffset(buffer, pe, exportRva);
    if (table < 0 || table + 40 > buffer.length) return undefined;
    const nameCount = buffer.readUInt32LE(table + 24);
    const functions = rvaToOffset(buffer, pe, buffer.readUInt32LE(table + 28));
    const names = rvaToOffset(buffer, pe, buffer.readUInt32LE(table + 32));
    const ordinals = rvaToOffset(buffer, pe, buffer.readUInt32LE(table + 36));
    if (functions < 0 || names < 0 || ordinals < 0) return undefined;
    const out = {};
    for (let index = 0; index < Math.min(nameCount, 4096); index++) {
      if (names + index * 4 + 4 > buffer.length || ordinals + index * 2 + 2 > buffer.length) return undefined;
      const nameOffset = rvaToOffset(buffer, pe, buffer.readUInt32LE(names + index * 4));
      const ordinal = buffer.readUInt16LE(ordinals + index * 2);
      if (nameOffset < 0 || functions + ordinal * 4 + 4 > buffer.length) return undefined;
      const rva = buffer.readUInt32LE(functions + ordinal * 4);
      const offset = rvaToOffset(buffer, pe, rva);
      out[readCString(buffer, nameOffset, 256)] = { rva, offset };
    }
    return out;
  }) || {};
}

// The constant a `mov eax, imm32; ret` export returns, or null when the export
// is missing or is real code.
function readConstantExport(file, name) {
  const exportsTable = getExports(file);
  const entry = exportsTable[name];
  if (!entry || entry.offset < 0) return null;
  const bytes = readWindow(file, entry.offset + 8);
  if (!bytes || bytes.length < entry.offset + 6) return null;
  if (bytes[entry.offset] !== 0xb8 || bytes[entry.offset + 5] !== 0xc3) return null;
  return bytes.readUInt32LE(entry.offset + 1);
}

// The file version from the VS_VERSION_INFO resource, as "a.b.c.d". Found by
// its fixed-info signature inside the resource section, which is how every
// version reader ends up doing it.
function getFileVersion(file) {
  return withHeaders(file, (buffer, pe) => {
    const sectionCount = buffer.readUInt16LE(pe + 6);
    const sectionStart = pe + 24 + buffer.readUInt16LE(pe + 20);
    for (let s = 0; s < sectionCount; s++) {
      const entry = sectionStart + s * 40;
      if (entry + 40 > buffer.length) return undefined;
      if (buffer.toString('latin1', entry, entry + 8).replace(/\0+$/, '') !== '.rsrc') continue;
      const rawSize = buffer.readUInt32LE(entry + 16);
      const rawPointer = buffer.readUInt32LE(entry + 20);
      if (rawPointer + rawSize > buffer.length) return undefined;
      const section = buffer.subarray(rawPointer, rawPointer + rawSize);
      const key = Buffer.from('VS_VERSION_INFO', 'utf16le');
      let at = section.indexOf(key);
      while (at >= 0) {
        const signature = section.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]), at);
        if (signature >= 0 && signature + 16 <= section.length) {
          const ms = section.readUInt32LE(signature + 8);
          const ls = section.readUInt32LE(signature + 12);
          return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
        }
        at = section.indexOf(key, at + key.length);
      }
      return null;
    }
    return null;
  });
}

module.exports = {
  getBitness, getImports, detectApi, inspect, findDynamicNames, DYNAMIC_NAMES,
  getExports, readConstantExport, getFileVersion,
};
