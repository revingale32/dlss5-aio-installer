// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const media = require('./media');

// Runs dlss5-media.exe and turns its stdout into events. One job at a time,
// per kind: a batch of pictures or videos ("job"), or desktop mode
// ("desktop"). The two can run together - desktop mode shows what is on the
// screen, a job renders files - but never two of the same kind.
//
// Stopping is polite first: "cancel" on stdin (the worker finishes the frame
// it is on, deletes the half-written file and exits), then the process is
// killed if it has not gone after a grace period.

const GRACE_MS = 6000;

function createRunner({ spawn, onEvent = () => {}, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof spawn !== 'function') throw new Error('createRunner needs a spawn function');
  const running = { job: null, desktop: null };

  function start(slot, exe, args, meta = {}) {
    if (slot !== 'job' && slot !== 'desktop') throw new Error(`Unknown slot ${slot}`);
    if (running[slot]) return { ok: false, error: slot === 'job' ? 'A job is already running.' : 'Desktop mode is already running.' };
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      return { ok: false, error: `The media worker could not start: ${error.message}` };
    }
    const entry = { child, meta, events: [], exited: false, killTimer: null, lastError: null, done: null };
    running[slot] = entry;
    let buffer = '';
    const emit = event => {
      entry.events.push(event);
      if (entry.events.length > 400) entry.events.splice(0, entry.events.length - 400);
      if (event.event === 'error' || event.event === 'file-error' || event.event === 'crash') entry.lastError = event;
      if (event.event === 'done') entry.done = event;
      onEvent({ ...event, slot, job: meta.id || null });
    };
    if (child.stdout) {
      child.stdout.setEncoding && child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer = media.splitLines(buffer + chunk, line => {
          const event = media.parseLine(line);
          if (event) emit(event);
          else if (line.trim()) log(`media worker: ${line.trim().slice(0, 300)}`);
        });
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding && child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        const text = String(chunk).trim();
        if (text) log(`media worker (stderr): ${text.slice(0, 300)}`);
      });
    }
    if (child.stdin && child.stdin.on) child.stdin.on('error', () => {});   // the worker may exit first
    const finish = (code, signal) => {
      if (entry.exited) return;
      entry.exited = true;
      if (entry.killTimer) clearTimer(entry.killTimer);
      if (buffer.trim()) { const event = media.parseLine(buffer); if (event) emit(event); buffer = ''; }
      if (running[slot] === entry) running[slot] = null;
      onEvent({ event: 'exit', slot, job: meta.id || null, code: code === null || code === undefined ? null : code, signal: signal || null,
        ok: code === 0, error: entry.lastError ? (entry.lastError.message || entry.lastError.code || null) : null });
    };
    child.on('exit', finish);
    child.on('error', error => {
      entry.lastError = { event: 'error', message: error.message };
      finish(-1, null);
    });
    return { ok: true, pid: child.pid || null };
  }

  function stop(slot) {
    const entry = running[slot];
    if (!entry) return { ok: true, running: false };
    try {
      if (entry.child.stdin && !entry.child.stdin.destroyed) {
        entry.child.stdin.write(slot === 'desktop' ? 'stop\n' : 'cancel\n');
        entry.child.stdin.end();
      }
    } catch { /* already gone */ }
    if (!entry.killTimer) {
      entry.killTimer = setTimer(() => {
        if (!entry.exited) {
          log(`media worker did not stop within ${GRACE_MS / 1000} s - ending it`);
          try { entry.child.kill(); } catch { /* already gone */ }
        }
      }, GRACE_MS);
    }
    return { ok: true, running: true };
  }

  // One line for a running worker (a live command); false when nothing runs.
  function command(slot, line) {
    const entry = running[slot];
    if (!entry || entry.exited || !entry.child.stdin || entry.child.stdin.destroyed) return false;
    if (/[\r\n]/.test(String(line))) throw new Error('A command is one line.');
    try { entry.child.stdin.write(`${line}\n`); return true; } catch { return false; }
  }

  function stopAll() { stop('job'); stop('desktop'); }

  function status() {
    return {
      job: running.job ? { id: running.job.meta.id || null, mode: running.job.meta.mode || null, pid: running.job.child.pid || null } : null,
      desktop: running.desktop ? { pid: running.desktop.child.pid || null } : null,
    };
  }

  function isRunning(slot) { return Boolean(running[slot]); }

  return { start, stop, command, stopAll, status, isRunning };
}

// Runs the worker once to completion and collects its events (probe, monitor
// list). Resolves with { code, events }; never rejects.
function runOnce(spawn, exe, args, { timeoutMs = 90000 } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (error) {
      resolve({ code: -1, events: [{ event: 'error', message: `The media worker could not start: ${error.message}` }] });
      return;
    }
    const events = [];
    let buffer = '';
    let settled = false;
    const settle = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffer.trim()) { const event = media.parseLine(buffer); if (event) events.push(event); }
      resolve({ code, events });
    };
    const timer = setTimeout(() => {
      events.push({ event: 'error', message: `The media worker did not finish within ${Math.round(timeoutMs / 1000)} s.` });
      try { child.kill(); } catch { /* gone */ }
      settle(-2);
    }, timeoutMs);
    if (child.stdout) {
      child.stdout.setEncoding && child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer = media.splitLines(buffer + chunk, line => { const event = media.parseLine(line); if (event) events.push(event); });
      });
    }
    if (child.stdin && child.stdin.on) child.stdin.on('error', () => {});
    child.on('exit', code => settle(code));
    child.on('error', error => { events.push({ event: 'error', message: error.message }); settle(-1); });
  });
}

module.exports = { createRunner, runOnce, GRACE_MS };
