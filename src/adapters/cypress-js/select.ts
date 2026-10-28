/**
 * Add `.only` to one `it` or `test` whose title is a string literal.
 * A title that is not a string literal is left alone. The caller then runs
 * the whole spec and reads only the target test.
 */

export interface OnlyEdit {
  injected: boolean;
  source: string;
}

export function injectOnly(source: string, title: string, line: number): OnlyEdit {
  const lines = source.split('\n');
  const index = line - 1;
  if (index < 0 || index >= lines.length) return { injected: false, source };
  const text = lines[index]!;
  const match = /\b(it|test)\s*\(\s*(['"`])([\s\S]*?)\2/.exec(text);
  if (!match) return { injected: false, source };
  if (match[3] !== title) return { injected: false, source };
  if (/\b(it|test)\s*\.\s*only\s*\(/.test(text)) return { injected: true, source };
  lines[index] = text.replace(/\b(it|test)\s*\(/, '$1.only(');
  return { injected: true, source: lines.join('\n') };
}
