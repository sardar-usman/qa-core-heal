import fs from 'node:fs';
import { appendAuditLog, type AuditEntry } from './audit.js';

/**
 * Cleanup for a heal process that is stopped mid-run.
 *
 * Playwright children are started in their own process group. A SIGINT or
 * SIGTERM delivered to heal does not reach that group, and a killed process
 * does not run its finally blocks, so the temporary output folder would
 * stay behind. The CLI traps both signals, kills the group, and removes
 * the folders it still owns.
 */

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
  if (process.platform !== 'win32') {
    for (const pid of childGroups) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
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
