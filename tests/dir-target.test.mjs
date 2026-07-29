import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 0.2.2: directory targets. `qa-core-heal tests/systematic` (a directory)
 * crashed with a bare "EISDIR: illegal operation on a directory, read" —
 * the directory path flowed into readFileSync. Directories are walked,
 * only regular files are read, symlinks and non-spec files are skipped
 * (noted under --verbose), and any fs error in the gather path reports
 * operation + path + spec and skips ONLY that spec's locators.
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

const runCli = (args, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cliJs, ...args], { cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

function makeTree(base) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  // 26 spec files across nested directories, each with one healthy locator.
  const spec = (n) => `import { test, expect } from '@playwright/test';
test('checks ok ${n}', async ({ page }) => {
  await page.goto('${base}/');
  await expect(page.locator('#ok')).toHaveText('fine');
});
`;
  let n = 0;
  for (const sub of ['tests/a', 'tests/a/deep', 'tests/b', 'tests/c/deeper/still']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(dir, sub, `s${i}.spec.ts`), spec(n++));
  }
  fs.writeFileSync(path.join(dir, 'tests/extra.test.ts'), spec(n++));
  fs.writeFileSync(path.join(dir, 'tests/extra2.spec.js'), spec(n++).replace(": Page", ''));
  // The deliberately weird tree: a DIRECTORY whose name looks like a spec
  // file, a non-spec file, and a symlinked directory (with a spec inside
  // that must NOT be picked up through the link).
  fs.mkdirSync(path.join(dir, 'tests/decoy.spec.ts'));
  fs.writeFileSync(path.join(dir, 'tests/notes.md'), 'not a spec\n');
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'hidden.spec.ts'), spec(99));
  fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'tests/linked'));
  return dir;
}

test('a directory target with a weird tree scans without crashing (26 specs)', async () => {
  const server = await startServer('<html><body><p id="ok">fine</p></body></html>');
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = makeTree(base);
  try {
    const r = await runCli(['tests', '--scan', '--dry-run', '--verbose'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /EISDIR/);
    assert.match(r.stdout, /scanned 26 locator\(s\) across 26 file\(s\)/);
    assert.match(r.stdout, /26 intact · 0 healed · 0 unhealable/);
    // The weird entries were noted, not read.
    assert.match(r.stderr, /\[verbose\] skipping symlink .*tests\/linked/);
    assert.match(r.stderr, /\[verbose\] skipping non-spec file .*notes\.md/);
    assert.ok(!r.stdout.includes('hidden.spec.ts'), 'symlinked dir must not be followed');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run-first mode accepts a directory target (the exact real-world crash shape)', async () => {
  const server = await startServer('<html><body><p id="ok">fine</p></body></html>');
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  fs.mkdirSync(path.join(dir, 'tests/sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', workers: 1, retries: 0, timeout: 8000,
  expect: { timeout: 1500 }, use: { baseURL: '${base}', actionTimeout: 1500 }, reporter: [['line']] });
`);
  fs.writeFileSync(path.join(dir, 'tests/pass.spec.ts'), `import { test, expect } from '@playwright/test';
test('sees ok', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#ok')).toHaveText('fine');
});
`);
  fs.writeFileSync(path.join(dir, 'tests/sub/broken.spec.ts'), `import { test } from '@playwright/test';
test('clicks flux', async ({ page }) => {
  await page.goto('/');
  await page.locator('#flux-capacitor-zz').click();
});
`);
  try {
    const r = await runCli(['tests', '--verbose'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /EISDIR/);
    // The echo shows what the user typed, never a converted form.
    assert.match(r.stdout, /▸ Running tests to find failures/);
    assert.match(r.stdout, /1 of 2 test\(s\) failing/);
    assert.match(r.stdout, /Done\. 0 intact · 0 healed · 1 refused/);
    // The nested spec reaches the child as a forward-slash, regex-escaped
    // filter — and no filter carries a separator backslash (a backslash
    // may only escape a regex special, never precede an alphanumeric).
    const childLine = r.stderr.split('\n').find((l) => l.includes('[verbose] child:') && l.includes(' test '));
    assert.ok(childLine, r.stderr);
    assert.ok(childLine.includes('tests/sub/broken\\.spec\\.ts'), childLine);
    const filters = childLine.split(' ').filter((a) => a.includes('spec'));
    for (const f of filters) assert.ok(!/\\[A-Za-z0-9]/.test(f), childLine);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a forced fs error skips only that spec, tells the full story, and sums up', async () => {
  const server = await startServer('<html><body><p id="ok">fine</p></body></html>');
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  fs.mkdirSync(path.join(dir, 'tests'));
  const spec = `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('${base}/');
  await expect(page.locator('#ok')).toHaveText('fine');
});
`;
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), spec);
  fs.writeFileSync(path.join(dir, 'tests/b.spec.ts'), spec);
  fs.writeFileSync(path.join(dir, 'tests/c.spec.ts'), spec);
  fs.chmodSync(path.join(dir, 'tests/b.spec.ts'), 0o000);
  try {
    const r = await runCli(['tests', '--scan', '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    // The full story: operation, exact path, which spec, and continuation.
    assert.match(r.stderr, /file error: read .*tests\/b\.spec\.ts failed while processing spec .*b\.spec\.ts: .*EACCES/);
    assert.match(r.stderr, /skipping/);
    // Only that spec's locators were skipped; the other two probed fine.
    assert.match(r.stdout, /scanned 2 locator\(s\) across 2 file\(s\)/);
    assert.match(r.stdout, /1 locator\(s\) skipped due to file errors/);
    assert.doesNotMatch(r.stdout + r.stderr, /^EACCES/m); // never the bare shape
  } finally {
    fs.chmodSync(path.join(dir, 'tests/b.spec.ts'), 0o644);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
