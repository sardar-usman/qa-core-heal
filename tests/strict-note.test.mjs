import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 0.3.5: a strict mode violation that a fresh page load cannot reproduce
 * (the extra matches are created by the test's own clicks) used to be
 * refused with a reason that only said "not found ... may have been
 * removed". The refusal is still correct (nothing is healed), but the
 * reason must now name the strict mode violation.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

const PAGE = `<html><body>
<button id="add">Add item</button>
<ul id="list"></ul>
<script>
  document.getElementById('add').addEventListener('click', () => {
    const li = document.createElement('li');
    li.className = 'row-item';
    li.textContent = 'Item';
    document.getElementById('list').appendChild(li);
  });
</script>
</body></html>`;

test('a strict violation the fresh page cannot reproduce is named in the refusal reason', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "strict-note-repro", "private": true, "type": "module" }');
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('opens the added item', async ({ page }) => {
  await page.goto(${JSON.stringify(base + '/')});
  await page.locator('#add').click();
  await page.locator('#add').click();
  await page.locator('.row-item').click({ timeout: 2000 });
});
`);
  try {
    const { stdout } = await new Promise((resolve) => {
      const child = spawn('node', [cliJs, 'tests/a.spec.ts', '--base-url', base, '--dry-run'], { cwd: dir });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out }));
    });
    assert.match(stdout, /strict mode violation/, `expected a strict mode note:\n${stdout}`);
    assert.match(stdout, /matched several elements while the test ran/);
    assert.match(stdout, /scope it to its row or container/);
    assert.doesNotMatch(stdout, /Nothing to heal/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a plain not-found refusal carries no strict note', async () => {
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
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "strict-note-negative", "private": true, "type": "module" }');
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('clicks the missing item', async ({ page }) => {
  await page.goto(${JSON.stringify(base + '/')});
  await page.locator('.row-item').click({ timeout: 2000 });
});
`);
  try {
    const { stdout } = await new Promise((resolve) => {
      const child = spawn('node', [cliJs, 'tests/a.spec.ts', '--base-url', base, '--dry-run'], { cwd: dir });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out }));
    });
    assert.match(stdout, /not found on route/);
    assert.doesNotMatch(stdout, /strict mode violation/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
