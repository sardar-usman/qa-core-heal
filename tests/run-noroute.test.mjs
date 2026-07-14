import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * GAP 2: with no trace (--no-trace, custom browser setups) and no static
 * route signal (the spec navigates via an env var, so no goto() literal),
 * the failure URL is unknowable. The CLI must refuse loudly instead of
 * silently probing the wrong page.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

test('unknown failure page refuses loudly instead of probing the wrong page', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Admin</h1></body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "noroute-repro", "private": true, "type": "module" }');
  // baseURL exists in the playwright config (resolvable), but it was never
  // EXPLICITLY given by the user — probing it for this locator would be a
  // guess about where the failure happened.
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', use: { baseURL: ${JSON.stringify(base)} } });
`);
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('opens the admin panel', async ({ page }) => {
  await page.goto(process.env.APP_URL!);
  await page.locator('#zz-broken-panel').click({ timeout: 2000 });
});
`);
  try {
    const { status, stdout } = await new Promise((resolve) => {
      const child = spawn('node', [cliJs, 'tests/a.spec.ts', '--no-trace'], {
        cwd: dir, env: { ...process.env, APP_URL: `${base}/` },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out }));
    });
    assert.match(stdout, /could not determine the page where .*#zz-broken-panel.* failed/);
    assert.match(stdout, /--route <file>=<route> or --base-url/);
    // Refused, not silently probed: no heal proposed, no page opened.
    assert.doesNotMatch(stdout, /· opened /);
    assert.equal(status, 0, stdout);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
