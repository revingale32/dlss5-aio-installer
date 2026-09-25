// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');

// ReShade.ini editing.
//
// Two rules learned the hard way and encoded here:
//
// 1. Line endings are CRLF and must stay CRLF. A regex anchored with `$` will
//    match before the `\r` and leave a stray carriage return mid-line, which
//    ReShade then writes back mangled. Every pattern here uses [^\r\n]*.
// 2. Never write a game's ReShade.ini while that game is running - ReShade
//    rewrites the whole file from memory when it exits and will silently
//    discard anything changed underneath it. Callers must check first; see
//    `isGameLikelyRunning` in install.js.

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function parseSections(text) {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const sections = new Map();
  let current = null;
  lines.forEach((line, index) => {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = { name: header[1], start: index, end: index, keys: new Map() };
      sections.set(header[1], current);
      return;
    }
    if (!current) return;
    current.end = index;
    const pair = line.match(/^([^=\r\n]+)=([^\r\n]*)$/);
    if (pair) current.keys.set(pair[1].trim(), pair[2]);
  });
  return { eol, lines, sections };
}

function readSection(file, section) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const parsed = parseSections(text);
  const found = parsed.sections.get(section);
  if (!found) return null;
  return Object.fromEntries(found.keys);
}

// Merge `values` into `[section]`, creating the section if absent, and leave
// every other byte of the file alone. Returns the new text; the caller decides
// when (and whether) to write it.
function upsertSection(text, section, values) {
  const { eol, lines, sections } = parseSections(text);
  const existing = sections.get(section);
  const entries = Object.entries(values);

  if (!existing) {
    const block = [`[${section}]`, ...entries.map(([k, v]) => `${k}=${v}`), ''];
    const needsGap = lines.length && lines[lines.length - 1].trim() !== '';
    return text + (needsGap ? eol : '') + block.join(eol);
  }

  const out = lines.slice();
  const pending = new Map(entries);
  for (let index = existing.start + 1; index <= existing.end; index++) {
    const pair = out[index].match(/^([^=\r\n]+)=([^\r\n]*)$/);
    if (!pair) continue;
    const key = pair[1].trim();
    if (!pending.has(key)) continue;
    out[index] = `${key}=${pending.get(key)}`;
    pending.delete(key);
  }
  if (pending.size) {
    let insertAt = existing.end;
    while (insertAt > existing.start && out[insertAt].trim() === '') insertAt--;
    const added = [...pending].map(([k, v]) => `${k}=${v}`);
    out.splice(insertAt + 1, 0, ...added);
  }
  return out.join(eol);
}

// Fill in keys that are absent and leave every existing value alone. Used for
// things the user is entitled to have their own opinion about - the overlay
// key above all, since rebinding it and having it silently reset would be
// maddening.
function upsertSectionDefaults(text, section, values) {
  const existing = new Map(Object.entries(readSectionFrom(text, section) || {}));
  const missing = Object.fromEntries(
    Object.entries(values).filter(([key]) => !existing.has(key)));
  return Object.keys(missing).length ? upsertSection(text, section, missing) : text;
}

function readSectionFrom(text, section) {
  const found = parseSections(text).sections.get(section);
  return found ? Object.fromEntries(found.keys) : null;
}

function writeSection(file, section, values) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const next = upsertSection(text, section, values);
  fs.writeFileSync(file, next, 'utf8');
  return next;
}

// ReShade keeps disabled add-ons in a comma-separated list under [ADDON].
// Installing must clear ours from it, or the add-on loads and does nothing.
function enableAddon(text, addonLabel) {
  const { sections } = parseSections(text);
  const addon = sections.get('ADDON');
  if (!addon || !addon.keys.has('DisabledAddons')) return text;
  const current = addon.keys.get('DisabledAddons') || '';
  const kept = current.split(',')
    .map(entry => entry.trim())
    .filter(entry => entry && !entry.toLowerCase().includes(addonLabel.toLowerCase()));
  return upsertSection(text, 'ADDON', { DisabledAddons: kept.join(',') });
}

// Shader search paths. ReShade Setup 6.8 seeds a new config with
// `.\reshade-shaders\Shaders\**\**`: it appends its recursive wildcard to a
// default that already ends in one. ReShade strips ONE trailing `**` as the
// recursive flag and canonicalises the rest, so the second becomes a folder
// literally named `**`; Windows rejects that (error 123) and nothing in the
// folder ever loads - Vulkan games lose the effects boundary the add-on
// captures from, and the optional VORT guides can never be found. Every game
// installed with the old kit carried it. Repair: our path first, any run of
// trailing wildcards collapsed to one, every other path the user has kept.
const DOUBLED_WILDCARD = /(?:\\\*\*){2,}\s*$/;

function canonicalSearchPath(item) {
  return String(item || '').trim().replace(/\//g, '\\').replace(DOUBLED_WILDCARD, '\\**');
}

function searchPathBase(item) {
  return canonicalSearchPath(item).replace(/\\\*\*$/, '').replace(/\\+$/, '').toLowerCase();
}

function mergeSearchPath(value, required) {
  const want = canonicalSearchPath(required);
  const seen = new Set([searchPathBase(want)]);
  const kept = [];
  for (const item of String(value || '').split(',')) {
    const path = canonicalSearchPath(item);
    if (!path) continue;
    const base = searchPathBase(path);
    if (seen.has(base)) continue;   // ours covers it (recursive beats non-recursive)
    seen.add(base);
    kept.push(path);
  }
  return [want, ...kept].join(',');
}

// `required` maps GENERAL keys to the path that must be first, e.g.
// { EffectSearchPaths: '.\\reshade-shaders\\Shaders\\**' }.
function repairSearchPaths(text, required) {
  const general = readSectionFrom(text, 'GENERAL') || {};
  const values = {};
  for (const [key, path] of Object.entries(required)) values[key] = mergeSearchPath(general[key], path);
  return upsertSection(text, 'GENERAL', values);
}

function hasBrokenSearchPaths(text) {
  const general = readSectionFrom(String(text || ''), 'GENERAL') || {};
  return ['EffectSearchPaths', 'TextureSearchPaths'].some(key =>
    String(general[key] || '').split(',').some(item => DOUBLED_WILDCARD.test(item.trim())));
}

module.exports = {
  parseSections, readSection, readSectionFrom, upsertSection, upsertSectionDefaults, writeSection, enableAddon, detectEol,
  mergeSearchPath, repairSearchPaths, hasBrokenSearchPaths,
};
