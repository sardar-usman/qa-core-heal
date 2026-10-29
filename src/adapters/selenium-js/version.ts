import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Minimums from the Selenium and Mocha releases this heal was written against.
 * selenium-webdriver 4.6.0 is the first release with Selenium Manager.
 * https://www.selenium.dev/blog/2022/selenium-4-6-0/
 * Mocha 10 is the line with the JSON reporter `output` option used here.
 * https://mochajs.org/#json
 */
export const SELENIUM_MIN = '4.6.0';
export const MOCHA_MIN = '10.0.0';

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number(part.replace(/[^0-9].*$/, '')) || 0);
  const b = right.split('.').map((part) => Number(part.replace(/[^0-9].*$/, '')) || 0);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

function readInstalled(root: string, name: string): string | null {
  try {
    const pkg = createRequire(path.join(root, 'package.json')).resolve(`${name}/package.json`);
    const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function seleniumVersion(root: string): string | null {
  return readInstalled(root, 'selenium-webdriver');
}

export function mochaVersion(root: string): string | null {
  return readInstalled(root, 'mocha');
}
