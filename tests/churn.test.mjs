import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SPA churn: pages that REPLACE their DOM nodes on an interval (React
 * re-renders). Confirmation must compare logical identity — separator-
 * normalized attributes, fingerprints across fresh reads — not node
 * identity or byte-exact tokens. Genuine mismatches still refuse, and the
 * refusal names WHAT differed.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { heal } = await import(path.join(repoRoot, 'dist', 'heal.js'));

const CHURN_FORM = `<!doctype html><html><body><div id="root"></div><script>
function render() {
  var prev = document.querySelector('[name="search_field"]');
  var val = prev ? prev.value : '';
  document.getElementById('root').innerHTML =
    '<h1>Search console</h1><form><label>Search <input name="search_field" type="text" /></label>' +
    '<button type="submit">Run search</button></form>';
  document.querySelector('[name="search_field"]').value = val;
}
render(); setInterval(render, 30);
</script></body></html>`;

const CHURN_PANEL = `<!doctype html><html><body><div id="root"></div><script>
function render() {
  document.getElementById('root').innerHTML =
    '<h1>Lookup panel</h1><input type="search" id="global-lookup" aria-label="Global lookup" />';
}
render(); setInterval(render, 30);
</script></body></html>`;

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

test('the heal survives interval re-renders (underscored attribute vs spaced token)', async () => {
  // The exact real-repo shape: [name="search_field_1"] -> [name="search_field"].
  const loc = await healOne(CHURN_FORM, "page.locator('[name=\"search_field_1\"]').fill('w')");
  assert.equal(loc.status, 'healed', loc.reason ?? '');
});

test('a genuinely different control still refuses, naming the diff', async () => {
  const loc = await healOne(CHURN_PANEL, "page.locator('#search-panel-42').fill('x')");
  assert.equal(loc.status, 'refused');
  assert.match(
    loc.reason,
    /re-resolved element differs: expected an element matching "search panel 42" \(from page\.locator\('#search-panel-42'\)\), got input\[id="global-lookup"\]\[type="search"\].* at \(\d+, \d+\)/,
  );
});
