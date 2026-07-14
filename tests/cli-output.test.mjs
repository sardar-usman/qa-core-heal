import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Issue 1: refusal reasons must be printed in ALL modes, in the same
 * per-locator format. The default (apply) mode used to run its preview pass
 * silently and print only "Nothing to heal ... N refused" with no detail.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');

function startServer(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('non-TTY apply is preview-only without --yes (exit 2), applies with -y (exit 0)', async () => {
  // A page the broken locator heals against (smart-CSS email fallback).
  const server = await startServer('<html><body><label>Mail <input type="email" name="email" id="mail-x9" /></label></body></html>');
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  const specPath = path.join(dir, 'tests/a.spec.ts');
  const brokenSpec = `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
`;
  fs.writeFileSync(specPath, brokenSpec);
  const runCli = (args) => new Promise((resolve) => {
    const child = spawn('node', [cliJs, ...args], { cwd: dir });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (status) => resolve({ status, stdout }));
  });
  try {
    // No TTY, no --yes: never prompt, never write, exit 2 so CI can detect
    // "heals available but not applied".
    const preview = await runCli(['tests/a.spec.ts', '--scan', '--base-url', base]);
    assert.equal(preview.status, 2);
    assert.match(preview.stdout, /\+ page\.getByRole\("textbox"\)/); // the proposed diff is shown
    assert.match(preview.stdout, /not applied/);
    assert.match(preview.stdout, /--yes/);
    assert.equal(fs.readFileSync(specPath, 'utf8'), brokenSpec); // nothing written
    // -y (alias of --yes): applies and exits 0.
    const applied = await runCli(['tests/a.spec.ts', '--scan', '--base-url', base, '-y', '--no-verify']);
    assert.equal(applied.status, 0);
    assert.match(fs.readFileSync(specPath, 'utf8'), /page\.getByRole\("textbox"\)/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('per-locator output is grouped by source file', async () => {
  const server = await startServer('<html><body><h1>Home</h1></body></html>');
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.writeFileSync(path.join(dir, 'pages/widgets.ts'), `export class Widgets {
  constructor(page) {
    this.page = page;
    this.two = this.page.locator('#flux-two');
  }
}
`);
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
import { Widgets } from '../pages/widgets';
test('x', async ({ page }) => {
  await page.goto('/');
  await page.locator('#flux-one').click();
});
`);
  try {
    const { status, stdout } = await new Promise((resolve) => {
      const child = spawn('node', [cliJs, 'tests/a.spec.ts', '--scan', '--base-url', base, '--dry-run'], { cwd: dir });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out }));
    });
    assert.equal(status, 0);
    // Each file's locators sit under that file's header, in scan order.
    const specHeader = stdout.indexOf('tests/a.spec.ts:');
    const one = stdout.indexOf('#flux-one');
    const pomHeader = stdout.indexOf('pages/widgets.ts:');
    const two = stdout.indexOf('#flux-two');
    assert.ok(specHeader >= 0, 'spec file header printed');
    assert.ok(pomHeader >= 0, 'page-object file header printed');
    assert.ok(specHeader < one && one < pomHeader && pomHeader < two,
      `grouped order violated:\n${stdout}`);
    // Totals still close the run.
    assert.match(stdout, /Done\. 0 intact · 0 healed · 2 refused/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default (apply) mode prints per-locator refusal reasons like dry-run does', async () => {
  const server = await startServer('<html><body><h1>Home</h1></body></html>');
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await page.locator('#flux-capacitor-zz').click();
});
`);
  // spawn (not spawnSync): the HTTP server above lives on THIS event loop,
  // and a blocking wait would stop it from ever answering the CLI's probe.
  const runCli = (args) => new Promise((resolve) => {
    const child = spawn('node', [cliJs, ...args], { cwd: dir });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (status) => resolve({ status, stdout }));
  });
  try {
    const dry = await runCli(['tests/a.spec.ts', '--scan', '--base-url', base, '--dry-run']);
    const apply = await runCli(['tests/a.spec.ts', '--scan', '--base-url', base]);
    assert.equal(dry.status, 0);
    assert.equal(apply.status, 0);
    const detailLine = (out) => out.split('\n').find((l) => l.includes('✗ unhealable'));
    assert.ok(detailLine(dry.stdout), 'dry-run must print the unhealable line');
    assert.ok(detailLine(apply.stdout), 'apply mode must print the unhealable line too');
    // Identical per-locator format in both modes: same selector line, and
    // the reason itself present in both outputs.
    assert.equal(detailLine(apply.stdout), detailLine(dry.stdout));
    assert.match(apply.stdout, /not found on route \//);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
