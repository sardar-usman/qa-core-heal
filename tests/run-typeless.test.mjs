import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * BUG 2 end-to-end verification through the SAME code path run mode uses:
 * a project whose package.json has NO "type" field and whose config is
 * byte-for-byte the real repo's pattern (ESM imports + require("dotenv") +
 * conditional reporters + top-level use.baseURL). The spec navigates
 * RELATIVELY, so healing is impossible unless the config's baseURL
 * actually resolves.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

test('run mode heals in a typeless package whose config mixes ESM imports with require()', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><label for="quantity">Quantity</label><input id="quantity" type="text" /></body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "nextjs-admin", "private": true }');
  fs.writeFileSync(path.join(dir, '.env'), `BASE_URL=${base}\n`);
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `import { defineConfig, devices } from '@playwright/test';
require('dotenv').config();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://staging.example.com',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`);
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('sets the quantity', async ({ page }) => {
  await page.goto('/');
  await page.locator('#quantiy').fill('3', { timeout: 2000 });
});
`);
  try {
    const { status, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn('node', [cliJs, 'tests/a.spec.ts', '-y', '--no-verify'], { cwd: dir });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    assert.equal(status, 0, `stdout:\n${stdout}\nstderr:\n${stderr}`);
    assert.doesNotMatch(stderr, /failed to load/);
    assert.match(fs.readFileSync(path.join(dir, 'tests/a.spec.ts'), 'utf8'), /getByRole\("textbox"/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
