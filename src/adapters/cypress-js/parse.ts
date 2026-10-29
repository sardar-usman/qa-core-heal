/**
 * Literal Cypress queries heal can edit.
 * `cy.get`, `cy.contains`, and `cy.getByRole` with literal arguments.
 * Custom commands, variables, template expressions, shadow, iframes,
 * `.within()`, and chained `.find()` are refused.
 */

export type CypressQuote = "'" | '"' | '`';

export interface CypressCall {
  file: string;
  line: number;
  startCol: number;
  endLine: number;
  endCol: number;
  raw: string;
  kind: 'get' | 'contains' | 'getByRole';
  quote: CypressQuote;
  css?: string;
  text?: string;
  selector?: string;
  regexSource?: string;
  role?: string;
  name?: string;
  unsafe?: string;
}

const JQUERY_ONLY = /:(?:contains|eq|first|last|visible|hidden|checkbox|parent|header|selected|animated|button|input|submit|text|password|radio|file|image|reset|even|odd|gt|lt|has|not|empty|focus|disabled|enabled|checked)\b/;

/**
 * Commands Cypress ships. Anything else after `cy.` is a custom command.
 * https://docs.cypress.io/api/table-of-contents
 */
const BUILTIN_COMMANDS = new Set([
  'get', 'contains', 'getByRole', 'within', 'origin', 'find', 'shadow',
  'visit', 'request', 'intercept', 'wait', 'window', 'document', 'title', 'url',
  'go', 'reload', 'viewport', 'screenshot', 'log', 'debug', 'pause', 'wrap',
  'then', 'each', 'root', 'focused', 'spy', 'stub', 'clock', 'tick', 'session',
  'readFile', 'writeFile', 'exec', 'task', 'fixture', 'as', 'its', 'invoke',
  'should', 'and', 'spread', 'location', 'hash', 'getCookie', 'getCookies',
  'setCookie', 'clearCookie', 'clearCookies', 'clearLocalStorage', 'origin',
  'scrollTo', 'scrollIntoView', 'click', 'dblclick', 'rightclick', 'type',
  'clear', 'check', 'uncheck', 'select', 'selectFile', 'trigger', 'focus',
  'blur', 'submit', 'children', 'closest', 'eq', 'filter', 'first', 'last',
  'next', 'nextAll', 'nextUntil', 'not', 'parent', 'parents', 'parentsUntil',
  'prev', 'prevAll', 'prevUntil', 'siblings',
]);

export function parseCypressCalls(source: string, file: string): CypressCall[] {
  const calls: CypressCall[] = [];
  const lineStarts = lineStartTable(source);
  const withinSpans = withinRanges(source);
  const re = /\bcy\s*\.\s*([A-Za-z_][\w]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1]!;
    const open = match.index + match[0].length - 1;
    const close = matchParen(source, open);
    if (close < 0) continue;
    const start = posOf(lineStarts, match.index);
    const end = posOf(lineStarts, close + 1);
    const raw = source.slice(match.index, close + 1).replace(/\s*\n\s*/g, ' ');
    const args = source.slice(open + 1, close);
    const insideWithin = withinSpans.some((span) => match!.index > span.open && match!.index < span.close);
    if (!BUILTIN_COMMANDS.has(name)) {
      calls.push(base(file, start, end, raw, 'get', "'", `Custom command cy.${name}() is not supported.`));
      re.lastIndex = close + 1;
      continue;
    }
    if (name === 'origin' || name === 'within') {
      calls.push(base(file, start, end, raw, 'get', "'", unsafeReason(name)));
      re.lastIndex = close + 1;
      continue;
    }
    if (name !== 'get' && name !== 'contains' && name !== 'getByRole') {
      re.lastIndex = close + 1;
      continue;
    }
    const lineEnd = source.indexOf('\n', close + 1);
    const trailing = source.slice(close + 1, lineEnd < 0 ? source.length : lineEnd);
    const call = readCall(name, args, file, start, end, raw, trailing);
    if (insideWithin || /\.within\s*\(/.test(trailing)) {
      call.unsafe = 'cy.within() is not supported.';
    }
    calls.push(call);
    re.lastIndex = close + 1;
  }
  return calls;
}

function withinRanges(source: string): Array<{ open: number; close: number }> {
  const spans: Array<{ open: number; close: number }> = [];
  const re = /\.within\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(source, open);
    if (close > open) spans.push({ open, close });
    re.lastIndex = open + 1;
  }
  return spans;
}

