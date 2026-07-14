import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Run-first healing support: parse a Playwright JSON report, decide per
 * failure whether healing can even help (locator identity failures only),
 * extract the failing selector, and recover the page URL at failure time
 * from the test's trace. Everything here is deterministic and offline —
 * the CLI orchestrates, this module only interprets artifacts.
 */

/* ─────────────────────── failure classification ─────────────────────── */

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export type FailureClass =
  | { kind: 'locator'; selector: string | null }
  | { kind: 'other'; summary: string };

/** First non-empty line of a message, for compact reporting. */
function firstLine(msg: string): string {
  return msg.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

/**
 * Classification is EVIDENCE-based, never message-shape-based. Locator
 * failure = anything carrying locator evidence: a strict mode violation, an
 * explicit element(s)-not-found, a `locator.<action>:` / `expect.<matcher>:`
 * prefix, or a call-log "waiting for locator/getBy..." line — regardless of
 * the top-level message (a test timeout, a "Target page, context or browser
 * has been closed" after teardown, anything). The one earlier gate: when the
 * locator RESOLVED to a real element, the failure is about the element's
 * state, not its identity — that stays non-locator even with a call log.
 *
 * Non-locator: found-element assertion mismatches, navigation/network
 * errors, thrown app errors, and timeouts with no pending locator action.
 */
export function classifyFailure(rawMessage: string): FailureClass {
  const msg = stripAnsi(rawMessage);
  if (/strict mode violation/.test(msg)) {
    return { kind: 'locator', selector: extractSelector(msg) };
  }
  if (/element\(s\) not found/.test(msg)) {
    return { kind: 'locator', selector: extractSelector(msg) };
  }
  // The locator resolved to a real element: whatever failed, it was not
  // the locator's identity.
  if (/locator resolved to/.test(msg)) {
    return { kind: 'other', summary: firstLine(msg) };
  }
  if (/(?:^|[\s:])(?:locator|expect)\.\w+:/.test(msg) || /waiting for (locator|getBy)/.test(msg)) {
    return { kind: 'locator', selector: extractSelector(msg) };
  }
  if (/page\.goto|net::|Navigation failed|NS_ERROR|Protocol error/.test(msg)) {
    return { kind: 'other', summary: firstLine(msg) };
  }
  if (/Test timeout of \d+m?s exceeded/.test(msg)) {
    return { kind: 'other', summary: 'timed out with no pending locator action' };
  }
  return { kind: 'other', summary: firstLine(msg) };
}

/** Read past a quoted string inside a selector expression. */
function skipString(s: string, i: number): number {
  const quote = s[i]!;
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === quote) return j + 1;
    j++;
  }
  return s.length;
}

/**
 * The selector call text out of an error message: the first
 * locator(...)/getByX(...) after a known marker, parens balanced so
 * options objects survive ("getByRole('textbox', { name: 'X' })").
 */
