import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bug 1: base URL resolution. The CLI must read use.baseURL by actually
 * importing the target project's playwright.config.ts/.js (defineConfig and
 * env vars included), not by asking for --base-url or regexing the file.
 *
 * Temp projects are created INSIDE the repo so a config that imports
 * @playwright/test resolves it from the repo's node_modules, the same way a
 * real user project resolves its own.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { resolvePlaywrightBaseUrl, findPlaywrightConfig } = await import(
  path.join(repoRoot, 'dist', 'playwright-config.js')
);

function tempProject(files) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('reads use.baseURL from a TypeScript config using defineConfig', async () => {
  const dir = tempProject({
    'playwright.config.ts': `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'https://ts-config.example', actionTimeout: 1000 },
});
`,
  });
  try {
    assert.equal(await resolvePlaywrightBaseUrl(dir), 'https://ts-config.example');
  } finally {
    cleanup(dir);
  }
});

test('evaluates env vars in the config instead of reading text', async () => {
  process.env.QA_HEAL_TEST_BASE = 'https://from-env.example';
  const dir = tempProject({
    'playwright.config.ts': `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: { baseURL: process.env.QA_HEAL_TEST_BASE ?? 'https://fallback.example' },
});
`,
  });
  try {
    assert.equal(await resolvePlaywrightBaseUrl(dir), 'https://from-env.example');
  } finally {
    cleanup(dir);
    delete process.env.QA_HEAL_TEST_BASE;
  }
});

test('reads use.baseURL from a plain JavaScript config', async () => {
  const dir = tempProject({
    'package.json': '{ "type": "module" }',
    'playwright.config.js': `
export default { use: { baseURL: 'https://js-config.example' } };
`,
  });
  try {
    assert.equal(await resolvePlaywrightBaseUrl(dir), 'https://js-config.example');
  } finally {
    cleanup(dir);
  }
});

test('falls back to the first project baseURL when top-level use has none', async () => {
  const dir = tempProject({
    'playwright.config.ts': `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  projects: [
    { name: 'chromium', use: { baseURL: 'https://project.example' } },
  ],
});
`,
  });
  try {
    assert.equal(await resolvePlaywrightBaseUrl(dir), 'https://project.example');
  } finally {
    cleanup(dir);
  }
});

test('returns null when there is no playwright config', async () => {
  const dir = tempProject({});
  try {
    assert.equal(findPlaywrightConfig(dir), null);
    assert.equal(await resolvePlaywrightBaseUrl(dir), null);
  } finally {
    cleanup(dir);
  }
});

test('returns null when the config has no baseURL', async () => {
  const dir = tempProject({
    'playwright.config.ts': `
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests' });
`,
  });
  try {
    assert.equal(await resolvePlaywrightBaseUrl(dir), null);
  } finally {
    cleanup(dir);
  }
});
