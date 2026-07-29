import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 0.2.2 field report: the same broken locator was REFUSED in one run and
 * HEALED in another that passed --yes. Root cause: consent used to trigger
 * a SECOND heal() pass that re-probed the live page — if the page changed
 * between the preview and the apply pass, the applied/reported verdict
 * differed from the approved diff. The guarantee, now structural: --yes
 * only skips the prompt; consent applies the PREVIEWED plan byte-for-byte,
 * with no re-probe.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

const runCli = (args, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cliJs, ...args], { cwd });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.on('close', (status) => resolve({ status, stdout }));
});

test('--yes applies the previewed diff even when the page changes between passes', async () => {
  // The page MUTATES between loads: the first probe sees one candidate,
  // any later probe would see two (ambiguous). Before the fix, --yes
  // triggered a second probe that flipped the verdict to refused and
  // silently dropped the approved heal.
  let pageLoads = 0;
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      pageLoads++;
      const extra = pageLoads > 1 ? '<button aria-label="Button" type="button">Also</button>' : '';
      res.end(`<html><body><h1>Panel</h1><button aria-label="Button" type="button">Do</button>${extra}</body></html>`);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  fs.mkdirSync(path.join(dir, 'tests'));
  const specPath = path.join(dir, 'tests/a.spec.ts');
  fs.writeFileSync(specPath, `import { test } from '@playwright/test';
test('presses the button', async ({ page }) => {
  await page.goto('/');
  await page.locator('[aria-label="Button"][data-stale="1"]').click();
});
`);
  try {
    const r = await runCli(['tests/a.spec.ts', '--scan', '--base-url', base, '-y', '--no-verify'], dir);
    assert.equal(r.status, 0, r.stdout);
    // The approved diff landed verbatim — no second probe saw page v2.
    const healed = fs.readFileSync(specPath, 'utf8');
    assert.match(healed, /getByRole\("button", \{"name":"Button","exact":true\}\)/);
    // The reported verdicts are the previewed ones: 1 healed, 0 refused.
    assert.match(r.stdout, /Done\. 0 intact · 1 healed · 0 refused/);
    assert.doesNotMatch(r.stdout, /refusing to guess/);
    // The probe hit the page exactly once (the preview); consent added none.
    assert.equal(pageLoads, 1, `expected a single page load, saw ${pageLoads}`);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
