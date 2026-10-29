import type { FailureClass } from '../types.js';

/**
 * Cypress error texts confirmed against the login page, plus the
 * multiple-element error. Assertion failures stay `other`.
 *
 * Frames of the form `webpack://<package>/./<file>:<line>:<col>` map to
 * project files. Any other frame prefix is refused by the caller.
 */

export interface CypressFrame {
  file: string;
  line: number;
}

const WEBPACK_FRAME = /webpack:\/\/[^/]+\/\.\/([^:)\s]+):(\d+):\d+/g;

export function cypressFrames(message: string): { frames: CypressFrame[]; unknownPrefix: boolean } {
  const frames: CypressFrame[] = [];
  const seen = new Set<string>();
  for (const match of message.matchAll(WEBPACK_FRAME)) {
    const file = match[1]!;
    const line = Number(match[2]);
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push({ file, line });
  }
  const hasFrame = /(?:webpack:\/\/|https?:\/\/|node:|file:\/\/)\S+:\d+:\d+/.test(message);
  const unknownPrefix = hasFrame && frames.length === 0 && /:\d+:\d+/.test(message);
  return { frames, unknownPrefix };
}

function firstLine(message: string): string {
  return message.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? 'The test failed.';
}

export function classifyCypressFailure(message: string): FailureClass {
  const multi = /can only be called on a single element/.test(message)
    && /Your subject contained \d+ elements/.test(message);
  if (multi) {
    const selector = cssFromMessage(message);
    return { kind: 'locator', selector, strict: true };
  }
  const element = /Expected to find element:\s*`([^`]+)`/.exec(message);
  if (element) return { kind: 'locator', selector: `get(${quote(element[1]!)})` };
  const content = /Expected to find content:\s*'([^']*)'\s*within the selector:\s*'([^']*)'/.exec(message);
  if (content) return { kind: 'locator', selector: `contains(${quote(content[2]!)}, ${quote(content[1]!)})` };
  const contentOnly = /Expected to find content:\s*'([^']*)'/.exec(message);
  if (contentOnly && !content) return { kind: 'locator', selector: `contains(${quote(contentOnly[1]!)})` };
  const role = /accessible native element with the role "([^"]+)" and name "([^"]+)"/.exec(message);
  if (role) return { kind: 'locator', selector: `getByRole(${quote(role[1]!)}, { name: ${quote(role[2]!)} })` };
  return { kind: 'other', summary: clip(firstLine(message)) };
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function cssFromMessage(message: string): string | null {
  const element = /Expected to find element:\s*`([^`]+)`/.exec(message);
  if (element) return `get(${quote(element[1]!)})`;
  return null;
}

function clip(text: string): string {
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

export function refusalForCypressStart(message: string): { code: 'spec-not-found' | 'navigation-or-network' | 'timeout'; text: string } | null {
  if (/binary is missing|Cypress executable not found|No version of Cypress is installed/i.test(message)) {
    return { code: 'spec-not-found', text: 'The Cypress binary is missing. Run npx cypress install, then run heal again.' };
  }
  if (/could not find (?:a Cypress|any spec|spec file)|No specs? found|spec .* does not exist/i.test(message)) {
    return { code: 'spec-not-found', text: clip(firstLine(message)) };
  }
  if (/ECONNREFUSED|ENOTFOUND|net::|Timed out waiting for the browser|failed to connect/i.test(message)) {
    return { code: 'navigation-or-network', text: clip(firstLine(message)) };
  }
  if (/timed out|timeout/i.test(message)) {
    return { code: 'timeout', text: clip(firstLine(message)) };
  }
  return null;
}
