/**
 * The weakening guard.
 *
 * A proposal is refused when its diff removes an assertion or replaces one
 * with a looser check. A locator-only rewrite is not a weakening: the
 * subject of expect() is ignored, and the matcher and its arguments must
 * stay as strict as they were.
 */

interface ExpectAssertion {
  neg: boolean;
  matcher: string;
  args: string;
}

const RANK: Record<string, number> = {
  toBe: 5, toEqual: 5, toStrictEqual: 5,
  toHaveText: 5, toHaveValue: 5, toHaveAttribute: 5, toHaveClass: 5,
  toHaveCount: 5, toBeVisible: 5, toBeHidden: 5, toBeAttached: 5,
  toBeEnabled: 5, toBeDisabled: 5, toBeNull: 4, toBeUndefined: 4,
  toContainText: 3, toContain: 3, toMatch: 3,
  toBeTruthy: 1, toBeDefined: 1, toBeFalsy: 1, toPass: 2,
};

function rankOf(matcher: string): number {
  return RANK[matcher] ?? 4;
}

function skipWs(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i]!)) i++;
  return i;
}

/** Index of the ')' that closes the '(' at openAt, or -1. Strings are skipped. */
function skipBalanced(src: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) break;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function norm(args: string): string {
  return args.replace(/\s+/g, '').replace(/"/g, "'");
}

function hasExactTrue(args: string): boolean {
  return /exact\s*:\s*true/.test(args);
}

function timeoutOf(args: string): number | null {
  const m = args.match(/timeout\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function leadingNumber(args: string): number | null {
  const m = norm(args).match(/^(-?\d+)/);
  return m ? Number(m[1]) : null;
}

function quotedStrings(args: string): string[] {
  const out: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) out.push(m[2]!.replace(/\\(.)/g, '$1'));
  return out;
}

function parseExpects(src: string): ExpectAssertion[] {
  const out: ExpectAssertion[] = [];
  const re = /\bexpect\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const subjectEnd = skipBalanced(src, open);
    if (subjectEnd < 0) continue;
    let i = skipWs(src, subjectEnd + 1);
    let neg = false;
    if (src.startsWith('.not', i) && !/[A-Za-z0-9_]/.test(src[i + 4] ?? '')) {
      neg = true;
      i = skipWs(src, i + 4);
    }
    const head = src.slice(i);
    const mm = head.match(/^\.\s*(to[A-Za-z]+)\s*\(/);
    if (!mm) { re.lastIndex = subjectEnd + 1; continue; }
    const matcher = mm[1]!;
    const argOpen = i + mm[0].length - 1;
    const argEnd = skipBalanced(src, argOpen);
    if (argEnd < 0) { re.lastIndex = subjectEnd + 1; continue; }
    out.push({ neg, matcher, args: src.slice(argOpen + 1, argEnd) });
    re.lastIndex = argEnd + 1;
  }
  return out;
}

function assertSigs(src: string): string[] {
  const out: string[] = [];
  const re = /\bassert(?:\.[A-Za-z]+)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const end = skipBalanced(src, open);
    if (end < 0) continue;
    out.push(norm(src.slice(m.index, end + 1)));
    re.lastIndex = end + 1;
  }
  return out;
}

function same(a: ExpectAssertion, b: ExpectAssertion): boolean {
  return a.neg === b.neg && a.matcher === b.matcher && norm(a.args) === norm(b.args);
}

function fmt(a: ExpectAssertion): string {
  const not = a.neg ? '.not' : '';
  const args = a.args.trim();
  return `expect(...)${not}.${a.matcher}(${args})`;
}

/** True when `after` checks less than `before` did. */
function isLooser(before: ExpectAssertion, after: ExpectAssertion): boolean {
  if (before.neg && !after.neg && before.matcher === after.matcher) return true;
  if (rankOf(after.matcher) < rankOf(before.matcher)) return true;
  if (before.matcher !== after.matcher) return false;
  if (hasExactTrue(before.args) && !hasExactTrue(after.args)) return true;
  const tb = timeoutOf(before.args);
  const ta = timeoutOf(after.args);
  if (ta !== null && (tb === null || ta > tb)) {
    const strip = (s: string): string => norm(s).replace(/,?'?timeout'?:\d+/g, '').replace(/\{,/, '{').replace(/,\}/, '}');
    if (strip(before.args) === strip(after.args)) return true;
  }
  const nb = leadingNumber(before.args);
  const na = leadingNumber(after.args);
  if (nb !== null && na !== null && nb !== na && norm(before.args).replace(/^-?\d+/, '') === norm(after.args).replace(/^-?\d+/, '')) {
    return true;
  }
  const sb = quotedStrings(before.args);
  const sa = quotedStrings(after.args);
  if (sb.length === 1 && sa.length === 1 && sb[0] !== sa[0] && sb[0]!.includes(sa[0]!) && sa[0]!.length < sb[0]!.length) return true;
  if (sb.length > 0 && /\/[^/\n]+\//.test(after.args) && !/\/[^/\n]+\//.test(before.args)) return true;
  return false;
}

/**
 * A short reason when `after` removes or loosens an assertion from `before`.
 * Null when every assertion is still there at the same strength.
 */
export function weakeningReason(before: string, after: string): string | null {
  const b = parseExpects(before);
  const a = parseExpects(after);
  const used = new Array<boolean>(a.length).fill(false);
  for (const exp of b) {
    const idx = a.findIndex((x, i) => !used[i] && same(exp, x));
    if (idx >= 0) { used[idx] = true; continue; }
    const loose = a.findIndex((x, i) => !used[i] && isLooser(exp, x));
    if (loose >= 0) {
      used[loose] = true;
      return `The proposed change loosens an assertion: ${fmt(exp)} becomes ${fmt(a[loose]!)}.`;
    }
    return `The proposed change removes an assertion: ${fmt(exp)}.`;
  }
  const beforeAssert = assertSigs(before);
  const afterAssert = assertSigs(after);
  const left = [...afterAssert];
  for (const sig of beforeAssert) {
    const at = left.indexOf(sig);
    if (at >= 0) { left.splice(at, 1); continue; }
    return 'The proposed change removes an assertion.';
  }
  return null;
}
