import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Run-first hardening: when a locator failure cannot be matched to any
 * locator call in the source (here: an old-style page.click(selector),
 * which never appears as a locator call), the CLI must say so explicitly
 * and exit non-zero — NEVER a bare "Nothing to heal" while tests are red.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

test('an unmatchable failing locator is reported as a bug, exit non-zero', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Home</h1></body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "unmatched-repro", "private": true, "type": "module" }');
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('clicks the missing button', async ({ page }) => {
  await page.goto(${JSON.stringify(base + '/')});
  await page.click('#missing-btn', { timeout: 2000 });
});
`);
  try {
    const { status, stdout } = await new Promise((resolve) => {
      const child = spawn('node', [cliJs, 'tests/a.spec.ts', '--base-url', base], { cwd: dir });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out }));
    });
    assert.notEqual(status, 0, `expected non-zero exit, got ${status}:\n${stdout}`);
    assert.match(stdout, /could not be matched to source/);
    assert.match(stdout, /locator\('#missing-btn'\)/);
    assert.match(stdout, /clicks the missing button/);
    assert.match(stdout, /bug worth reporting/);
    assert.doesNotMatch(stdout, /Nothing to heal/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
