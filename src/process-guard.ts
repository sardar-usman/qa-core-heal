import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendAuditLog, type AuditEntry } from './audit.js';

/**
 * Cleanup for a heal process that is stopped mid-run.
 *
 * Playwright children are started in their own process group, and the
 * browsers they launch lead yet another group. A SIGINT, SIGTERM, SIGHUP,
 * or run timeout delivered to heal does not reach those groups, and a
 * killed process does not run its finally blocks, so the temporary output
 * folder would stay behind. The CLI traps those signals, kills every group
 * in the child tree, and removes the folders it still owns. Without /proc
 * the same tree is read from ps. A normal process.exit (the run-timeout
 * failure path) runs the same cleanup.
 *
 * With neither /proc nor ps, kill(-pid) can signal only the direct child's
 * process group. A browser that leads its own group stays behind. macOS
 * always provides ps, so that path is a last resort (a stripped Linux
 * image, for example).
 */

export interface ProcessRow { pid: number; ppid: number; pgrp: number; stat?: string }

/**
 * How long to wait after SIGTERM before SIGKILL.
 * Chromium deletes its temporary profile on SIGTERM. SIGKILL skips that.
 */
const STOP_GRACE_MS = 500;

/** Chromium leaves this prefix in the temp directory when it is killed. */
const CHROMIUM_TEMP_PREFIX = '.org.chromium.Chromium.';

const HAS_PROC = fs.existsSync('/proc');

/** How long to wait for `taskkill` on Windows before giving up on it. */
const TASKKILL_TIMEOUT_MS = 10_000;

/** A test sets this to run the Windows path on another host. Null uses the real platform. */
let platformForced: NodeJS.Platform | null = null;

export function setPlatformForTest(value: NodeJS.Platform | null): void {
  platformForced = value;
}

function onWindows(): boolean {
  return (platformForced ?? process.platform) === 'win32';
}

/** Runs `taskkill`. A test injects a fake so no real process is touched. */
export type TaskkillRunner = (command: string, args: string[], options: { stdio: 'ignore'; windowsHide: true; timeout: number }) => { error?: Error; status: number | null };

let taskkillRunner: TaskkillRunner | null = null;

export function setTaskkillRunner(runner: TaskkillRunner | null): void {
  taskkillRunner = runner;
}

/**
 * Stop a process and every process it started on Windows, and wait until
 * `taskkill` is done. `/T` stops the whole tree and `/F` forces it. Windows
 * has no process groups, so killing only the direct child would leave the
 * Playwright workers and the browsers running. When `taskkill` cannot start,
 * the direct child is still killed.
 */
function taskkillTree(pid: number): void {
  const args = ['/T', '/F', '/PID', String(pid)];
  const options = { stdio: 'ignore', windowsHide: true, timeout: TASKKILL_TIMEOUT_MS } as const;
  let failed = false;
  try {
    const run = taskkillRunner ? taskkillRunner('taskkill', args, options) : spawnSync('taskkill', args, options);
    failed = Boolean(run.error);
  } catch {
    failed = true;
  }
  if (failed) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** A test injects this to hide /proc. Null means that source has no table. */
let tableReader: (() => ProcessRow[] | null) | null = null;

export function setProcessTableReader(reader: (() => ProcessRow[] | null) | null): void {
  tableReader = reader;
}

/**
 * Test hook. Null uses the real host. False forces the no-/proc path so a
 * test can answer every pid from one table read.
 */
let procForced: boolean | null = null;
export function setProcAvailable(value: boolean | null): void {
  procForced = value;
  statSnapshot = null;
}

function procAvailable(): boolean {
  return procForced ?? HAS_PROC;
}

/** One stat table for the current alive() loop. Null means "read it on the next question". */
let statSnapshot: Map<number, string> | null = null;

function readStatSnapshot(): Map<number, string> {
  const map = new Map<number, string>();
  if (tableReader) {
    const rows = tableReader() ?? [];
    for (const row of rows) map.set(row.pid, row.stat ?? 'R');
    return map;
  }
  try {
    const run = spawnSync('ps', ['-A', '-o', 'pid=,stat='], { encoding: 'utf8' });
    if (run.status !== 0 || !run.stdout) return map;
    for (const line of run.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      if (!Number.isInteger(pid)) continue;
      map.set(pid, parts.slice(1).join(' '));
    }
  } catch { /* an empty table answers every pid as not a zombie */ }
  return map;
}

function refreshStatSnapshot(): void {
  statSnapshot = procAvailable() ? null : readStatSnapshot();
}

function readProcFile(pid: number): ProcessRow | null {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    const pgrp = Number(rest[2]);
    if (!Number.isInteger(ppid) || !Number.isInteger(pgrp)) return null;
    return { pid, ppid, pgrp };
  } catch {
    return null;
  }
}

