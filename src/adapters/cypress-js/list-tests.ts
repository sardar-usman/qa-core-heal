export interface SpecTest {
  title: string;
  line: number;
  endLine: number;
  skip: boolean;
  titlePath: string[];
}

/**
 * Titles and lines of `it` and `test` calls whose title is a string literal.
 * `it.skip` and a `describe.skip` that contains the test are skipped.
 * Braces inside strings, template literals, and comments do not change the suite depth.
 */
export function listSpecTests(source: string): SpecTest[] {
  const tests: SpecTest[] = [];
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
      if (skipped) {
        i = skipped.index;
        line = skipped.line;
        continue;
      }
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const skipped = skipString(source, i, line);
      i = skipped.index;
      line = skipped.line;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
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
      if (word === 'describe' || word === 'context' || word === 'it' || word === 'test' || word === 'specify') {
        const call = readCall(source, i, line);
        if (call) {
          i = call.index;
          line = call.line;
          const skip = call.skip || suites.some((item) => item.skip);
          if (word === 'describe' || word === 'context') {
            suites.push({ title: call.title, skip, depth });
          } else {
            tests.push({
              title: call.title,
              line: startLine,
              endLine: lineCount(source) + 1,
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

  for (let n = 0; n < tests.length; n++) tests[n]!.endLine = tests[n + 1]?.line ?? lineCount(source) + 1;
  return tests;
}

export function testAtLine(source: string, line: number): SpecTest | null {
  return listSpecTests(source).find((test) => line >= test.line && line < test.endLine) ?? null;
}

function lineCount(source: string): number {
  let n = 1;
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') n += 1;
  return n;
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

/** A `/` after `=` or `{` starts a regexp. A `/` after a name or a number is division. */
function regexCanStart(source: string, slashIndex: number): boolean {
  let j = slashIndex - 1;
  while (j >= 0 && (source[j] === ' ' || source[j] === '\t' || source[j] === '\r' || source[j] === '\n')) j -= 1;
  if (j < 0) return true;
  const prev = source[j]!;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(source[k]!)) k -= 1;
    const word = source.slice(k + 1, j + 1);
    return word === 'return' || word === 'case' || word === 'throw' || word === 'typeof'
      || word === 'void' || word === 'delete' || word === 'in' || word === 'of'
      || word === 'yield' || word === 'await' || word === 'else' || word === 'do'
      || word === 'instanceof';
  }
  return prev !== ')' && prev !== ']';
}

function skipRegex(source: string, index: number, line: number): { index: number; line: number } | null {
  let i = index + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (next === '\r' && source[i + 2] === '\n') { line += 1; i += 3; continue; }
      if (next === '\n' || next === '\r') { line += 1; i += 2; continue; }
      i += 2;
      continue;
    }
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

function skipString(source: string, index: number, line: number): { value: string; index: number; line: number } {
  const quote = source[index]!;
  let i = index + 1;
  let value = '';
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\n') line += 1;
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      // A backslash and a line break are a continuation. The break is not part of
      // the string, and the next line still counts.
      if (next === '\r' && source[i + 2] === '\n') {
        line += 1;
        i += 3;
        continue;
      }
      if (next === '\n' || next === '\r') {
        line += 1;
        i += 2;
        continue;
      }
      value += next;
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i += 2;
      let inner = 1;
      while (i < source.length && inner > 0) {
        const cur = source[i]!;
        if (cur === '\n') line += 1;
        if (cur === '\'' || cur === '"' || cur === '`') {
          const nested = skipString(source, i, line);
          i = nested.index;
          line = nested.line;
          continue;
        }
        if (cur === '{') inner += 1;
        else if (cur === '}') inner -= 1;
        i += 1;
      }
      continue;
    }
    if (ch === quote) return { value, index: i + 1, line };
    value += ch;
    i += 1;
  }
  return { value, index: i, line };
}
