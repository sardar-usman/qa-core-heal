import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {
  killProcessTree, setProcessTableReader, setProcAvailable, setChildTempWatchStart, sweepChromiumTemps,
  trackChildGroup, untrackChildGroup, trackUnverifiedApply, cleanupChildrenAndOutputs,
  watchChildGroup, trackedChildPids,
} = await import(path.join(repoRoot, 'dist', 'process-guard.js'));

/**
 * The reader returns null, which is the stand-in for a host with no /proc.
 * The fallback must still kill the child group and a browser group under it,
 * and it must leave an unrelated process alone.
 */

const LEADER = `
const { spawn } = require('child_process');
const same = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const own = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
process.stdout.write(JSON.stringify({ same: same.pid, own: own.pid }) + '\\n');
setInterval(() => {}, 1000);
`;

describe('process guard', { concurrency: 1 }, () => {

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stop(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

test('without /proc the fallback kills the child group and descendant groups', async () => {
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  decoy.unref();
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const leader = spawn(process.execPath, ['-e', LEADER], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let kids = { same: 0, own: 0 };
  try {
    kids = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('leader did not report pids')), 5000);
      leader.stdout.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        resolve(JSON.parse(buf.slice(0, nl)));
      });
      leader.on('exit', () => {
        clearTimeout(timer);
        reject(new Error(`leader exited early: ${buf}`));
      });
    });
    setProcessTableReader(() => null);
    killProcessTree(leader.pid);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(leader.pid), false, 'leader');
    assert.equal(alive(kids.same), false, 'same-group worker');
    assert.equal(alive(kids.own), false, 'own-group browser');
    assert.equal(alive(decoy.pid), true, 'unrelated process group');
    assert.equal(alive(sibling.pid), true, 'sibling in this process group');
  } finally {
    setProcessTableReader(null);
    for (const pid of [leader.pid, kids.same, kids.own, decoy.pid, sibling.pid]) stop(pid);
  }
});

test('a zombie child does not use the full stop grace', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 50));
  try {
    process.kill(child.pid, 'SIGKILL');
    const start = performance.now();
    killProcessTree(child.pid);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 450, `grace waited ${elapsed.toFixed(0)}ms`);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  }
});

test('the final kill includes a process that was missing from the first snapshot', async () => {
  const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { detached: true, stdio: 'ignore' });
  const late = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { detached: true, stdio: 'ignore' });
  leader.unref();
  late.unref();
  let n = 0;
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(late.pid), true);
    setProcessTableReader(() => {
      n += 1;
      const self = { pid: process.pid, ppid: 1, pgrp: process.pid };
      const lead = { pid: leader.pid, ppid: process.pid, pgrp: leader.pid };
      if (n === 1) return [self, lead];
      return [self, lead, { pid: late.pid, ppid: leader.pid, pgrp: late.pid }];
    });
    killProcessTree(leader.pid);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(n >= 2, 'the process table was read again before the final kill');
    assert.equal(alive(late.pid), false, 'process that appeared in the second snapshot');
  } finally {
    setProcessTableReader(null);
    stop(leader.pid);
    stop(late.pid);
  }
});

test('a child group is dropped on exit, before close', () => {
  const child = new EventEmitter();
  child.pid = 424242;
  watchChildGroup(child);
  assert.deepEqual(trackedChildPids(), [424242]);
  child.emit('exit', 0);
  assert.deepEqual(trackedChildPids(), []);
  child.emit('close', 0);
  assert.deepEqual(trackedChildPids(), []);
});

function auditEntry(file) {
  return {
    timestamp: '2026-10-28T00:00:00.000Z',
    file,
    line: 1,
    old: 'old',
    new: 'new',
    level: 'css',
    ambiguous: false,
    applied: true,
    verified: false,
    reverted: true,
    revertReason: 'interrupted',
  };
}

