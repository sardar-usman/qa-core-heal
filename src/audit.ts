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
  verified: boolean;
}

/** Append one JSON line per applied heal. Creates the log directory if needed. */
export function appendAuditLog(logPath: string, entries: AuditEntry[]): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
