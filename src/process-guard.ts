import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { appendAuditLog, type AuditEntry } from './audit.js';

/**
 * Cleanup for a heal process that is stopped mid-run.
 *
 * Playwright children are started in their own process group, and the
 * browsers they launch lead yet another group. A SIGINT, SIGTERM, or
 * run timeout delivered to heal does not reach those groups, and a killed
 * process does not run its finally blocks, so the temporary output folder
 * would stay behind. The CLI traps both signals, kills every group in the
 * child tree, and removes the folders it still owns. Without /proc the
 * same tree is read from ps. A normal process.exit (the run-timeout
 * failure path) runs the same cleanup.
 */

export interface ProcessRow { pid: number; ppid: number; pgrp: number }

/**
 * How long to wait after SIGTERM before SIGKILL.
 * Chromium deletes its temporary profile on SIGTERM. SIGKILL skips that.
 */
const STOP_GRACE_MS = 500;

/** A test injects this to hide /proc. Null means that source has no table. */
let tableReader: (() => ProcessRow[] | null) | null = null;

export function setProcessTableReader(reader: (() => ProcessRow[] | null) | null): void {
  tableReader = reader;
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

/**
 * Stop a child and every process group under it.
 * The direct child is a group leader. Browsers it spawned are leaders of
 * their own groups, so killing only the child group leaves them behind.
 * SIGTERM goes out first so Chromium can delete its temp folders.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (process.platform === 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  const rows = loadProcessTable();
  if (!rows) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
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
  signalIds(groups, direct, 'SIGTERM');
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (watched.every((p) => !alive(p))) break;
    nap(50);
  }
  signalIds(groups, direct, 'SIGKILL');
}

const outputDirs = new Set<string>();
const childGroups = new Set<number>();
let installed = false;
let exitInstalled = false;

/** A file written by --apply whose verify re-run has not finished. */
interface UnverifiedApply {
  file: string;
  original: string;
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

/** Put each unverified file back and append an audit line that it was interrupted and reverted. */
function restoreUnverifiedApplies(): void {
  const pending = unverified.splice(0, unverified.length);
  for (const p of pending) {
    try { fs.writeFileSync(p.file, p.original); } catch { /* already gone */ }
    try { appendAuditLog(p.auditPath, p.entries); } catch { /* best effort */ }
  }
}

export function trackOutputDir(dir: string): void {
  outputDirs.add(dir);
}

export function untrackOutputDir(dir: string): void {
  outputDirs.delete(dir);
}

export function trackChildGroup(pid: number): void {
  childGroups.add(pid);
}

export function untrackChildGroup(pid: number): void {
  childGroups.delete(pid);
}

/** Restore unverified edits, kill every tracked Playwright process group, and remove tracked output folders. */
export function cleanupChildrenAndOutputs(): void {
  restoreUnverifiedApplies();
  for (const pid of childGroups) killProcessTree(pid);
  childGroups.clear();
  for (const dir of outputDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  outputDirs.clear();
}

/** Install the SIGINT and SIGTERM traps once. A normal exit also drops leftovers. */
export function installSignalCleanup(): void {
  if (!exitInstalled) {
    exitInstalled = true;
    process.on('exit', () => { cleanupChildrenAndOutputs(); });
  }
  if (installed) return;
  installed = true;
  const onSignal = (sig: NodeJS.Signals): void => {
    cleanupChildrenAndOutputs();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
