// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

// What the app did this session, in order, for the Home page and the copy
// button. Kept in memory only: the durable record of an install is the
// manifest and history.jsonl beside the game, written by core/install.js.

function create({ limit = 300, now = () => new Date() } = {}) {
  const entries = [];
  const listeners = new Set();

  function log(message, level = 'info') {
    const entry = { at: now().toISOString(), level, message: String(message) };
    entries.push(entry);
    if (entries.length > limit) entries.splice(0, entries.length - limit);
    for (const listener of listeners) { try { listener(entry); } catch { /* a listener never breaks logging */ } }
    return entry;
  }

  return {
    log,
    info: message => log(message, 'info'),
    warn: message => log(message, 'warn'),
    error: message => log(message, 'error'),
    list: () => entries.slice(),
    clear: () => { entries.length = 0; },
    onEntry: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    // Plain text for the clipboard: one line per entry, local time first.
    text: () => entries.map(entry => `[${clock(entry.at)}] ${entry.level === 'info' ? '' : entry.level.toUpperCase() + ' '}${entry.message}`).join('\n'),
  };
}

// HH:MM:SS in the PC's own time zone (entries are stored as UTC ISO strings).
function clock(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return String(at).slice(11, 19);
  const two = n => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

module.exports = { create, clock };
