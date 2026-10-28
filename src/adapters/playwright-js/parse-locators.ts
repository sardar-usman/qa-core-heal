import type { CascadeLevel } from '../../selectors.js';

/**
 * Playwright JS locator literals: page / this.page, frameLocator, getBy*, locator.
 * The function bodies are the scan that used to live in the healer.
 */

/* ─────────────────────────── parsing ─────────────────────────── */

const LOCATOR_METHODS = [
  'getByRole', 'getByLabel', 'getByPlaceholder', 'getByText',
  'getByAltText', 'getByTitle', 'getByTestId', 'locator',
] as const;
export type LocatorMethod = (typeof LOCATOR_METHODS)[number];

export interface LocatorArgs {
  role?: string; name?: string; exact?: boolean;
  label?: string; placeholder?: string; text?: string;
  alt?: string; title?: string; testid?: string;
  css?: string; xpath?: string;
  /** The { hasText: "..." } filter on a locator() call, when present. */
  hasText?: string;
  /**
   * Every getByRole option beyond name/exact, parsed to canonical values
   * (checked/disabled/expanded/includeHidden/pressed/selected as booleans,
   * level as a number). Part of the call's identity: checked:false means
   * an UNCHECKED checkbox, not an unset option.
   */
  roleOpts?: Record<string, boolean | number>;
}

export interface LocatorCall {
  file: string;
  line: number;      // 1-indexed line the call STARTS on
  startCol: number;  // 0-indexed within the start line
  /** Line the call's closing paren sits on: > line for a wrapped call. */
  endLine: number;
  endCol: number;    // exclusive, within endLine
  /** The `page...getByX(...)` text, newlines collapsed for display; no trailing .first()/.click(). */
  raw: string;
  root: string;      // 'page' or 'this.page'
  method: LocatorMethod;
  level: CascadeLevel;
  frameChain: string[];
  args: LocatorArgs;
  /** Rest of the END line after the call: the API chained on it (".fill(...)"). */
  trailing: string;
}

/** Read a JS string literal starting at s[i] (a quote). Returns its value and end index. */
function readString(s: string, i: number): { value: string; end: number } | null {
  const quote = s[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      const n = s[j + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : (n ?? '');
      j += 2;
      continue;
    }
    if (c === quote) return { value: out, end: j + 1 };
    out += c;
    j++;
  }
  return null;
}

/** Index of the ')' matching the '(' at `open`, skipping string literals. -1 if unbalanced. */
export function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') {
      const r = readString(s, j);
      if (!r) return -1;
      j = r.end - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** First string literal anywhere in a fragment. */
function firstString(s: string): string | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' || s[i] === "'" || s[i] === '`') {
      const r = readString(s, i);
      if (r) return r.value;
    }
  }
  return null;
}

/** Value of a `<key>: "..."` string option, with or without a quoted key (JSON emits `"name":`). */
function namedString(s: string, key: string): string | null {
  const m = s.match(new RegExp(`["']?\\b${key}\\b["']?\\s*:\\s*`));
  if (!m || m.index == null) return null;
  const at = m.index + m[0].length;
  const r = readString(s, at);
  return r ? r.value : null;
}

function levelOf(method: LocatorMethod, args: LocatorArgs): CascadeLevel {
  switch (method) {
    case 'getByRole': return 'role';
    case 'getByLabel': return 'label';
    case 'getByPlaceholder': return 'placeholder';
    case 'getByText': return 'text';
    case 'getByAltText': return 'alt';
    case 'getByTitle': return 'title';
    case 'getByTestId': return 'testid';
    case 'locator': return args.xpath ? 'xpath' : 'css';
  }
}

/** getByRole boolean options beyond exact; a fixed list keeps signatures canonical. */
export const ROLE_BOOL_OPTS = ['checked', 'disabled', 'expanded', 'includeHidden', 'pressed', 'selected'] as const;

