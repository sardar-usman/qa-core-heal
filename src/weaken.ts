import { activeAdapter } from './adapters/index.js';

/**
 * The weakening guard.
 *
 * A proposal is refused when its diff removes an assertion or replaces one
 * with a looser check. A locator-only rewrite is not a weakening: the
 * subject of expect() is ignored, and the matcher and its arguments must
 * stay as strict as they were. An expect hidden in a comment or a string,
 * a removed expect.soft or expect.poll, a swap from expect() to
 * expect.soft() or expect.poll(), and an added test.skip or test.fixme
 * count too. Regex literals and the text of a template literal are not
 * code. An expect inside a template ${} expression is code.
 */

interface ExpectAssertion {
  neg: boolean;
  matcher: string;
  args: string;
  /** '' for expect(), '.soft' or '.poll' for the other forms. */
  form: '' | '.soft' | '.poll';
}

const REGEX_BEFORE = new Set([
  'return', 'throw', 'case', 'typeof', 'void', 'delete', 'await', 'yield',
  'else', 'do', 'in', 'of', 'instanceof', 'new', 'extends',
]);

/** True when the '/' at slashAt begins a regex literal, not a division. */
function regexCanStart(src: string, slashAt: number): boolean {
  let j = slashAt - 1;
  while (j >= 0) {
    if (/\s/.test(src[j]!)) { j--; continue; }
    if (src[j] === '/' && src[j - 1] === '*') {
      const start = src.lastIndexOf('/*', j - 2);
      if (start < 0) return false;
      j = start - 1;
      continue;
    }
    break;
  }
  if (j < 0) return true;
  const c = src[j]!;
  if ('([{:;,=!?&|~^*%<>'.includes(c)) return true;
  if ((c === '+' || c === '-') && src[j - 1] === c) return false;
  if (c === '+' || c === '-') return true;
  if (c === ')' || c === ']' || c === '}' || c === '"' || c === "'" || c === '`') return false;
  if (/[0-9]/.test(c)) return false;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k]!)) k--;
    const word = src.slice(k + 1, j + 1);
    return REGEX_BEFORE.has(word);
  }
  return false;
}

/** Index after a regex that starts at i, or i when this '/' is not a regex. */
function endOfRegex(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\n') return i;
    if (c === '\\') { j += 2; continue; }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < src.length && /[dgimsuvy]/.test(src[j]!)) j++;
      return j;
    }
    j++;
  }
  return i;
}

function endOfQuoted(src: string, i: number): number {
  const q = src[i]!;
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === q) return j + 1;
    j++;
  }
  return j;
}

/**
 * Walks source so callers only see real code.
 * Comments, strings, and regex literals are hidden. The text of a template
 * literal is hidden, and a ${} expression inside it is real code.
 */
class Code {
  /** 'tpl' is template text. A number is the brace depth of a ${} expression. */
  private readonly stack: Array<'tpl' | number> = [];

  constructor(private readonly src: string, public i = 0) {}

  get done(): boolean { return this.i >= this.src.length; }

  get ch(): string { return this.src[this.i] ?? ''; }

