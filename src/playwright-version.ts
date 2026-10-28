import { createRequire } from 'node:module';
import path from 'node:path';

/** The installed Playwright version, resolved from a project root first. */
export function playwrightVersion(root: string): string | null {
  const attempts = [path.join(root, 'package.json'), import.meta.url];
  for (const from of attempts) {
    try {
      const req = createRequire(from);
      const v = (req('@playwright/test/package.json') as { version?: string }).version;
      if (typeof v === 'string' && v.length > 0) return v;
    } catch { /* try the next location */ }
  }
  return null;
}
