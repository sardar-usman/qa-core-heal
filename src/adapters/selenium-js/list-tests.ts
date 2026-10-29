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
  const lines = source.split('\n');
  const suites: Array<{ title: string; skip: boolean; depth: number }> = [];
  let depth = 0;
  const tests: MochaListedTest[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const suite = /\b(?:describe|context|suite)\s*(\.\s*skip\s*)?\(\s*(['"`])(.*?)\2/.exec(line);
    if (suite) suites.push({ title: suite[3] ?? '', skip: Boolean(suite[1]), depth });
    const found = /\b(?:it|test|specify)\s*(\.\s*(?:skip|only)\s*)?\(\s*(['"`])(.*?)\2/.exec(line);
    if (found) {
      const skip = Boolean(found[1] && /skip/.test(found[1])) || suites.some((item) => item.skip);
      const title = found[3] ?? '';
      tests.push({
        title,
        line: i + 1,
        endLine: lines.length + 1,
        skip,
        titlePath: [...suites.map((item) => item.title), title],
      });
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    depth += opens - closes;
    while (suites.length > 0 && suites[suites.length - 1]!.depth >= depth) suites.pop();
  }
  for (let i = 0; i < tests.length; i++) tests[i]!.endLine = tests[i + 1]?.line ?? lines.length + 1;
  return tests;
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
