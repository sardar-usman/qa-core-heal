import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Issue 2 end-to-end: typo'd identifiers heal via fuzzy matching, but only
 * when exactly one candidate is in the band, the kind guard passes, and the
 * confirmation holds. Near-misses and state-dependent absences refuse with
 * honest, distinct reasons.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { heal } = await import(path.join(repoRoot, 'dist', 'heal.js'));

const PAGE = [
  '<html><body>',
  '<h1>Inventory</h1>',
  '<a href="/export.csv" id="export-buttn">Download CSV</a>',
  '<form>',
  '<label for="quantity-field">Quantity</label>',
  '<input id="quantity-field" type="text" />',
  '<label for="contact-email">Contact email</label>',
  '<input id="contact-email" name="email" type="text" />',
  '<label for="backup-email">Backup email</label>',
  '<input id="backup-email" name="email" type="text" />',
  '<button id="save-inventory" type="submit">Save</button>',
  '<button id="reset-form" type="button">Reset</button>',
  '</form>',
  '</body></html>',
].join('\n');

function startServer(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function healOne(html, locatorLine) {
  const server = await startServer(html);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await ${locatorLine};
});
`);
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base,
      write: false,
    });
    return result.locators[0];
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an in-word typo heals to the real element through the fuzzy band', async () => {
  const loc = await healOne(PAGE, "page.locator('#quantiy-field').fill('3')");
  assert.equal(loc.status, 'healed');
  assert.equal(loc.new, 'page.getByRole("textbox", {"name":"quantity"})');
});

test('a fuzzy candidate with a conflicting kind still refuses', async () => {
  const loc = await healOne(PAGE, "page.locator('#export-button').click()");
  assert.equal(loc.status, 'refused');
  assert.equal(loc.reason, 'kind mismatch: expected button, candidate is link');
});

test('two near-identical candidates refuse as ambiguous', async () => {
  const loc = await healOne(PAGE, "page.locator('#emai_l').fill('x@y.dev')");
  assert.equal(loc.status, 'refused');
  assert.equal(loc.reason, 'ambiguous on route /: several close matches (#contact-email, #backup-email), refusing to guess');
});

test('a below-threshold near-miss names the candidates it considered, with scores', async () => {
  const html = '<html><body><input id="emailz9" type="text" /></body></html>';
  const loc = await healOne(html, "page.locator('#Emai_l').fill('x@y.dev')");
  assert.equal(loc.status, 'refused');
  assert.match(loc.reason, /not found on route \/: closest candidates below the confidence threshold: #emailz9 \(0\.\d\d\)/);
});

test('a mutated getByRole name heals to the real accessible name', async () => {
  const html = [
    '<html><body><form>',
    '<label for="Email">Email</label><input id="Email" name="Email" type="text" />',
    '<label for="Password">Password</label><input id="Password" type="password" />',
    '</form></body></html>',
  ].join('');
  const loc = await healOne(html, "page.getByRole('textbox', { name: 'Ema_il_2' }).fill('x@y.dev')");
  assert.equal(loc.status, 'healed');
  assert.match(loc.new, /^page\.getByRole\("textbox", \{"name":"Email"/);
});

test('a mutated getByRole name refuses when two candidates sit in the band', async () => {
  const loc = await healOne(PAGE, "page.getByRole('textbox', { name: 'emial' }).fill('x@y.dev')");
  assert.equal(loc.status, 'refused');
  assert.equal(loc.reason, 'ambiguous on route /: several close matches (#contact-email, #backup-email), refusing to guess');
});

test('a suffix-carrying semantic identity heals through the strip stage', async () => {
  const loc = await healOne(PAGE, "page.getByLabel('Quantity_1').fill('2')");
  assert.equal(loc.status, 'healed');
  assert.match(loc.new, /^page\.getByRole\("textbox", \{"name":"Quantity"/);
});

test('a hasText filter identity heals through fuzzy when the css part is compound', async () => {
  const html = [
    '<html><body><section class="grid">',
    '<div class="tier"><h3>Pro plan</h3></div>',
    '<div class="tier"><h3>Base plan</h3></div>',
    '</section></body></html>',
  ].join('');
  const loc = await healOne(html, "page.locator('section.plan-grid .tier-x', { hasText: 'Proo plan' }).click()");
  assert.equal(loc.status, 'healed');
  assert.equal(loc.new, 'page.getByText("Pro plan")');
});

test('a never-found selector with state evidence names its token', async () => {
  const html = '<html><body><h1>Register</h1></body></html>';
  const loc = await healOne(html, "page.locator('.result').click()");
  assert.equal(loc.status, 'refused');
  assert.equal(
    loc.reason,
    'not found on route /: element may be state-dependent (selector token "result" suggests it appears only after user actions); static healing cannot verify it',
  );
});

test('a never-found selector without evidence refuses with the hedged reason', async () => {
  const html = '<html><body><h1>Register</h1></body></html>';
  const loc = await healOne(html, "page.locator('#flux-capacitor-panel').click()");
  assert.equal(loc.status, 'refused');
  assert.equal(
    loc.reason,
    'not found on route /: no matching or similar element on the probed page. '
    + 'The element may have been removed, renamed beyond recognition, or may only appear after user actions.',
  );
});
