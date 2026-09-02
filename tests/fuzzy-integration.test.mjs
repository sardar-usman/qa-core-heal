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
  assert.equal(loc.new, 'page.locator("#quantity-field")');
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
  assert.equal(loc.new, 'page.getByText("Pro plan", { exact: true })');
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

// 0.3.2 field case (/dynamicid): a one-edit text mutation fuzzy-matches the
// heading at 0.90, but the SUBSTRING getByText resolves the heading AND a
// button whose caption contains the phrase — the confirmed match used to be
// silently dropped into the generic not-found refusal. The heal must fall
// back to the exact form and EMIT it with { exact: true }.
test('a one-edit text match that is substring-ambiguous heals via the exact form', async () => {
  const html = '<html><body><h2>Dynamic ID</h2>'
    + '<button type="button">Button with Dynamic ID</button></body></html>';
  const loc = await healOne(html, 'page.getByText("Dynamic 1ID").click()');
  assert.equal(loc.status, 'healed');
  assert.equal(loc.new, 'page.getByText("Dynamic ID", { exact: true })');
});

test('a text match ambiguous even in exact form refuses naming the candidate', async () => {
  const html = '<html><body><h2>Dynamic ID</h2>'
    + '<p><span>Dynamic ID</span></p>'
    + '<button type="button">Button with Dynamic ID</button></body></html>';
  const loc = await healOne(html, 'page.getByText("Dynamic 1ID").click()');
  assert.equal(loc.status, 'refused');
  assert.match(loc.reason, /^ambiguous on route \/: several close matches/);
  assert.match(loc.reason, /Dynamic ID/);
});

// 0.3.4 emit contract: text emits carry the element's own text with
// exact:true even when the substring form would be unique — the emitted
// identity is read from the confirmed element, never left substring-loose.
test('a substring-unique text match emits the element text with exact:true (the Scenarios control)', async () => {
  const html = '<html><body><h2>Overview</h2><p>Scenario</p></body></html>';
  const loc = await healOne(html, 'page.getByText("Scenarios").click()');
  assert.equal(loc.status, 'healed');
  assert.equal(loc.new, 'page.getByText("Scenario", { exact: true })');
});

// 0.3.2 structural fix: an intent-pass resolution that fails confirmation
// is stashed, never terminal — the fuzzy stage (which confirms against
// the scored CANDIDATE's identity, not the broken string) still runs.
// Before the fix this shape refused and killed every mid-word-typo heal.
test('a mid-word typo heals even when an earlier resolution failed confirmation', async () => {
  const html = '<html><body><label for="inputField">Amount</label>'
    + '<input id="inputField" type="text" /></body></html>';
  const loc = await healOne(html, "page.locator('#inputFeld').fill('42')");
  assert.equal(loc.status, 'healed');
  assert.equal(loc.new, 'page.locator("#inputField")');
});

// 0.3.2 whitespace canonicalization: collected identity values fold all
// space-category codepoints (NBSP, thin space) to plain space and DELETE
// zero-width characters — so an emitted heal never carries invisible
// bytes into the user's source. Playwright's matcher tolerates the
// normalized text at runtime (verified against NBSP and ZWSP DOM).
test('a zero-width-spaced greeting heals with clean text, no invisible bytes emitted', async () => {
  const html = '<html><head><meta charset="utf-8"></head><body>'
    + '<p>Welcome​UserName!</p><p>Hello UserName!</p></body></html>';
  const loc = await healOne(html, 'page.getByText("Welcome UserNam!").click()');
  assert.equal(loc.status, 'healed');
  assert.ok(!/[​-‍⁠﻿ ]/.test(loc.new), JSON.stringify(loc.new));
  assert.equal(loc.new, 'page.getByText("WelcomeUserName!", { exact: true })');
});

// The value-attribute button gap: <input type="submit" value="Upload">
// has no text content; its value is its accessible name and must be in
// the candidate pool.
test('a value-attribute submit button heals via its value identity', async () => {
  const html = '<html><body><h2>File Upload</h2>'
    + '<form><input type="file" /><input type="submit" value="Upload" /></form></body></html>';
  const loc = await healOne(html, 'page.getByRole("button", { name: "Uploadd" }).click()');
  assert.equal(loc.status, 'healed');
  assert.equal(loc.new, 'page.getByRole("button", {"name":"Upload","exact":true})');
});