/** Process state letter from /proc, or null when the entry cannot be read. */
function readProcState(pid: number): string | null {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = text.slice(text.lastIndexOf(')') + 2).split(' ')[0];
    return state || null;
  } catch {
    return null;
  }
}

/** True for a zombie. kill(pid, 0) is true for a zombie, so it is not enough. */
function isZombie(pid: number): boolean {
  if (procAvailable()) return readProcState(pid) === 'Z';
  if (!statSnapshot) statSnapshot = readStatSnapshot();
  const stat = statSnapshot.get(pid);
  return stat != null && stat.startsWith('Z');
}

function readProcTable(): ProcessRow[] | null {
  if (!fs.existsSync('/proc')) return null;
  const rows: ProcessRow[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync('/proc'); } catch { return null; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const row = readProcFile(Number(name));
    if (row) rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}

/** macOS and any host without /proc. `ps` columns are pid, ppid, pgid. */
function readPsTable(): ProcessRow[] | null {
  try {
    const run = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' });
    if (run.status !== 0 || !run.stdout) return null;
    const rows: ProcessRow[] = [];
    for (const line of run.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const pgrp = Number(parts[2]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgrp)) continue;
      rows.push({ pid, ppid, pgrp });
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

function loadProcessTable(): ProcessRow[] | null {
  if (tableReader) {
    const rows = tableReader();
    if (rows && rows.length > 0) return rows;
    if (rows && rows.length === 0) return rows;
  } else {
    const fromProc = readProcTable();
    if (fromProc) return fromProc;
  }
  return readPsTable();
}

function selfGroup(rows: ProcessRow[] | null): number | undefined {
  return rows?.find((r) => r.pid === process.pid)?.pgrp;
}

function nap(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  if (isZombie(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function signalIds(groups: Set<number>, direct: number[], sig: NodeJS.Signals): void {
  for (const g of groups) {
    try { process.kill(-g, sig); } catch { /* already gone */ }
  }
  for (const p of direct) {
    try { process.kill(p, sig); } catch { /* already gone */ }
  }
}

interface TreeStop {
  groups: Set<number>;
  direct: number[];
  watched: number[];
  pgrpOf: Map<number, number>;
}

function treeOf(pid: number, rows: ProcessRow[]): TreeStop {
  const mine = selfGroup(rows);
  const byParent = new Map<number, number[]>();
  const pgrpOf = new Map<number, number>();
  for (const row of rows) {
    pgrpOf.set(row.pid, row.pgrp);
    const kids = byParent.get(row.ppid);
    if (kids) kids.push(row.pid);
    else byParent.set(row.ppid, [row.pid]);
  }
  const groups = new Set<number>();
  const direct: number[] = [];
  const watched: number[] = [];
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur) || cur === process.pid) continue;
    seen.add(cur);
    watched.push(cur);
    const g = pgrpOf.get(cur) ?? (cur === pid ? pid : 0);
    if (g > 1 && g !== mine) groups.add(g);
    else direct.push(cur);
    for (const kid of byParent.get(cur) ?? []) stack.push(kid);
  }
  if (pid > 1 && pid !== mine) groups.add(pid);
  return { groups, direct, watched, pgrpOf };
}

/**
 * Stop a child and every process group under it.
 * The direct child is a group leader. Browsers it spawned are leaders of
 * their own groups, so killing only the child group leaves them behind.
 * SIGTERM goes out first. After a short wait, the process table is read
 * again so a process that started after the first snapshot is included in
 * the final SIGKILL. Groups that are already dead are not signaled.
 * On Windows there are no process groups, so `taskkill /T /F` stops the
 * child and everything it started, and the call waits for it.
 */
export function killProcessTree(pid: number): void {
  try {
    if (!Number.isInteger(pid) || pid <= 1) return;
    if (onWindows()) {
      taskkillTree(pid);
      return;
    }
    const rows = loadProcessTable();
    if (!rows) {
      // No process table: /proc is missing and ps failed or is not installed.
      // kill(-pid) signals only the direct child's process group. A browser
      // that leads its own group stays behind. macOS always provides ps, so
      // this path is a last resort, for example a stripped Linux image.
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      return;
    }
    const first = treeOf(pid, rows);
    signalIds(first.groups, first.direct, 'SIGTERM');
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
      refreshStatSnapshot();
      if (first.watched.every((p) => !alive(p))) break;
      statSnapshot = null;
      nap(50);
    }
    refreshStatSnapshot();
    const again = loadProcessTable();
    const second = again ? treeOf(pid, again) : first;
    const table = again ?? rows;
    const mine = selfGroup(table);
    const pgrpOf = new Map<number, number>(first.pgrpOf);
    for (const row of table) pgrpOf.set(row.pid, row.pgrp);
    const watched = new Set<number>([...first.watched, ...second.watched]);
    const liveGroups = new Set<number>();
    const liveDirect: number[] = [];
    for (const p of watched) {
      if (!alive(p)) continue;
      const g = pgrpOf.get(p) ?? 0;
      if (g > 1 && g !== mine) liveGroups.add(g);
      else liveDirect.push(p);
    }
    if (alive(pid) && pid > 1 && pid !== mine) liveGroups.add(pid);
    signalIds(liveGroups, liveDirect, 'SIGKILL');
  } finally {
    sweepChromiumTemps(pid);
  }
}

const outputDirs = new Set<string>();
const childGroups = new Set<number>();
let installed = false;
let exitInstalled = false;

/** A file written by --apply whose verify re-run has not finished. */
interface UnverifiedApply {
  file: string;
  /** The spec before heal wrote it. */
  original: string;
  /** The spec as heal left it. Restore only while the file still matches this. */
  written: string;
  auditPath: string;
  entries: AuditEntry[];
}

const unverified: UnverifiedApply[] = [];

/** Remember a file that --apply wrote and has not verified yet. A signal restores it. */
export function trackUnverifiedApply(apply: UnverifiedApply): void {
  unverified.push(apply);
}

/** Verify finished (pass or revert). A later signal must not restore the file again. */
export function clearUnverifiedApplies(): void {
  unverified.length = 0;
}

/** How many applied files are still waiting for verification. Tests use this. */
export function unverifiedApplyCount(): number {
  return unverified.length;
}

const SPEC_CHANGED_WARNING = 'The spec changed after heal wrote it, so heal left the file as it is.';
const SPEC_DELETED_WARNING = 'The spec was deleted after heal wrote it, so heal did not restore it.';

/** Put each unverified file back and append an audit line that it was interrupted and reverted. */
function restoreUnverifiedApplies(): void {
  const pending = unverified.splice(0, unverified.length);
  for (const p of pending) {
    let current: string | null = null;
    try { current = fs.readFileSync(p.file, 'utf8'); } catch { current = null; }
    if (current !== null && current === p.written) {
      try { fs.writeFileSync(p.file, p.original); } catch { /* already gone */ }
    } else {
      const deleted = current === null && !fs.existsSync(p.file);
      for (const entry of p.entries) {
        entry.reverted = false;
        delete entry.revertReason;
        entry.warning = deleted ? SPEC_DELETED_WARNING : SPEC_CHANGED_WARNING;
      }
    }
    try { appendAuditLog(p.auditPath, p.entries); } catch { /* best effort */ }
  }
}

export function trackOutputDir(dir: string): void {
  outputDirs.add(dir);
}

export function untrackOutputDir(dir: string): void {
  outputDirs.delete(dir);
}

/**
 * A `.qa-core` directory this run created. The signal path deletes the scratch
 * inside it, then removes the directory when that leaves it empty.
 */
const createdQaCoreDirs = new Set<string>();

export function trackCreatedQaCore(dir: string): void {
  createdQaCoreDirs.add(path.resolve(dir));
}

export function untrackCreatedQaCore(dir: string): void {
  createdQaCoreDirs.delete(path.resolve(dir));
}

function removeEmptyCreatedQaCore(): void {
  for (const dir of createdQaCoreDirs) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* a folder heal did not create, or one that is not empty, stays */ }
  }
  createdQaCoreDirs.clear();
}