test('signal restore writes the original only when the spec is still what heal wrote', () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const file = path.join(dir, 'a.spec.ts');
  const audit = path.join(dir, 'audit.jsonl');
  try {
    fs.writeFileSync(file, 'healed\n');
    trackUnverifiedApply({
      file, original: 'original\n', written: 'healed\n', auditPath: audit, entries: [auditEntry('a.spec.ts')],
    });
    cleanupChildrenAndOutputs();
    assert.equal(fs.readFileSync(file, 'utf8'), 'original\n');
    const line = JSON.parse(fs.readFileSync(audit, 'utf8'));
    assert.equal(line.reverted, true);
    assert.equal(line.revertReason, 'interrupted');
    assert.equal(line.warning, undefined);

    fs.writeFileSync(file, 'someone else\n');
    trackUnverifiedApply({
      file, original: 'original\n', written: 'healed\n', auditPath: audit, entries: [auditEntry('a.spec.ts')],
    });
    cleanupChildrenAndOutputs();
    assert.equal(fs.readFileSync(file, 'utf8'), 'someone else\n');
    const lines = fs.readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].reverted, false);
    assert.equal(lines[1].revertReason, undefined);
    assert.match(lines[1].warning, /left the file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a killed child sweep removes only new Chromium temp folders in the OS temp directory', () => {
  const pid = 2000000001;
  const temp = os.tmpdir();
  const older = path.join(temp, `.org.chromium.Chromium.qa-core-heal-old-${process.pid}`);
  const newer = path.join(temp, `.org.chromium.Chromium.qa-core-heal-new-${process.pid}`);
  const other = path.join(temp, `playwright_chromiumdev_profile-qa-core-heal-${process.pid}`);
  const outside = path.join(repoRoot, `.tmp-test-chromium-${process.pid}`);
  fs.mkdirSync(older);
  fs.mkdirSync(other);
  fs.mkdirSync(outside);
  try {
    trackChildGroup(pid);
    fs.mkdirSync(newer);
    setChildTempWatchStart(pid, Date.now() + 60_000);
    const tooNew = path.join(temp, `.org.chromium.Chromium.qa-core-heal-future-${process.pid}`);
    fs.mkdirSync(tooNew);
    sweepChromiumTemps(pid);
    assert.equal(fs.existsSync(older), true, 'folder from before the child');
    assert.equal(fs.existsSync(newer), true, 'folder created before the recorded start');
    assert.equal(fs.existsSync(tooNew), true, 'folder whose time is before the recorded start');
    assert.equal(fs.existsSync(other), true, 'a different prefix');
    assert.equal(fs.existsSync(outside), true, 'a folder outside the temp directory');
    setChildTempWatchStart(pid, Date.now() - 60_000);
    sweepChromiumTemps(pid);
    assert.equal(fs.existsSync(newer), false, 'folder created after the child started');
    assert.equal(fs.existsSync(tooNew), false, 'folder created after the adjusted start');
    assert.equal(fs.existsSync(older), true);
  } finally {
    untrackChildGroup(pid);
    for (const dir of [older, newer, other, outside, path.join(temp, `.org.chromium.Chromium.qa-core-heal-future-${process.pid}`)]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a killed child sweep removes a new Chromium temp file and a new folder', () => {
  const pid = 2000000002;
  const temp = os.tmpdir();
  const folder = path.join(temp, `.org.chromium.Chromium.qa-core-heal-dir-${process.pid}`);
  const file = path.join(temp, `.org.chromium.Chromium.qa-core-heal-file-${process.pid}`);
  try {
    trackChildGroup(pid);
    setChildTempWatchStart(pid, Date.now() - 60_000);
    fs.mkdirSync(folder);
    fs.writeFileSync(file, '');
    sweepChromiumTemps(pid);
    assert.equal(fs.existsSync(folder), false, 'new folder');
    assert.equal(fs.existsSync(file), false, 'new file');
  } finally {
    untrackChildGroup(pid);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(file, { force: true });
  }
});

test('a sweep leaves an entry another live process holds open', async () => {
  const pid = 2000000003;
  const temp = os.tmpdir();
  const folder = path.join(temp, `.org.chromium.Chromium.qa-core-heal-busy-${process.pid}`);
  fs.mkdirSync(folder);
  const held = path.join(folder, 'held');
  fs.writeFileSync(held, 'x');
  const child = spawn(process.execPath, ['-e', 'const fs = require("fs"); fs.openSync(process.argv[1], "r"); setInterval(() => {}, 1000);', held], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 150));
    trackChildGroup(pid);
    setChildTempWatchStart(pid, Date.now() - 60_000);
    sweepChromiumTemps(pid);
    assert.equal(fs.existsSync(folder), true, 'a process holds a file inside the folder');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', () => resolve()));
    sweepChromiumTemps(pid);
    assert.equal(fs.existsSync(folder), false, 'the folder goes once nothing holds it');
  } finally {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    untrackChildGroup(pid);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('without /proc the sweep removes nothing', () => {
  const pid = 2000000004;
  const temp = os.tmpdir();
  const folder = path.join(temp, `.org.chromium.Chromium.qa-core-heal-noproc-${process.pid}`);
  try {
    trackChildGroup(pid);
    setChildTempWatchStart(pid, Date.now() - 60_000);
    fs.mkdirSync(folder);
    setProcAvailable(false);
    sweepChromiumTemps(pid);
    assert.equal(fs.existsSync(folder), true);
  } finally {
    setProcAvailable(null);
    untrackChildGroup(pid);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('without /proc, alive reads the process table once per loop', () => {
  let reads = 0;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    setProcAvailable(false);
    const extras = [child.pid + 1000, child.pid + 1001, child.pid + 1002, child.pid + 1003];
    setProcessTableReader(() => {
      reads += 1;
      return [
        { pid: process.pid, ppid: 1, pgrp: process.pid, stat: 'S' },
        { pid: child.pid, ppid: process.pid, pgrp: child.pid, stat: 'S' },
        ...extras.map((pid) => ({ pid, ppid: child.pid, pgrp: pid, stat: 'S' })),
      ];
    });
    killProcessTree(child.pid);
    assert.ok(reads >= 1, 'the table was read');
    assert.ok(reads <= 4, `one read per loop, not one read per pid (${reads})`);
  } finally {
    setProcessTableReader(null);
    setProcAvailable(null);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('a deleted spec gets its own audit warning and is not restored', () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const file = path.join(dir, 'a.spec.ts');
  const audit = path.join(dir, 'audit.jsonl');
  try {
    fs.writeFileSync(file, 'healed\n');
    trackUnverifiedApply({
      file, original: 'original\n', written: 'healed\n', auditPath: audit, entries: [auditEntry('a.spec.ts')],
    });
    fs.rmSync(file);
    cleanupChildrenAndOutputs();
    assert.equal(fs.existsSync(file), false);
    const line = JSON.parse(fs.readFileSync(audit, 'utf8'));
    assert.equal(line.reverted, false);
    assert.match(line.warning, /The spec was deleted after heal wrote it, so heal did not restore it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGHUP restores nothing extra, removes a tracked output folder, and exits 129', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-hup-'));
  const code = `
    import { installSignalCleanup, trackOutputDir } from './dist/process-guard.js';
    installSignalCleanup();
    trackOutputDir(process.env.HUP_DIR);
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: repoRoot,
    env: { ...process.env, HUP_DIR: dir },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready: ${out}`)), 5000);
      child.stdout.on('data', () => {
        if (out.includes('ready')) { clearTimeout(timer); resolve(); }
      });
    });
    process.kill(child.pid, 'SIGHUP');
    const status = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    assert.equal(status, 129);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

});