export function extractSelector(msg: string): string | null {
  const m = msg.match(/(?:strict mode violation:|waiting for|Locator:)\s+((?:locator|getBy[A-Za-z]+)\()/);
  if (!m || m.index == null) return null;
  const start = msg.indexOf(m[1]!, m.index);
  const open = start + m[1]!.length - 1;
  let depth = 0;
  for (let j = open; j < msg.length; j++) {
    const c = msg[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(msg, j) - 1; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return msg.slice(start, j + 1);
    }
  }
  return null;
}

/* ─────────────────────────── consent ─────────────────────────── */

/** y/Y/yes apply; n/no/empty decline; anything else re-prompts. */
export function parseConsent(answer: string): 'yes' | 'no' | 'retry' {
  const a = answer.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return 'yes';
  if (a === 'n' || a === 'no' || a === '') return 'no';
  return 'retry';
}

/* ────────────────────────── trace reading ────────────────────────── */

/** Minimal zip reader: name -> content for stored/deflated entries. */
function readZip(zipPath: string): Map<string, Buffer> {
  const buf = fs.readFileSync(zipPath);
  const out = new Map<string, Buffer>();
  // End-of-central-directory: scan backwards for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let e = 0; e < count; e++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Local header: its own name/extra lengths may differ from the central ones.
    if (buf.readUInt32LE(localOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compressedSize);
      try {
        out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
      } catch { /* skip undecodable entry */ }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * The page URL at failure time: the last MAIN-frame snapshot URL recorded
 * in the test's trace (the trace ends where the test failed). Child iframe
 * snapshots — a feedback widget, an ad frame — are never the page, and can
 * easily be the LAST snapshot recorded, so isMainFrame is checked
 * explicitly (a missing flag, from older trace formats, counts as main).
 * Non-http URLs (about:blank, chrome-error://...) are skipped. Null when
 * the trace is missing, unreadable, or has no usable main-frame snapshot.
 */
export function traceFailureUrl(zipPath: string): string | null {
  let entries: Map<string, Buffer>;
  try {
    entries = readZip(zipPath);
  } catch {
    return null;
  }
  let url: string | null = null;
  const names = [...entries.keys()].filter((n) => n.endsWith('.trace')).sort();
  for (const name of names) {
    for (const line of entries.get(name)!.toString('utf8').split('\n')) {
      if (!line.includes('"frame-snapshot"')) continue;
      try {
        const o = JSON.parse(line) as {
          type?: string;
          snapshot?: { frameUrl?: string; isMainFrame?: boolean };
        };
        if (o.type !== 'frame-snapshot') continue;
        if (o.snapshot?.isMainFrame === false) continue;
        const u = o.snapshot?.frameUrl;
        if (typeof u === 'string' && /^https?:\/\//.test(u)) url = u;
      } catch { /* not a JSON line */ }
    }
  }
  return url;
}

/* ─────────────────────── report walking ─────────────────────── */

/**
 * Extract the JSON report object from a Playwright stdout that may carry
 * arbitrary prefix noise — configs print while loading (dotenv's tip line
 * even contains a "{", so a naive indexOf slice lands mid-noise). Tries
 * each "{" position until one parses as an object with the report shape.
 */
export function parseJsonReport(stdout: string): { suites?: unknown[] } | null {
  let idx = stdout.indexOf('{');
  for (let attempts = 0; idx >= 0 && attempts < 100; attempts++) {
    try {
      const parsed = JSON.parse(stdout.slice(idx)) as { suites?: unknown[]; config?: unknown };
      if (parsed && typeof parsed === 'object' && ('suites' in parsed || 'config' in parsed)) {
        return parsed;
      }
    } catch { /* not this brace */ }
    idx = stdout.indexOf('{', idx + 1);
  }
  return null;
}

export interface TestOutcome {
  /** Spec file path relative to the Playwright rootDir. */
  file: string;
  title: string;
  ok: boolean;
  /** Stripped error message of the last result; '' when passing. */
  message: string;
  /** Path to the trace.zip attachment, when present. */
  tracePath: string | null;
  /**
   * Source locations of the failure, most specific first: the error's own
   * location, then app frames from the stack (node internals and
   * node_modules excluded). The primary signal for matching the failing
   * selector back to a locator call in the source.
   */
  locations: Array<{ file: string; line: number }>;
}

interface ReportError {
  message?: string;
  stack?: string;
  location?: { file?: string; line?: number };
}

interface ReportSpec {
  title: string; ok: boolean; file: string;
  tests?: Array<{ results?: Array<{
    status?: string;
    error?: ReportError;
    errors?: ReportError[];
    attachments?: Array<{ name?: string; path?: string }>;
  }> }>;
}

interface ReportSuite { specs?: ReportSpec[]; suites?: ReportSuite[] }

/** Flatten every spec in a Playwright JSON report into TestOutcomes. */
export function collectTests(report: { suites?: ReportSuite[] }): TestOutcome[] {
  const out: TestOutcome[] = [];
  const walk = (s: ReportSuite): void => {
    for (const spec of s.specs ?? []) {
      const result = spec.tests?.[0]?.results?.[spec.tests[0].results.length - 1];
      // ALL errors of the result, deduped: on a test timeout the top-level
      // error is just "Test timeout ... exceeded" and the pending locator
      // action (the real evidence) arrives as a secondary error.
      const errs: ReportError[] = [];
      const seenMessages = new Set<string>();
      for (const e of [result?.error, ...(result?.errors ?? [])]) {
        const m = stripAnsi(e?.message ?? '');
        if (!e || !m || seenMessages.has(m)) continue;
        seenMessages.add(m);
        errs.push(e);
      }
      const trace = result?.attachments?.find((a) => a.name === 'trace' && a.path);
      const locations: Array<{ file: string; line: number }> = [];
      const pushLoc = (file: string | undefined, line: number | undefined): void => {
        if (!file || !line) return;
        if (file.includes('node_modules') || file.startsWith('node:')) return;
        if (locations.length >= 6) return;
        if (!locations.some((l) => l.file === file && l.line === line)) locations.push({ file, line });
      };
      for (const err of errs) {
        pushLoc(err.location?.file, err.location?.line);
        for (const sm of stripAnsi(err.stack ?? '').matchAll(/\sat\s+(?:.*?\()?([^():\n]+):(\d+):\d+\)?/g)) {
          pushLoc(sm[1], Number(sm[2]));
        }
      }
      out.push({
        file: spec.file,
        title: spec.title,
        ok: !!spec.ok,
        message: [...seenMessages].join('\n'),
        tracePath: trace?.path ?? null,
        locations,
      });
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const s of report.suites ?? []) walk(s);
  return out;
}
