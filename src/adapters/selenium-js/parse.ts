/**
 * Literal Selenium locators. Anything else is refused.
 * https://www.selenium.dev/documentation/webdriver/elements/locators/
 */

export type SeleniumStrategy = 'css' | 'id' | 'name' | 'xpath' | 'linkText' | 'partialLinkText';
export type SeleniumQuote = "'" | '"';

export interface SeleniumCall {
  file: string;
  line: number;
  endLine: number;
  startCol: number;
  endCol: number;
  raw: string;
  strategy: SeleniumStrategy | null;
  value: string | null;
  quote: SeleniumQuote;
  unsafe: string | null;
}

const LITERAL = /By\.(css|id|name|xpath|linkText|partialLinkText|className|js)\(\s*(['"])((?:\\.|(?!\2).)*)\2\s*\)/g;
const UNSAFE_LINE = /locateWith\s*\(|withTagName\s*\(|\.shadowRoot|By\.js\s*\(|findElement\s*\(\s*\{|findElements\s*\(\s*\{/;

export function parseSeleniumCalls(source: string, file: string): SeleniumCall[] {
  const out: SeleniumCall[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (UNSAFE_LINE.test(line) && !LITERAL.test(line)) {
      const at = line.search(UNSAFE_LINE);
      out.push(call(file, i + 1, at, line.slice(at).trim(), null, null, "'", unsafeReason(line)));
    }
    LITERAL.lastIndex = 0;
  }
  LITERAL.lastIndex = 0;
  for (const match of source.matchAll(LITERAL)) {
    const index = match.index ?? 0;
    const before = source.slice(0, index);
    const line = before.split('\n').length;
    const startCol = index - before.lastIndexOf('\n') - 1;
    const raw = match[0]!;
    const strategy = match[1]!;
    const quote = match[2] as SeleniumQuote;
    const value = unescape(match[3] ?? '');
    if (strategy === 'js' || strategy === 'className') {
      out.push(call(file, line, startCol, raw, null, null, quote, strategy === 'js'
        ? 'By.js is not supported.'
        : 'By.className is not healed. Use By.css.'));
      continue;
    }
    if (/iframe|shadow/i.test(value)) {
      out.push(call(file, line, startCol, raw, strategy as SeleniumStrategy, value, quote, 'iframe and shadow locators are not supported.'));
      continue;
    }
    out.push(call(file, line, startCol, raw, strategy as SeleniumStrategy, value, quote, null));
  }
  const variable = /By\.(?:css|id|name|xpath|linkText|partialLinkText)\(\s*[A-Za-z_$]/g;
  for (const match of source.matchAll(variable)) {
    const index = match.index ?? 0;
    const before = source.slice(0, index);
    const line = before.split('\n').length;
    const startCol = index - before.lastIndexOf('\n') - 1;
    out.push(call(file, line, startCol, match[0]!, null, null, "'", 'A locator argument must be a string literal.'));
  }
  return out;
}

export function hasRemoteSession(source: string): boolean {
  return /usingServer\s*\(/.test(source);
}

function call(
  file: string,
  line: number,
  startCol: number,
  raw: string,
  strategy: SeleniumStrategy | null,
  value: string | null,
  quote: SeleniumQuote,
  unsafe: string | null,
): SeleniumCall {
  return { file, line, endLine: line, startCol, endCol: startCol + raw.length, raw, strategy, value, quote, unsafe };
}

function unsafeReason(line: string): string {
  if (/shadow/i.test(line)) return 'iframe and shadow locators are not supported.';
  if (/By\.js/.test(line)) return 'By.js is not supported.';
  if (/locateWith|withTagName/.test(line)) return 'Relative locators are not supported.';
  return 'Object locators are not supported.';
}

function unescape(value: string): string {
  return value.replace(/\\(['"\\])/g, '$1');
}
