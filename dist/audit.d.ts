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
export declare function appendAuditLog(logPath: string, entries: AuditEntry[]): void;