  /** Advance past noise at i. Returns false when i is real code. */
  skipNoise(): boolean {
    if (this.done) return false;
    const src = this.src;
    const top = this.stack[this.stack.length - 1];
    if (top === 'tpl') {
      const before = this.i;
      if (src[this.i] === '\\') this.i += 2;
      else if (src[this.i] === '`') { this.stack.pop(); this.i++; }
      else if (src.startsWith('${', this.i)) { this.stack.push(0); this.i += 2; }
      else this.i++;
      if (this.i <= before) this.i = before + 1;
      return true;
    }
    const i = this.i;
    if (src.startsWith('//', i)) {
      const nl = src.indexOf('\n', i + 2);
      this.i = nl < 0 ? src.length : nl + 1;
      return true;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      this.i = end < 0 ? src.length : end + 2;
      return true;
    }
    const c = src[i]!;
    if (c === '"' || c === "'") { this.i = endOfQuoted(src, i); return true; }
    if (c === '`') { this.stack.push('tpl'); this.i++; return true; }
    if (c === '/' && regexCanStart(src, i)) {
      const end = endOfRegex(src, i);
      if (end > i) { this.i = end; return true; }
    }
    if (typeof top === 'number') {
      if (c === '{') { this.stack[this.stack.length - 1] = top + 1; this.i++; return true; }
      if (c === '}') {
        if (top === 0) this.stack.pop();
        else this.stack[this.stack.length - 1] = top - 1;
        this.i++;
        return true;
      }
    }
    return false;
  }
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

/** Index of the ')' that closes the '(' at openAt, or -1. Noise is skipped. */
function skipBalanced(src: string, openAt: number): number {
  const code = new Code(src, openAt);
  let depth = 0;
  while (!code.done) {
    if (code.skipNoise()) continue;
    const c = code.ch;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return code.i;
    }
    code.i++;
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
  const grammar = activeAdapter().assertionGrammar;
  const forms = grammar.forms.join('|');
  const callRe = new RegExp(`^${grammar.assertionCallee}(?:\\s*\\.\\s*(${forms}))?\\s*\\(`);
  const out: ExpectAssertion[] = [];
  const code = new Code(src);
  while (!code.done) {
    if (code.skipNoise()) continue;
    const i = code.i;
    if (!atWord(src, i, grammar.assertionCallee)) { code.i++; continue; }
    const head = src.slice(i);
    const mm = head.match(callRe);
    if (!mm) { code.i++; continue; }
    const form: ExpectAssertion['form'] = mm[1] === 'poll' ? '.poll' : mm[1] === 'soft' ? '.soft' : '';
    const open = i + mm[0].length - 1;
    const subjectEnd = skipBalanced(src, open);
    if (subjectEnd < 0) { code.i++; continue; }
    let j = skipWs(src, subjectEnd + 1);
    let neg = false;
    if (src.startsWith('.not', j) && !/[A-Za-z0-9_]/.test(src[j + 4] ?? '')) {
      neg = true;
      j = skipWs(src, j + 4);
    }
    const call = src.slice(j);
    const matcher = call.match(/^\.\s*(to[A-Za-z]+)\s*\(/);
    if (!matcher) { code.i = subjectEnd + 1; continue; }
    const argOpen = j + matcher[0].length - 1;
    const argEnd = skipBalanced(src, argOpen);
    if (argEnd < 0) { code.i = subjectEnd + 1; continue; }
    out.push({ neg, matcher: matcher[1]!, form, args: src.slice(argOpen + 1, argEnd) });
    code.i = argEnd + 1;
  }
  return out;
}

function assertSigs(src: string): string[] {
  const callee = activeAdapter().assertionGrammar.assertCallee;
  const callRe = new RegExp(`^${callee}(?:\\.[A-Za-z]+)?\\s*\\(`);
  const out: string[] = [];
  const code = new Code(src);
  while (!code.done) {
    if (code.skipNoise()) continue;
    const i = code.i;
    if (!atWord(src, i, callee)) { code.i++; continue; }
    const head = src.slice(i);
    const mm = head.match(callRe);
    if (!mm) { code.i++; continue; }
    const open = i + mm[0].length - 1;
    const end = skipBalanced(src, open);
    if (end < 0) { code.i++; continue; }
    out.push(norm(src.slice(i, end + 1)));
    code.i = end + 1;
  }
  return out;
}

function sameBody(a: ExpectAssertion, b: ExpectAssertion): boolean {
  return a.neg === b.neg && a.matcher === b.matcher && norm(a.args) === norm(b.args);
}

/**
 * True when `after` still has this assertion at the same strength or a
 * stricter form. Plain expect() is stricter than expect.soft or expect.poll.
 */
function covers(before: ExpectAssertion, after: ExpectAssertion): boolean {
  if (!sameBody(before, after)) return false;
  if (before.form === after.form) return true;
  return after.form === '' && before.form !== '';
}

function fmt(a: ExpectAssertion): string {
  const not = a.neg ? '.not' : '';
  const args = a.args.trim();
  return `expect${a.form}(...)${not}.${a.matcher}(${args})`;
}

function skipCount(src: string): number {
  const skipCall = activeAdapter().assertionGrammar.skipCall;
  let n = 0;
  const code = new Code(src);
  while (!code.done) {
    if (code.skipNoise()) continue;
    const i = code.i;
    const head = src.slice(i);
    const mm = head.match(skipCall);
    if (mm && (i === 0 || !/[A-Za-z0-9_]/.test(src[i - 1]!))) {
      n++;
      code.i = i + mm[0].length;
      continue;
    }
    code.i++;
  }
  return n;
}

/** True when `after` checks less than `before` did. */
function isLooser(before: ExpectAssertion, after: ExpectAssertion): boolean {
  if (sameBody(before, after) && before.form !== after.form) {
    if (!(after.form === '' && before.form !== '')) return true;
  }
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
    const idx = a.findIndex((x, i) => !used[i] && covers(exp, x));
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
