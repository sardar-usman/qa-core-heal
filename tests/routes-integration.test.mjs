import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bug 2 end-to-end: heal() must probe each locator on the route its spec
 * navigates to, probe shared POMs on every importing spec's route, and word
 * refusals so "not found on route X" is distinguishable from ambiguity.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { heal } = await import(path.join(repoRoot, 'dist', 'heal.js'));

const PAGES = {
  '/': '<html><body><h1>Home</h1><a href="/a.html">Orders</a></body></html>',
  '/a.html': [
    '<html><body>',
    '<button id="save-order">Save order</button>',
    '<div aria-label="promo banner">Save 10% this week</div>',
    '<button aria-label="launch beta">Go</button>',
    '</body></html>',
  ].join(''),
  '/b.html': [
    '<html><body>',
    '<div aria-label="promo banner">Save 10% this week</div>',
    '<a href="#beta" aria-label="launch beta">Go</a>',
    '</body></html>',
  ].join(''),
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = PAGES[(req.url ?? '/').split('?')[0]];
      if (!body) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function writeProject(files) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

const SPEC_A = `import { test } from '@playwright/test';
test('save', async ({ page }) => {
  await page.goto('/a.html');
  await page.locator('#save-order').click();
});
`;

test('a locator that lives on the spec route probes intact, not against the homepage', async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject({ 'tests/a.spec.ts': SPEC_A });
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base,
      write: false,
    });
    assert.equal(result.locators.length, 1);
    assert.equal(result.locators[0].status, 'intact');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely missing locator is refused with its route in the reason', async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject({
    'tests/a.spec.ts': `import { test } from '@playwright/test';
test('flux', async ({ page }) => {
  await page.goto('/a.html');
  await page.locator('#flux-capacitor-panel').click();
});
`,
  });
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base,
      write: false,
    });
    assert.equal(result.locators[0].status, 'refused');
    assert.match(result.locators[0].reason, /not found on route \/a\.html/);
    assert.doesNotMatch(result.locators[0].reason, /ambiguous/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const POM_IMPORTING_SPECS = (pomSource) => ({
  'pages/shared.ts': pomSource,
  'tests/a.spec.ts': `import { test } from '@playwright/test';
import { Shared } from '../pages/shared';
test('a', async ({ page }) => {
  await page.goto('/a.html');
});
`,
  'tests/b.spec.ts': `import { test } from '@playwright/test';
import { Shared } from '../pages/shared';
test('b', async ({ page }) => {
  await page.goto('/b.html');
});
`,
});

test('a shared POM heals when both importing routes agree on the replacement', async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(POM_IMPORTING_SPECS(
    `export class Shared {
  constructor(page) {
    this.page = page;
    this.banner = this.page.locator('#promo-banner');
  }
}
`,
  ));
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts'), path.join(dir, 'tests/b.spec.ts')],
      baseUrl: base,
      write: false,
    });
    const banner = result.locators.find((l) => l.old.includes('#promo-banner'));
    assert.equal(banner.status, 'healed');
    assert.equal(banner.new, 'this.page.getByLabel("promo banner")');
    // Deduped: the shared POM is scanned once, not once per importing spec.
    assert.equal(result.locators.filter((l) => l.old.includes('#promo-banner')).length, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a shared POM is refused when its importing routes disagree on the replacement', async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(POM_IMPORTING_SPECS(
    `export class Shared {
  constructor(page) {
    this.page = page;
    this.beta = this.page.locator('#launch-beta');
  }
}
`,
  ));
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts'), path.join(dir, 'tests/b.spec.ts')],
      baseUrl: base,
      write: false,
    });
    const beta = result.locators.find((l) => l.old.includes('#launch-beta'));
    assert.equal(beta.status, 'refused');
    assert.match(beta.reason, /disagree/);
    assert.match(beta.reason, /\/a\.html/);
    assert.match(beta.reason, /\/b\.html/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
