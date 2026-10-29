import type { FailureClass } from '../types.js';

/**
 * Selenium error texts confirmed against the library.
 * `NoSuchElementError` prints the locator Selenium sent.
 * `By.id` and `By.name` are sent as CSS `*[id="x"]` and `*[name="x"]`
 * (selenium-webdriver `lib/by.js`).
 * A wait timeout is `TimeoutError: Waiting for element to be located By(...)`
 * and `Wait timed out after <n>ms`.
 * https://www.selenium.dev/selenium/docs/api/javascript/module/selenium-webdriver/lib/error.html
 */

const ID_CSS = /^\*\[id="(.*)"\]$/;
const NAME_CSS = /^\*\[name="(.*)"\]$/;

export function classifySeleniumFailure(message: string): FailureClass {
  const located = /Waiting for element to be located By\(([^)]*)\)/.exec(message);
  if (/TimeoutError/.test(message) && located) {
    return { kind: 'locator', selector: byText(located[1]!) };
  }
  const missing = /Unable to locate element:\s*(\{[\s\S]*?\})/.exec(message);
  if (/NoSuchElementError|no such element/i.test(message) && missing) {
    const parsed = parseLocatorJson(missing[1]!);
    if (parsed) return { kind: 'locator', selector: parsed };
  }
  return { kind: 'other', summary: clip(firstLine(message)) };
}

/** Turn the CSS Selenium sent for id and name back into a By call. */
export function byFromSentSelector(method: string, selector: string): string | null {
  if (method === 'link text') return `By.linkText(${quote(selector)})`;
  if (method === 'partial link text') return `By.partialLinkText(${quote(selector)})`;
  if (method !== 'css selector' && method !== 'xpath') return null;
  if (method === 'xpath') return `By.xpath(${quote(selector)})`;
  const id = ID_CSS.exec(selector);
  if (id) return `By.id(${quote(unescape(id[1]!))})`;
  const name = NAME_CSS.exec(selector);
  if (name) return `By.name(${quote(unescape(name[1]!))})`;
  return `By.css(${quote(selector)})`;
}

function byText(raw: string): string {
  const css = /css selector,\s*(.*)$/.exec(raw);
  if (css) return byFromSentSelector('css selector', css[1]!.trim()) ?? raw.trim();
  const xpath = /xpath,\s*(.*)$/.exec(raw);
  if (xpath) return `By.xpath(${quote(xpath[1]!.trim())})`;
  return raw.trim();
}

function parseLocatorJson(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as { method?: string; selector?: string };
    if (typeof obj.method === 'string' && typeof obj.selector === 'string') {
      return byFromSentSelector(obj.method, obj.selector);
    }
  } catch { /* Selenium leaves quotes inside the selector unescaped. */ }
  const loose = /"method":"([^"]+)","selector":"([\s\S]*)"\}/.exec(raw);
  if (!loose) return null;
  return byFromSentSelector(loose[1]!, loose[2]!);
}

function unescape(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function firstLine(message: string): string {
  return message.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? 'The test failed.';
}

function clip(text: string): string {
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
