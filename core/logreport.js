// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Revin (revingale32) - DLSS 5 AIO Installer, github.com/revingale32/dlss5-aio-installer
'use strict';

const fs = require('fs');
const path = require('path');

// Reads standalone-dlssnr.log and says what the numbers mean.
//
// A port of dev/dlss5-log-report.py, kept in step with it. The value is not the
// parsing - it is the verdicts, which encode what we learned the hard way:
// hand-off->ready should sit just above the pipeline period, present->scanout
// should be about one output interval, and a frame-gen multiplier raised after
// the last feature build never took effect.

function defaultLogFile() {
  const local = process.env.LOCALAPPDATA;
  return local ? path.join(local, 'RHI', 'Logs', 'standalone-dlssnr.log') : '';
}

function num(pattern, line) {
  const match = line && line.match(pattern);
  return match ? Number(match[1]) : null;
}

function median(values) {
  const clean = values.filter(v => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function splitSessions(text) {
  const lines = text.split(/\r?\n/);
  const sessions = [];
  let current = null;
  for (const line of lines) {
    if (/Standalone DLSS-NR \+ SR .* attached;/.test(line)) {
      current = { header: line, lines: [] };
      sessions.push(current);
    }
    if (!current) continue;
    current.lines.push(line);
  }
  return sessions;
}

function analyse(session) {
  const lines = session.lines;
  const tail = pattern => lines.filter(line => line.includes(pattern)).slice(-6);

  const telemetry = tail('performance telemetry:');
  if (!telemetry.length) return { header: session.header, empty: true, warnings: [] };

  const period = tail('performance rate lock period:');
  const handoff = tail('performance direct handoff:');
  const lead = tail('performance rate lock lead:');
  const latency = tail('performance latency (measured');

  const report = {
    header: session.header,
    empty: false,
    real: median(telemetry.map(l => num(/source=(\d+) fps/, l))),
    output: median(telemetry.map(l => num(/proxy=(\d+) fps/, l))),
    nr: median(telemetry.map(l => num(/NR=([\d.]+)ms/, l))),
    dlaa: median(telemetry.map(l => num(/(?:DLAA|SR)=([\d.]+)ms/, l))),
    fg: median(telemetry.map(l => num(/FG=([\d.]+)ms/, l))),
    total: median(telemetry.map(l => num(/total=([\d.]+)ms/, l))),
    period: median(period.map(l => num(/period: ([\d.]+)ms/, l))),
    gap: median(period.map(l => num(/gap ([\d.]+)ms/, l))),
    submitToReady: median(handoff.map(l => num(/submit->ready=([\d.]+)ms/, l))),
    gameFrame: median(lead.map(l => num(/game frame=([\d.]+)ms/, l))),
    queueWait: median(lead.map(l => num(/queue wait=([\d.]+)ms/, l))),
    warnings: [],
    verdicts: [],
  };

  if (latency.length) {
    const last = latency[latency.length - 1];
    report.latency = {
      releaseToSubmit: num(/release->submit=([\d.]+)ms/, last),
      submitToReady: num(/submit->ready=([\d.]+)ms/, last),
      readyToPresent: num(/ready->present=([\d.]+)ms/, last),
      presentToScanout: num(/present->scanout=([\d.]+)ms/, last),
      total: num(/release->scanout=([\d.]+)ms/, last),
    };
  }

  // --- verdicts
  if (report.submitToReady !== null && report.period !== null) {
    const excess = report.submitToReady - report.period;
    report.verdicts.push({
      name: 'rate lock',
      value: `hand-off->ready ${report.submitToReady.toFixed(1)} ms vs period ${report.period.toFixed(1)} ms`,
      verdict: excess < 6 ? 'tight' : excess < 15 ? 'one extra job queued' : 'deep queue - the lock is not holding',
      good: excess < 6,
    });
  }
  if (report.latency && report.latency.presentToScanout !== null && report.output) {
    const interval = 1000 / Math.max(1, report.output);
    const depth = report.latency.presentToScanout / interval;
    report.verdicts.push({
      name: 'presentation queue',
      value: `present->scanout ${report.latency.presentToScanout.toFixed(1)} ms = ${depth.toFixed(1)} output frames`,
      verdict: depth < 1.8 ? 'tight' : `${depth.toFixed(1)} frames queued ahead of the screen`,
      good: depth < 1.8,
    });
  }
  if (report.queueWait !== null) {
    report.verdicts.push({
      name: 'GPU contention',
      value: `neural queue wait ${report.queueWait.toFixed(1)} ms`,
      verdict: report.queueWait < 8 ? 'clear' : 'the game\'s own GPU work is in front of ours - try NeuralQueuePriorityHigh=1',
      good: report.queueWait < 8,
    });
  }

  // --- warnings
  const has = pattern => lines.some(line => pattern.test(line));
  if (has(/SynchronousProxyPresentation=1|presenter=serialized/)) {
    report.warnings.push('the serialized presenter was active at some point (stale SynchronousProxyPresentation)');
  }
  if (has(/Failed to initialize|pipeline FAILED/)) report.warnings.push('the pipeline failed - read the line itself');
  if (has(/residual NR inputs unavailable|residual NR evaluation rejected/)) {
    report.warnings.push('residual NR was unavailable and reverted to full-resolution NR');
  }
  if (has(/present queue gate stood down/)) {
    report.warnings.push('the present queue gate stood down - latency is back to whatever the queue depth is');
  }
  if (latency.some(l => /meter unavailable/.test(l))) {
    report.warnings.push('DXGI frame statistics unavailable: present->scanout was not measured');
  }
  const nrOff = telemetry.filter(l => (num(/NR=([\d.]+)ms/, l) ?? 1) < 0.1).length;
  if (nrOff) report.warnings.push(`${nrOff} of the last ${telemetry.length} telemetry blocks show NR=0.00 ms (neural rendering not running)`);

  let built = null;
  let asked = null;
  lines.forEach((line, index) => {
    const b = line.match(/requested multiplier=(\d)x ->/);
    if (b) built = { index, value: Number(b[1]) };
    const a = line.match(/frame generation multiplier changed to (\d)x/);
    if (a) asked = { index, value: Number(a[1]) };
  });
  if (built && asked && asked.index > built.index && asked.value !== built.value) {
    report.warnings.push(`frame gen was set to ${asked.value}x after the last feature build (${built.value}x), `
      + `so it kept presenting ${built.value}x - change passes or restart for it to take effect`);
  }
  if (lines.slice(-200).some(line => /overlay opened/.test(line))) {
    report.warnings.push('the ReShade overlay was open near the end - judge latency with it closed');
  }
  return report;
}

function read(file = defaultLogFile()) {
  const text = fs.readFileSync(file, 'utf8');
  return splitSessions(text).map(analyse);
}

function format(reports) {
  const out = [];
  const ms = value => (value === null || value === undefined ? 'n/a' : `${value.toFixed(1)} ms`);
  for (const report of reports) {
    out.push('='.repeat(96));
    out.push(report.header.slice(0, 120));
    if (report.empty) { out.push('  (no telemetry in this session)'); continue; }
    out.push(`  real ${report.real ?? 'n/a'} fps | output ${report.output ?? 'n/a'} fps | game CPU frame ${ms(report.gameFrame)}`);
    out.push(`  GPU: NR ${ms(report.nr)} + DLAA ${ms(report.dlaa)} + FG ${ms(report.fg)} = ${ms(report.total)}; period ${ms(report.period)} (gap ${ms(report.gap)})`);
    if (report.latency) {
      const l = report.latency;
      out.push(`  latency: release->submit ${ms(l.releaseToSubmit)} + submit->ready ${ms(l.submitToReady)} `
        + `+ ready->present ${ms(l.readyToPresent)} + present->scanout ${ms(l.presentToScanout)} = ${ms(l.total)}`);
    }
    for (const verdict of report.verdicts) {
      out.push(`  ${verdict.good ? '+' : '!'} ${verdict.name}: ${verdict.value} -> ${verdict.verdict}`);
    }
    for (const warning of report.warnings) out.push(`  ! ${warning}`);
  }
  out.push('='.repeat(96));
  return out.join('\n');
}

module.exports = { read, analyse, splitSessions, format, defaultLogFile };
