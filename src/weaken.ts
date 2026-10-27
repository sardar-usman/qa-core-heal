/**
 * The weakening guard.
 *
 * A proposal is refused when its diff removes an assertion or replaces one
 * with a looser check. A locator-only rewrite is not a weakening: the
 * subject of expect() is ignored, and the matcher and its arguments must
 * stay as strict as they were. An expect hidden in a comment or a string,
 * a removed expect.soft or expect.poll, and an added test.skip count too.
 */

interface ExpectAssertion {
  neg: boolean;
  matcher: string;
  args: string;
  /** '' for expect(), '.soft' or '.poll' for the other forms. */
  form: '' | '.soft' | '.poll';
}

/** Move past a comment or a string. Returns i when src[i] is real code. */
function skipNoise(src: string, i: number): number {
  if (src.startsWith('//', i)) {
    const nl = src.indexOf('\n', i + 2);
    return nl < 0 ? src.length : nl + 1;
  }
  if (src.startsWith('/*', i)) {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === c) return j + 1;
      j++;
    }
    return j;
  }
  return i;
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

function atWord(src: string, i: number, word: string): boolean {
  if (!src.startsWith(word, i)) return false;
  if (i > 0 && /[A-Za-z0-9_]/.test(src[i - 1]!)) return false;
  const after = src[i + word.length];
  return after === undefined || !/[A-Za-z0-9_]/.test(after);
}

function parseExpects(src: string): ExpectAssertion[] {
  const out: ExpectAssertion[] = [];
  let i = 0;
  while (i < src.length) {
    const skipped = skipNoise(src, i);
    if (skipped > i) { i = skipped; continue; }
    if (!atWord(src, i, 'expect')) { i++; continue; }
    const head = src.slice(i);
    const mm = head.match(/^expect(?:\s*\.\s*(soft|poll))?\s*\(/);
    if (!mm) { i++; continue; }
    const form: ExpectAssertion['form'] = mm[1] === 'poll' ? '.poll' : mm[1] === 'soft' ? '.soft' : '';
    const open = i + mm[0].length - 1;
    const subjectEnd = skipBalanced(src, open);
    if (subjectEnd < 0) { i++; continue; }
    let j = skipWs(src, subjectEnd + 1);
    let neg = false;
    if (src.startsWith('.not', j) && !/[A-Za-z0-9_]/.test(src[j + 4] ?? '')) {
      neg = true;
      j = skipWs(src, j + 4);
    }
    const call = src.slice(j);
    const matcher = call.match(/^\.\s*(to[A-Za-z]+)\s*\(/);
    if (!matcher) { i = subjectEnd + 1; continue; }
    const argOpen = j + matcher[0].length - 1;
    const argEnd = skipBalanced(src, argOpen);
    if (argEnd < 0) { i = subjectEnd + 1; continue; }
    out.push({ neg, matcher: matcher[1]!, form, args: src.slice(argOpen + 1, argEnd) });
    i = argEnd + 1;
  }
  return out;
}

function assertSigs(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const skipped = skipNoise(src, i);
    if (skipped > i) { i = skipped; continue; }
    if (!atWord(src, i, 'assert')) { i++; continue; }
    const head = src.slice(i);
    const mm = head.match(/^assert(?:\.[A-Za-z]+)?\s*\(/);
    if (!mm) { i++; continue; }
    const open = i + mm[0].length - 1;
    const end = skipBalanced(src, open);
    if (end < 0) { i++; continue; }
    out.push(norm(src.slice(i, end + 1)));
    i = end + 1;
  }
  return out;
}

function same(a: ExpectAssertion, b: ExpectAssertion): boolean {
  return a.neg === b.neg && a.matcher === b.matcher && norm(a.args) === norm(b.args);
}

function fmt(a: ExpectAssertion): string {
  const not = a.neg ? '.not' : '';
  const args = a.args.trim();
  return `expect${a.form}(...)${not}.${a.matcher}(${args})`;
}

function skipCount(src: string): number {
  let n = 0;
  let i = 0;
  while (i < src.length) {
    const skipped = skipNoise(src, i);
    if (skipped > i) { i = skipped; continue; }
    const head = src.slice(i);
    const mm = head.match(/^test(?:\s*\.\s*describe)?\s*\.\s*skip\b/);
    if (mm && (i === 0 || !/[A-Za-z0-9_]/.test(src[i - 1]!))) {
      n++;
      i += mm[0].length;
      continue;
    }
    i++;
  }
  return n;
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
  if (skipCount(after) > skipCount(before)) return 'The proposed change skips a test.';
  return null;
}
