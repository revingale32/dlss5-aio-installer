// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Write-ahead journal for touching someone else's game folder.
//
// The contract: nothing is overwritten until a byte-for-byte copy of it exists
// on disk, and if any step of an install throws, every file returns to exactly
// what it was. A half-installed game folder is the one outcome that is never
// acceptable - the user cannot tell what happened and neither can we.
//
// Layout, inside the game folder:
//   .dlss5-aio/backup/<txn>/<n>.bin   the original bytes
//   .dlss5-aio/txn-<txn>.json         what that transaction intends to do
//   .dlss5-aio/manifest.json          what is currently installed

const STATE_DIR = '.dlss5-aio';

function stateDir(gameDir) { return path.join(gameDir, STATE_DIR); }

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

// Windows marks some game files read-only; clearing the flag is part of the
// job, and the original attributes go back on restore.
function clearReadOnly(file) {
  try {
    const mode = fs.statSync(file).mode;
    if (!(mode & 0o200)) { fs.chmodSync(file, mode | 0o200); return mode; }
    return mode;
  } catch { return null; }
}

class Transaction {
  constructor(gameDir) {
    this.gameDir = gameDir;
    this.id = crypto.randomBytes(8).toString('hex');
    this.dir = path.join(stateDir(gameDir), 'backup', this.id);
    this.records = [];      // {target, backup?, existed, mode?}
    this.committed = false;
    this.sequence = 0;
  }

  get journalFile() { return path.join(stateDir(this.gameDir), `txn-${this.id}.json`); }

  begin() {
    ensureDir(this.dir);
    this.#flush();
    return this;
  }

  #flush() {
    ensureDir(path.dirname(this.journalFile));
    fs.writeFileSync(this.journalFile, JSON.stringify({
      id: this.id, gameDir: this.gameDir, records: this.records, committed: this.committed,
    }, null, 2));
  }

  // Snapshot `target` before it is written. Safe to call for a file that does
  // not exist yet - the record then says so, and rollback deletes it.
  capture(target) {
    if (this.records.some(record => record.target === target)) return;
    const existed = fs.existsSync(target);
    let backup = null;
    let mode = null;
    if (existed) {
      mode = fs.statSync(target).mode;
      backup = path.join(this.dir, `${this.sequence++}.bin`);
      fs.copyFileSync(target, backup);
      if (sha256(backup) !== sha256(target)) {
        throw new Error(`backup of ${path.basename(target)} did not verify`);
      }
    }
    this.records.push({ target, backup, existed, mode });
    this.#flush();
  }

  writeFile(target, buffer) {
    this.capture(target);
    ensureDir(path.dirname(target));
    clearReadOnly(target);
    fs.writeFileSync(target, buffer);
  }

  copyFile(source, target) {
    this.capture(target);
    ensureDir(path.dirname(target));
    clearReadOnly(target);
    fs.copyFileSync(source, target);
  }

  commit() {
    this.committed = true;
    this.#flush();
  }

  // Put everything back. Ordered last-to-first so a file written twice in one
  // transaction lands on its true original.
  rollback() {
    for (let index = this.records.length - 1; index >= 0; index--) {
      const record = this.records[index];
      try {
        if (!record.existed) {
          if (fs.existsSync(record.target)) { clearReadOnly(record.target); fs.rmSync(record.target, { force: true }); }
          continue;
        }
        if (!record.backup || !fs.existsSync(record.backup)) {
          throw new Error(`backup for ${record.target} is missing; refusing to guess`);
        }
        clearReadOnly(record.target);
        fs.copyFileSync(record.backup, record.target);
        if (record.mode !== null && record.mode !== undefined) {
          try { fs.chmodSync(record.target, record.mode); } catch { /* best effort */ }
        }
      } catch (error) {
        // Keep going: one unrecoverable file must not strand the rest.
        record.error = String(error && error.message || error);
      }
    }
    this.#flush();
    return this.records.filter(record => record.error);
  }

  // Successful installs keep their backups (that is what restore-originals
  // uses later); only the intent journal goes away.
  finish() {
    try { fs.rmSync(this.journalFile, { force: true }); } catch { /* ignore */ }
  }
}

// An install that died mid-write leaves an uncommitted journal behind. Finding
// one on the next run means the folder is in an unknown state, and the only
// safe move is to put it back before doing anything else.
function pendingTransactions(gameDir) {
  const dir = stateDir(gameDir);
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const pending = [];
  for (const entry of entries) {
    if (!/^txn-[0-9a-f]+\.json$/.test(entry)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'));
      if (!data.committed) pending.push(data);
    } catch { /* unreadable journal: leave it for a human */ }
  }
  return pending;
}

function recover(gameDir) {
  const recovered = [];
  for (const data of pendingTransactions(gameDir)) {
    const txn = new Transaction(gameDir);
    txn.id = data.id;
    txn.dir = path.join(stateDir(gameDir), 'backup', data.id);
    txn.records = data.records || [];
    const failures = txn.rollback();
    txn.finish();
    recovered.push({ id: data.id, failures });
  }
  return recovered;
}

module.exports = { Transaction, pendingTransactions, recover, stateDir, sha256, STATE_DIR };
