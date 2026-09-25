// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// Valve KeyValues (.vdf / .acf) reader.
//
// The format is simple but has three traps worth handling properly rather than
// by regex: values may contain escaped quotes and backslashes (every Windows
// path in libraryfolders.vdf is written with doubled backslashes), keys may be
// unquoted, and `//` comments may follow a pair on the same line. Steam also
// ships conditional suffixes like [$WIN32] which are ignored here.

function parse(text) {
  let i = 0;
  const n = text.length;

  function skipTrivia() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      break;
    }
  }

  function readQuoted() {
    i++; // opening quote
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '\\') {
        const next = text[i + 1];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === undefined) out += '\\';
        else out += next;          // covers \\ and \"
        i += 2;
        continue;
      }
      if (c === '"') { i++; return out; }
      out += c;
      i++;
    }
    return out;                     // unterminated: take what we have
  }

  function readBare() {
    let out = '';
    while (i < n && !' \t\r\n"{}'.includes(text[i])) { out += text[i]; i++; }
    return out;
  }

  function readToken() {
    skipTrivia();
    if (i >= n) return null;
    if (text[i] === '"') return readQuoted();
    if (text[i] === '{' || text[i] === '}') { const c = text[i]; i++; return c; }
    return readBare();
  }

  function readObject() {
    const obj = Object.create(null);
    for (;;) {
      const key = readToken();
      if (key === null || key === '}') return obj;
      if (key === '{') continue;            // stray brace: ignore
      skipTrivia();
      if (i < n && text[i] === '{') {
        i++;
        const child = readObject();
        obj[key] = mergeDuplicate(obj[key], child);
        continue;
      }
      const value = readToken();
      if (value === null) return obj;
      if (value === '}') { obj[key] = ''; return obj; }
      // Drop a platform conditional if one follows, e.g. "key" "value" [$WIN32]
      skipTrivia();
      if (text[i] === '[') { while (i < n && text[i] !== ']') i++; i++; }
      obj[key] = mergeDuplicate(obj[key], value);
    }
  }

  // Duplicate keys are legal in KeyValues. Keep the first; Steam's own readers
  // do the same, and silently overwriting has bitten tools that assumed unique.
  function mergeDuplicate(existing, incoming) {
    return existing === undefined ? incoming : existing;
  }

  skipTrivia();
  const rootKey = readToken();
  if (rootKey === null) return {};
  skipTrivia();
  if (text[i] === '{') {
    i++;
    return { [rootKey]: readObject() };
  }
  return { [rootKey]: readToken() ?? '' };
}

// Case-insensitive lookup: Steam is inconsistent about capitalisation between
// versions ("AppState" vs "appstate" has both been seen in the wild).
function get(obj, ...path) {
  let node = obj;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    if (key in node) { node = node[key]; continue; }
    const found = Object.keys(node).find(k => k.toLowerCase() === String(key).toLowerCase());
    if (found === undefined) return undefined;
    node = node[found];
  }
  return node;
}

module.exports = { parse, get };
