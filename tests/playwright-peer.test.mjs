import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseOf, finding, repoRoot, startServer, writeFindings } from './helpers/contract.mjs';

/**
 * Playwright is a peer dependency. Smoke the lowest and highest versions
 * in the declared range. The suite itself stays on the devDependency,
 * Playwright 1.60.0. The browser cache is kept between runs.
 */

const RANGE = '>=1.49.0 <=1.64.1';
const LOW = '1.49.0';
const HIGH = '1.64.1';

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

test('playwright is a peer dependency in the tested range, not a hard dependency', () => {
  assert.equal(pkg.dependencies?.playwright, undefined);
  assert.equal(pkg.dependencies?.['@playwright/test'], undefined);
  assert.equal(pkg.peerDependencies.playwright, RANGE);
  assert.equal(pkg.peerDependencies['@playwright/test'], RANGE);
  assert.equal(pkg.devDependencies.playwright, '1.60.0');
  assert.equal(pkg.devDependencies['@playwright/test'], '1.60.0');
});

function ensurePeer(version) {
  const cache = path.join(os.tmpdir(), 'qa-core-heal-peer-cache', version);
  const ready = path.join(cache, '.ready');
  if (!fs.existsSync(ready)) {
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'package.json'), JSON.stringify({
      name: `peer-${version}`,
      private: true,
      dependencies: { '@playwright/test': version, playwright: version },
    }));
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: cache, stdio: 'inherit' });
    execFileSync('npx', ['playwright', 'install', 'chromium'], { cwd: cache, stdio: 'inherit' });
    fs.writeFileSync(ready, 'ok\n');
  }
  return cache;
}

function copyTool(proj) {
  const dest = path.join(proj, 'node_modules', 'qa-core-heal');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'dist'), path.join(dest, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(dest, 'package.json'));
  fs.cpSync(path.join(repoRoot, 'schemas'), path.join(dest, 'schemas'), { recursive: true });
  return path.join(dest, 'dist', 'cli.js');
}

function runCopied(cli, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function smoke(version, base) {
  const cache = ensurePeer(version);
  const proj = path.join(cache, `smoke-${process.pid}`);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.mkdirSync(path.join(proj, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), '{ "name": "smoke", "private": true, "type": "module" }');
  fs.writeFileSync(path.join(proj, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, retries: 0, timeout: 20000,
  use: { baseURL: '${base}' },
  projects: [{ name: 'chromium' }],
  reporter: [['line']],
});
`);
  fs.writeFileSync(path.join(proj, 'tests/ok.spec.ts'), `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#mail-x9').fill('a@b.dev');
});
`);
  fs.writeFileSync(path.join(proj, 'tests/bad.spec.ts'), `import { test } from '@playwright/test';
test('broken mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
`);
  const cli = copyTool(proj);
  const findings = writeFindings(proj, [finding({ file: 'tests/ok.spec.ts' })], base);
  const results = path.join(proj, 'heal-results.json');
  const found = await runCopied(cli, ['--findings', findings, '--results', results, '--dry-run', '--shadow-runs', '1'], proj);
  assert.equal(found.status, 0, `${version} findings: ${found.stderr}`);
  const doc = JSON.parse(fs.readFileSync(results, 'utf8'));
  assert.equal(doc.results[0].status, 'nothing-to-heal', doc.results[0].explanation);
  const scan = await runCopied(cli, ['tests/bad.spec.ts', '--scan', '--dry-run'], proj);
  assert.equal(scan.status, 0, `${version} scan: ${scan.stderr}`);
  assert.match(scan.stdout, /input\[type="email"\]/);
  fs.rmSync(proj, { recursive: true, force: true });
}

test('the lowest and highest Playwright versions in the peer range can run a findings smoke and a scan smoke', { timeout: 15 * 60 * 1000 }, async () => {
  const server = await startServer('<html><body><label>Mail <input id="mail-x9" name="email" type="email" /></label></body></html>');
  try {
    const base = baseOf(server);
    await smoke(LOW, base);
    await smoke(HIGH, base);
  } finally { server.close(); }
});
