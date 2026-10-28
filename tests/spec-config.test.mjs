import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { baseOf, repoRoot, rm, runCli, startServer } from './helpers/contract.mjs';

/**
 * Spec mode (not findings mode) must be able to use a Playwright config
 * that is not in the project root. The flag is --playwright-config, because
 * --config already loads qa-core.config.json.
 */

const PAGE = '<html><body><label>Mail <input type="email" name="email" id="mail-x9" /></label></body></html>';

function nestedSpec(base) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  const configRel = 'demo/app/playwright.config.ts';
  const specRel = 'demo/app/tests/a.spec.ts';
  fs.mkdirSync(path.join(dir, 'demo/app/tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, configRel), `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, retries: 0, timeout: 15000,
  expect: { timeout: 1500 },
  use: { baseURL: '${base}', actionTimeout: 1500 },
  projects: [{ name: 'chromium' }],
  reporter: [['line']],
});
`);
  fs.writeFileSync(path.join(dir, specRel), `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
`);
  return { dir, specRel, configRel };
}

test('without --playwright-config a nested config is ignored and the relative goto has no base URL', async () => {
  const server = await startServer(PAGE);
  const n = nestedSpec(baseOf(server));
  try {
    const r = await runCli([n.specRel, '--dry-run', '--verbose'], n.dir);
    assert.match(`${r.stdout}\n${r.stderr}`, /Cannot navigate to invalid URL/);
    assert.doesNotMatch(r.stdout, /healed to/);
    assert.doesNotMatch(r.stderr, /--config /);
  } finally { server.close(); rm(n.dir); }
});

test('--playwright-config is passed to Playwright as --config and the spec can heal', async () => {
  const server = await startServer(PAGE);
  const n = nestedSpec(baseOf(server));
  try {
    const before = fs.readFileSync(path.join(n.dir, n.specRel), 'utf8');
    const r = await runCli([n.specRel, '--dry-run', '--verbose', '--playwright-config', n.configRel], n.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /input\[type="email"\]/);
    assert.equal(fs.readFileSync(path.join(n.dir, n.specRel), 'utf8'), before);
    const children = r.stderr.split('\n').filter((l) => l.startsWith('[verbose] child:'));
    assert.ok(children.length >= 1, r.stderr);
    for (const c of children) {
      assert.ok(c.includes(`--config ${n.configRel}`), c);
      assert.match(c, /--output \S*qa-core-heal-out-/);
    }
  } finally { server.close(); rm(n.dir); }
});

test('an explicit --playwright-config that is refused fails the run', async () => {
  const n = nestedSpec('http://127.0.0.1:9');
  try {
    const rel = await runCli([n.specRel, '--dry-run', '--playwright-config', '../outside.ts'], n.dir);
    assert.equal(rel.status, 1);
    assert.match(rel.stderr, /Refused --playwright-config \.\.\/outside\.ts: it is absolute or it contains \.\./);
    assert.doesNotMatch(rel.stderr, /--config \.\.\/outside/);

    const absPath = path.join(n.dir, n.configRel);
    const abs = await runCli([n.specRel, '--dry-run', '--verbose', '--playwright-config', absPath], n.dir);
    assert.equal(abs.status, 1);
    assert.match(abs.stderr, new RegExp(`Refused --playwright-config ${absPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: it is absolute or it contains \\.\\.`));

    const missing = await runCli([n.specRel, '--playwright-config', 'no-such.config.ts'], n.dir);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Refused --playwright-config no-such\.config\.ts: the file is missing\./);
  } finally { rm(n.dir); }
});

test('--playwright-config is refused together with --findings', async () => {
  const r = await runCli(['--findings', 'f.json', '--results', 'r.json', '--playwright-config', 'playwright.config.ts'], repoRoot);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--playwright-config is for a spec run\. A findings file uses project\.configPath\./);
});