function unsafeReason(name: string): string {
  if (name === 'origin') return 'cy.origin() is not supported.';
  if (name === 'within') return 'cy.within() is not supported.';
  return 'Custom commands such as cy.getBySel() are not supported.';
}

function readCall(
  name: string,
  args: string,
  file: string,
  start: { line: number; col: number },
  end: { line: number; col: number },
  raw: string,
  trailing: string,
): CypressCall {
  if (/\.shadow\s*\(/.test(trailing) || /\.shadow\s*\(/.test(raw)) {
    return base(file, start, end, raw, 'get', "'", '.shadow() is not supported.');
  }
  if (/\.find\s*\(/.test(trailing)) {
    return base(file, start, end, raw, 'get', "'", 'A chained .find() is not supported.');
  }
  if (/iframe/i.test(args)) {
    return base(file, start, end, raw, 'get', "'", 'iframe locators are not supported.');
  }
  if (name === 'get') {
    const lit = readLiteral(args.trim());
    if (!lit) return base(file, start, end, raw, 'get', "'", 'Only a string literal can be healed.');
    if (lit.expr) return base(file, start, end, raw, 'get', lit.quote, 'A template literal with an expression cannot be healed.');
    if (JQUERY_ONLY.test(lit.value)) return base(file, start, end, raw, 'get', lit.quote, 'A jQuery-only selector cannot be healed.');
    return { ...base(file, start, end, raw, 'get', lit.quote), css: lit.value };
  }
  if (name === 'getByRole') {
    const parts = splitArgs(args);
    const role = parts[0] ? readLiteral(parts[0].trim()) : null;
    if (!role || role.expr) return base(file, start, end, raw, 'getByRole', "'", 'Only a string literal role can be healed.');
    const nameLit = namedLiteral(parts.slice(1).join(','), 'name');
    if (parts.length > 1 && !nameLit) return base(file, start, end, raw, 'getByRole', role.quote, 'getByRole options must use a literal name.');
    return { ...base(file, start, end, raw, 'getByRole', role.quote), role: role.value, name: nameLit?.value };
  }
  const parts = splitArgs(args);
  if (parts.length === 1) {
    const text = readLiteral(parts[0]!.trim());
    if (!text || text.expr) return base(file, start, end, raw, 'contains', "'", 'Only a string literal can be healed.');
    return { ...base(file, start, end, raw, 'contains', text.quote), text: text.value };
  }
  const selector = readLiteral(parts[0]!.trim());
  const second = parts.slice(1).join(',').trim();
  const regex = /^\/([\s\S]*)\/[a-z]*$/.exec(second);
  if (!selector || selector.expr) return base(file, start, end, raw, 'contains', "'", 'Only literal contains arguments can be healed.');
  if (regex) return { ...base(file, start, end, raw, 'contains', selector.quote), selector: selector.value, regexSource: regex[1] };
  const text = readLiteral(second);
  if (!text || text.expr) return base(file, start, end, raw, 'contains', selector.quote, 'Only a string or regex content argument can be healed.');
  return { ...base(file, start, end, raw, 'contains', selector.quote), selector: selector.value, text: text.value };
}

function base(
  file: string,
  start: { line: number; col: number },
  end: { line: number; col: number },
  raw: string,
  kind: CypressCall['kind'],
  quote: CypressQuote,
  unsafe?: string,
): CypressCall {
  return {
    file,
    line: start.line,
    startCol: start.col,
    endLine: end.line,
    endCol: end.col,
    raw,
    kind,
    quote,
    ...(unsafe ? { unsafe } : {}),
  };
}

function readLiteral(text: string): { value: string; quote: CypressQuote; expr: boolean } | null {
  const match = /^(['"`])([\s\S]*)\1$/.exec(text.trim());
  if (!match) return null;
  const quote = match[1] as CypressQuote;
  const body = match[2]!;
  if (quote === '`' && /\$\{/.test(body)) return { value: body, quote, expr: true };
  return { value: unescape(body, quote), quote, expr: false };
}

function unescape(value: string, quote: CypressQuote): string {
  return value.replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch === quote || ch === '\\' ? ch : ch));
}

function namedLiteral(text: string, key: string): { value: string } | null {
  const match = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`).exec(text);
  if (!match) return null;
  if (match[1] === '`' && /\$\{/.test(match[2]!)) return null;
  return { value: match[2]! };
}

function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out;
}

function matchParen(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineStartTable(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function posOf(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - starts[lo]! };
}

export function configHasShadow(source: string): boolean {
  return /includeShadowDom\s*:\s*true/.test(source);
}

export function supportFileDisabled(source: string): boolean {
  return /supportFile\s*:\s*false/.test(source);
}