interface ChromiumWatch {
  tempDir: string;
  startedAtMs: number;
  before: Set<string>;
}

const tempWatches = new Map<number, ChromiumWatch>();

function chromiumTempEntries(tempDir: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(tempDir); } catch { return []; }
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith(CHROMIUM_TEMP_PREFIX)) continue;
    const full = path.join(tempDir, name);
    try {
      const st = fs.lstatSync(full);
      if (st.isDirectory() || st.isFile()) out.push(full);
    } catch { /* gone */ }
  }
  return out;
}

function rememberChromiumTemps(pid: number, startedAtMs = Date.now()): void {
  const tempDir = os.tmpdir();
  tempWatches.set(pid, { tempDir, startedAtMs, before: new Set(chromiumTempEntries(tempDir)) });
}

/** Test hook: pretend the child started at this wall-clock time. */
export function setChildTempWatchStart(pid: number, startedAtMs: number): void {
  const watch = tempWatches.get(pid);
  if (watch) watch.startedAtMs = startedAtMs;
}

function sameDirectory(a: string, b: string): boolean {
  try { return fs.realpathSync(a) === fs.realpathSync(b); }
  catch { return path.resolve(a) === path.resolve(b); }
}

/** True when a live process uses this path as its cwd or holds a file open inside it. */
function entryBusy(entry: string): boolean {
  if (!procAvailable()) return true;
  let names: string[];
  try { names = fs.readdirSync('/proc'); } catch { return true; }
  const prefix = entry.endsWith(path.sep) ? entry : entry + path.sep;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const procPid = Number(name);
    if (!alive(procPid)) continue;
    let cwd = '';
    try { cwd = fs.readlinkSync(`/proc/${procPid}/cwd`); } catch { cwd = ''; }
    if (cwd === entry || (cwd !== '' && cwd.startsWith(prefix))) return true;
    let fds: string[] = [];
    try { fds = fs.readdirSync(`/proc/${procPid}/fd`); } catch { fds = []; }
    for (const fd of fds) {
      let target = '';
      try { target = fs.readlinkSync(`/proc/${procPid}/fd/${fd}`); } catch { continue; }
      if (target === entry || target.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Remove `.org.chromium.Chromium.*` files and directories in the OS temp
 * directory that appeared after this child started. Entries that were
 * already there, entries outside the temp directory, and entries a live
 * process is using are left alone. Without /proc the sweep cannot tell
 * which entries are in use, so it removes nothing.
 */
export function sweepChromiumTemps(pid: number): void {
  if (!procAvailable()) return;
  const watch = tempWatches.get(pid);
  if (!watch) return;
  if (!sameDirectory(watch.tempDir, os.tmpdir())) return;
  for (const entry of chromiumTempEntries(watch.tempDir)) {
    if (watch.before.has(entry)) continue;
    let born = 0;
    try {
      const st = fs.lstatSync(entry);
      if (!st.isDirectory() && !st.isFile()) continue;
      born = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
    } catch { continue; }
    if (born + 1000 < watch.startedAtMs) continue;
    if (entryBusy(entry)) continue;
    try { fs.rmSync(entry, { recursive: true, force: true }); }
    catch {
      nap(50);
      try { fs.rmSync(entry, { recursive: true, force: true }); } catch { /* in use or already gone */ }
    }
  }
}

export function trackChildGroup(pid: number): void {
  childGroups.add(pid);
  rememberChromiumTemps(pid);
}

export function untrackChildGroup(pid: number): void {
  childGroups.delete(pid);
  tempWatches.delete(pid);
}

/** Pids currently tracked. Tests use this to see that exit drops a child. */
export function trackedChildPids(): number[] {
  return [...childGroups];
}

/**
 * Track a Playwright child until it exits. 'exit' fires when the process
 * is gone. 'close' waits for the pipes as well, and the pid can be reused
 * in that gap, so the group is dropped on 'exit' (and on 'error').
 * On Windows the child is tracked as well, so a signal to heal stops the
 * child tree with `taskkill` before the output folders are removed.
 */
export function watchChildGroup(child: { pid?: number; on(event: string, listener: () => void): void }): void {
  const pid = child.pid;
  if (!pid) return;
  trackChildGroup(pid);
  const drop = (): void => { untrackChildGroup(pid); };
  child.on('exit', drop);
  child.on('error', drop);
}

/** Restore unverified edits, kill every tracked Playwright process group, and remove tracked output folders. */
export function cleanupChildrenAndOutputs(): void {
  restoreUnverifiedApplies();
  for (const pid of childGroups) killProcessTree(pid);
  childGroups.clear();
  tempWatches.clear();
  for (const dir of outputDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  outputDirs.clear();
  removeEmptyCreatedQaCore();
}

function signalExitCode(sig: NodeJS.Signals): number {
  if (sig === 'SIGINT') return 130;
  if (sig === 'SIGHUP') return 129;
  return 143;
}

/** Install the SIGINT, SIGTERM, and SIGHUP traps once. A normal exit also drops leftovers. */
export function installSignalCleanup(): void {
  if (!exitInstalled) {
    exitInstalled = true;
    process.on('exit', () => { cleanupChildrenAndOutputs(); });
  }
  if (installed) return;
  installed = true;
  const onSignal = (sig: NodeJS.Signals): void => {
    cleanupChildrenAndOutputs();
    process.exit(signalExitCode(sig));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
}
