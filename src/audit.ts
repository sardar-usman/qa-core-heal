import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  timestamp: string;
  file: string;
  line: number;
  old: string;
  new: string;
  level: string;
  ambiguous: boolean;
  /** The heal was written to disk (always true for logged entries — a
   *  later revert does not erase the fact that it was applied). */
  applied: boolean;
  verified: boolean;
  /** True when the verify re-run still failed and the edit was undone. */
  reverted: boolean;
  /** Why the reverting re-run failed: still a locator problem, or not. */
  revertReason?: 'locator' | 'non-locator';
}

/** Append one JSON line per applied heal. Creates the log directory if needed. */
export function appendAuditLog(logPath: string, entries: AuditEntry[]): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
