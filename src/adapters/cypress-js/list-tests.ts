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
 */
export function listSpecTests(source: string): SpecTest[] {
  const lines = source.split('\n');
  const suites: Array<{ title: string; skip: boolean; depth: number }> = [];
  let depth = 0;
  const tests: SpecTest[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const suite = /\b(?:describe|context)\s*(\.\s*skip\s*)?\(\s*(['"`])(.*?)\2/.exec(line);
    if (suite) {
      suites.push({ title: suite[3] ?? '', skip: Boolean(suite[1]), depth });
    }
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
  for (let i = 0; i < tests.length; i++) {
    tests[i]!.endLine = tests[i + 1]?.line ?? lines.length + 1;
  }
  return tests;
}

export function testAtLine(source: string, line: number): SpecTest | null {
  return listSpecTests(source).find((test) => line >= test.line && line < test.endLine) ?? null;
}
