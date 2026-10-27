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
 * child tree, and removes the folders it still owns. A normal process.exit
 * (the run-timeout failure path) runs the same cleanup.
 */

interface ProcIds { ppid: number; pgrp: number }

function readProc(pid: number): ProcIds | null {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    const pgrp = Number(rest[2]);
    if (!Number.isInteger(ppid) || !Number.isInteger(pgrp)) return null;
    return { ppid, pgrp };
  } catch {
    return null;
  }
}

/**
 * Stop a child and every process group under it.
 * The direct child is a group leader. Browsers it spawned are leaders of
 * their own groups, so killing only the child group leaves them behind.
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (process.platform === 'win32' || !fs.existsSync('/proc')) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    return;
  }
  const selfGroup = readProc(process.pid)?.pgrp;
  const byParent = new Map<number, number[]>();
  const pgrpOf = new Map<number, number>();
  let names: string[] = [];
  try { names = fs.readdirSync('/proc'); } catch { names = []; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const p = Number(name);
    const st = readProc(p);
    if (!st) continue;
    pgrpOf.set(p, st.pgrp);
    const kids = byParent.get(st.ppid);
    if (kids) kids.push(p);
    else byParent.set(st.ppid, [p]);
  }
  const groups = new Set<number>();
  const direct: number[] = [];
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur) || cur === process.pid) continue;
    seen.add(cur);
    const g = pgrpOf.get(cur) ?? (cur === pid ? pid : 0);
    if (g > 1 && g !== selfGroup) groups.add(g);
    else direct.push(cur);
    for (const kid of byParent.get(cur) ?? []) stack.push(kid);
  }
  if (pid > 1 && pid !== selfGroup) groups.add(pid);
  for (const g of groups) {
    try { process.kill(-g, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const p of direct) {
    try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
  }
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