export function parseArgs(method: LocatorMethod, argsRaw: string): LocatorArgs {
  const first = firstString(argsRaw);
  switch (method) {
    case 'getByRole': {
      // exact:false is Playwright's default, canonically equal to absent;
      // every OTHER boolean keeps its explicit value (checked:false is an
      // assertion about state, not an omission).
      const roleOpts: Record<string, boolean | number> = {};
      for (const k of ROLE_BOOL_OPTS) {
        const m = argsRaw.match(new RegExp(`["']?\\b${k}\\b["']?\\s*:\\s*(true|false)\\b`));
        if (m) roleOpts[k] = m[1] === 'true';
      }
      const lm = argsRaw.match(/["']?\blevel\b["']?\s*:\s*(\d+)/);
      if (lm) roleOpts.level = Number(lm[1]);
      return {
        role: first ?? '',
        name: namedString(argsRaw, 'name') ?? undefined,
        exact: /["']?\bexact\b["']?\s*:\s*true\b/.test(argsRaw),
        roleOpts: Object.keys(roleOpts).length > 0 ? roleOpts : undefined,
      };
    }
    case 'getByLabel': return { label: first ?? '' };
    case 'getByPlaceholder': return { placeholder: first ?? '' };
    case 'getByText': return { text: first ?? '' };
    case 'getByAltText': return { alt: first ?? '' };
    case 'getByTitle': return { title: first ?? '' };
    case 'getByTestId': return { testid: first ?? '' };
    case 'locator': {
      const s = first ?? '';
      const hasText = namedString(argsRaw, 'hasText') ?? undefined;
      if (s.startsWith('xpath=')) return { xpath: s.slice('xpath='.length), hasText };
      if (s.startsWith('//') || s.startsWith('./') || s.startsWith('(//')) return { xpath: s, hasText };
      return { css: s, hasText };
    }
  }
}

/**
 * Extract every locator chain in a file: page[.frameLocator(...)].getByX(...)
 * / .locator(...). Scans the WHOLE source, not lines: a prettier-wrapped
 * call whose options object spans several lines (the real-world shape for
 * any getByRole with a long name + exact:true) is one call, parsed whole.
 * Missing those made run mode report a failing locator that exists
 * verbatim in the POM as "could not be matched to source".
 */
export function parseLocatorCalls(src: string, file: string): LocatorCall[] {
  const calls: LocatorCall[] = [];
  // Line-start offsets, for offset -> (1-indexed line, 0-indexed col).
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') lineStarts.push(i + 1);
  }
  const posOf = (offset: number): { line: number; col: number } => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - lineStarts[lo]! };
  };
  const rootRe = /(?<![\w.$])(this\.page|page)\b/g;
  let rm: RegExpExecArray | null;
  while ((rm = rootRe.exec(src)) !== null) {
    const root = rm[1]!;
    let pos = rm.index + root.length;
    const frameChain: string[] = [];
    let matched: LocatorMethod | null = null;
    let open = -1;
    // Consume any .frameLocator("...") prefixes, then the terminal locator method.
    for (;;) {
      if (src.startsWith('.frameLocator(', pos)) {
        const fo = pos + '.frameLocator'.length;
        const fc = matchParen(src, fo);
        if (fc < 0) break;
        const inner = firstString(src.slice(fo + 1, fc));
        if (inner != null) frameChain.push(inner);
        pos = fc + 1;
        continue;
      }
      for (const m of LOCATOR_METHODS) {
        if (src.startsWith('.' + m + '(', pos)) { matched = m; open = pos + 1 + m.length; break; }
      }
      break;
    }
    if (!matched || open < 0) continue;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const argsRaw = src.slice(open + 1, close);
    const args = parseArgs(matched, argsRaw);
    const start = posOf(rm.index);
    const end = posOf(close + 1);
    const lineEnd = src.indexOf('\n', close + 1);
    calls.push({
      file,
      line: start.line, startCol: start.col,
      endLine: end.line, endCol: end.col,
      // Collapse the wrapping for display and matching; the edit
      // coordinates above, not this text, drive the write-back.
      raw: src.slice(rm.index, close + 1).replace(/\s*\n\s*/g, ' '),
      root, method: matched,
      level: levelOf(matched, args), frameChain, args,
      trailing: src.slice(close + 1, lineEnd < 0 ? src.length : lineEnd),
    });
    // Never re-scan inside the consumed call (a root token in a string
    // literal argument is not a new chain).
    rootRe.lastIndex = close + 1;
  }
  return calls;
}
