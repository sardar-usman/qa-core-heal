import fs from 'node:fs';
import path from 'node:path';
/** Append one JSON line per applied heal. Creates the log directory if needed. */
export function appendAuditLog(logPath, entries) {
    if (entries.length === 0)
        return;
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
