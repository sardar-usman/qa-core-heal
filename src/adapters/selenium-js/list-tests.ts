export interface MochaListedTest {
  title: string;
  line: number;
  endLine: number;
  skip: boolean;
  titlePath: string[];
}

/**
 * String-literal `it` / `test` titles, including ancestor `describe` / `context` / `suite` titles.
 * Mocha's full title is this path joined with a single space.
 * https://mochajs.org/#-grep-regexp-g-regexp
 */
export function listMochaTests(source: string): MochaListedTest[] {
  const tests: MochaListedTest[] = [];
  const suites: Array<{ title: string; skip: boolean; depth: number }> = [];
  let i = 0;
  let line = 1;
  let depth = 0;
  const ident = (ch: string | undefined): boolean => ch != null && /[A-Za-z0-9_$]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\n') { line += 1; i += 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '/' && regexCanStart(source, i)) {
      const skipped = skipRegex(source, i, line);
      if (skipped) { i = skipped.index; line = skipped.line; continue; }
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const skipped = skipString(source, i, line);
      i = skipped.index;
      line = skipped.line;
      continue;
    }
    if (ch === '{') { depth += 1; i += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      while (suites.length > 0 && suites[suites.length - 1]!.depth >= depth) suites.pop();
      i += 1;
      continue;
    }
    if (ident(ch) && !ident(source[i - 1])) {
      const startLine = line;
      const start = i;
      while (i < source.length && ident(source[i])) i += 1;
      const word = source.slice(start, i);
      if (word === 'describe' || word === 'context' || word === 'suite' || word === 'it' || word === 'test' || word === 'specify') {
        const call = readCall(source, i, line);
        if (call) {
          i = call.index;
          line = call.line;
          const skip = call.skip || suites.some((item) => item.skip);
          if (word === 'describe' || word === 'context' || word === 'suite') {
            suites.push({ title: call.title, skip, depth });
          } else {
            tests.push({
              title: call.title,
              line: startLine,
              endLine: source.split('\n').length + 1,
              skip,
              titlePath: [...suites.map((item) => item.title), call.title],
            });
          }
        }
      }
      continue;
    }
    i += 1;
  }
  for (let n = 0; n < tests.length; n++) tests[n]!.endLine = tests[n + 1]?.line ?? source.split('\n').length + 1;
  return tests;
}

function regexCanStart(source: string, slashIndex: number): boolean {
  let j = slashIndex - 1;
  while (j >= 0 && (source[j] === ' ' || source[j] === '\t' || source[j] === '\r' || source[j] === '\n')) j -= 1;
  if (j < 0) return true;
  const prev = source[j]!;
  if (/[A-Za-z0-9_$]/.test(prev)) return false;
  return prev !== ')' && prev !== ']';
}

function skipRegex(source: string, index: number, line: number): { index: number; line: number } | null {
  let i = index + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') return null;
    if (ch === '[' && !inClass) { inClass = true; i += 1; continue; }
    if (ch === ']' && inClass) { inClass = false; i += 1; continue; }
    if (ch === '/' && !inClass) {
      i += 1;
      while (i < source.length && /[A-Za-z]/.test(source[i]!)) i += 1;
      return { index: i, line };
    }
    i += 1;
  }
  return null;
}

function readCall(source: string, index: number, line: number): { title: string; skip: boolean; index: number; line: number } | null {
  let i = index;
  while (i < source.length && /\s/.test(source[i]!)) {
    if (source[i] === '\n') line += 1;
    i += 1;
  }
  let skip = false;
  if (source[i] === '.') {
    i += 1;
    const start = i;
    while (i < source.length && /[A-Za-z]/.test(source[i]!)) i += 1;
    const flag = source.slice(start, i);
    if (flag !== 'skip' && flag !== 'only') return null;
    skip = flag === 'skip';
    while (i < source.length && /\s/.test(source[i]!)) {
      if (source[i] === '\n') line += 1;
      i += 1;
    }
  }
  if (source[i] !== '(') return null;
  i += 1;
  while (i < source.length && /\s/.test(source[i]!)) {
    if (source[i] === '\n') line += 1;
    i += 1;
  }
  const quote = source[i];
  if (quote !== '\'' && quote !== '"' && quote !== '`') return null;
  const text = skipString(source, i, line);
  return { title: text.value, skip, index: text.index, line: text.line };
}

function skipString(source: string, index: number, line: number): { value: string; index: number; line: number } {
  const quote = source[index]!;
  let i = index + 1;
  let value = '';
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\n') line += 1;
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (next === '\n' || next === '\r') { line += 1; i += 2; continue; }
      value += next;
      i += 2;
      continue;
    }
    if (ch === quote) return { value, index: i + 1, line };
    value += ch;
    i += 1;
  }
  return { value, index: i, line };
}

export function testAtLine(source: string, line: number): MochaListedTest | null {
  return listMochaTests(source).find((test) => line >= test.line && line < test.endLine) ?? null;
}

/** Mocha's full title: suite titles and the test title, joined with one space. */
export function fullTitleFor(source: string, title: string | null | undefined, line?: number): string | null {
  const listed = listMochaTests(source).filter((test) => !test.skip);
  const named = title ? listed.filter((test) => test.title === title) : [];
  const atLine = line && line > 0
    ? named.find((test) => test.line === line) ?? listed.find((test) => test.line === line)
    : undefined;
  const chosen = atLine ?? (named.length === 1 ? named[0] : undefined);
  const full = chosen ? chosen.titlePath.join(' ') : (title ?? '');
  return full || null;
}

/**
 * Mocha compares `--grep` to the full title. A value that does not start and
 * end with `/` is compiled with `new RegExp`, so the argument is `^suite test$`
 * with regexp metacharacters escaped, not a `/pattern/` wrapper.
 * https://mochajs.org/#-grep-regexp-g-regexp
 */
export function grepPatternFor(source: string, title: string | null | undefined, line?: number): string | null {
  const full = fullTitleFor(source, title, line);
  if (!full) return null;
  return `^${full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}
