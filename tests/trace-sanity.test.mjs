import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * BUG 1 sanity checks: a trace URL from a third-party origin (matching
 * neither the base URL nor any goto() target) must be DISCARDED and the
 * probe fall back to route inference. The third-party page here carries a
 * decoy element that matches the broken selector exactly — probing it
 * would wrongly conclude "intact". Healing on the real page proves the
 * discard happened.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { heal } = await import(path.join(repoRoot, 'dist', 'heal.js'));

function startServer(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('with no baseURL and no absolute goto, the main-frame trace URL is TRUSTED', async () => {
  // BUG B: the origin check has nothing to compare against here — the spec
  // navigates via a variable and there is no config or --base-url. The
  // trace URL already passed the main-frame and non-http filters; it IS
  // the answer, and discarding it killed real runs that held it.
  const appServer = await startServer(
    '<html><body><label for="quantity">Quantity</label><input id="quantity" type="text" /></body></html>',
  );
  const base = `http://127.0.0.1:${appServer.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto(process.env.APP_URL!);
  await page.locator('#quantiy').fill('3');
});
`);
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      // No baseUrl at all: resolution must fall back to the trace URL.
      write: false,
      targets: [{ selector: "locator('#quantiy')", url: `${base}/`, test: 'x' }],
    });
    const loc = result.locators[0];
    assert.equal(loc.status, 'healed');
    assert.match(loc.new, /getByRole\("textbox"/);
  } finally {
    appServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a third-party trace URL is discarded; the locator heals on the inferred route', async () => {
  const appServer = await startServer(
    '<html><body><label for="quantity">Quantity</label><input id="quantity" type="text" /></body></html>',
  );
  // The decoy: an element the BROKEN selector resolves against directly.
  const thirdParty = await startServer('<html><body><input id="quantiy" type="text" /></body></html>');
  const base = `http://127.0.0.1:${appServer.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await page.locator('#quantiy').fill('3');
});
`);
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base,
      write: false,
      targets: [{
        selector: "locator('#quantiy')",
        // Wrong page: another origin entirely, like a feedback-widget iframe.
        url: `http://127.0.0.1:${thirdParty.address().port}/`,
        test: 'x',
      }],
    });
    const loc = result.locators[0];
    // Probed on the inferred route (the real app), NOT the decoy: healed,
    // not "intact".
    assert.equal(loc.status, 'healed');
    assert.match(loc.new, /getByRole\("textbox"/);
  } finally {
    appServer.close();
    thirdParty.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
