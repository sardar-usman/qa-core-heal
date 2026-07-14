import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bug 3 end-to-end: the real-world wrong heal. #register-button (a submit
 * button) went missing; the only "Register" the page offers is a nav link.
 * Healing to the link is a wrong heal — the engine must refuse with a kind
 * mismatch instead. When the page has a real submit button, the same heal
 * goes through.
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

function writeSpec() {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/register.spec.ts'), `import { test } from '@playwright/test';
test('register', async ({ page }) => {
  await page.goto('/');
  await page.locator('#register-button').click();
});
`);
  return dir;
}

test('a button locator is NOT healed to a link: refused with a kind mismatch', async () => {
  const server = await startServer(
    '<html><body><nav><a href="/register" class="ico-register">Register</a></nav></body></html>',
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeSpec();
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/register.spec.ts')],
      baseUrl: base,
      write: false,
    });
    const loc = result.locators[0];
    assert.equal(loc.status, 'refused');
    assert.equal(loc.reason, 'kind mismatch: expected button, candidate is link');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same locator heals when the candidate really is a button', async () => {
  const server = await startServer(
    '<html><body><input type="submit" id="do-register" value="Register" /></body></html>',
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeSpec();
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/register.spec.ts')],
      baseUrl: base,
      write: false,
    });
    const loc = result.locators[0];
    assert.equal(loc.status, 'healed');
    assert.match(loc.new, /getByRole\("button"/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
