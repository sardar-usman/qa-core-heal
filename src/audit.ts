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
  /** Why the edit was undone: the re-run still failed, or a signal stopped the verify run. */
  revertReason?: 'locator' | 'non-locator' | 'interrupted';
  /** Set when a signal arrived but the spec was no longer the bytes heal wrote. */
  warning?: string;
}

/** Append one JSON line per applied heal. Creates the log directory if needed. */
export function appendAuditLog(logPath: string, entries: AuditEntry[]): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
