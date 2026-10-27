import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { baseOf, makeProject, pkg, rm, runCli, startServer, repoRoot } from './helpers/contract.mjs';

/**
 * 0.4.0 must leave every 0.3.x command and flag as it was. These tests pin
 * the surface that existed in 0.3.5.
 */

const OLD_FLAGS = [
  '--help', '--version', '--scan', '--dry-run', '--apply', '--yes', '--json', '--output', '--verbose', '--debug',
  '--config', '--base-url', '--project', '--route', '--storage-state', '--auth-setup', '--auth-setup-timeout',
  '--settle-ms', '--max-heals', '--verify', '--no-verify', '--no-trace', '--audit-log', '--no-color',
];

test('the help text still lists every 0.3.x flag, and the new flags', async () => {
  const r = await runCli(['--help'], repoRoot);
  assert.equal(r.status, 0);
  for (const f of [...OLD_FLAGS, '--test', '--findings', '--results', '--run-timeout']) {
    assert.ok(r.stdout.includes(f), `help lists ${f}`);
  }
  assert.match(r.stdout, /Exit codes: 0 success/);
});

test('--version and -v print the package version only', async () => {
  for (const flag of ['--version', '-v']) {
    const r = await runCli([flag], repoRoot);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkg.version);
  }
});

test('an unknown flag and a second positional are still exit 1', async () => {
  const flag = await runCli(['--no-such-flag'], repoRoot);
  assert.equal(flag.status, 1);
  const second = await runCli(['a.spec.ts', 'b.spec.ts'], repoRoot);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Unknown argument: b\.spec\.ts/);
  const both = await runCli(['a.spec.ts', '--dry-run', '--apply'], repoRoot);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /either --dry-run or --apply/);
});

test('the new flags are rejected when used alone or in the wrong place', async () => {
  const results = await runCli(['--results', 'out.json'], repoRoot);
  assert.equal(results.status, 1);
  assert.match(results.stderr, /--results only works together with --findings/);
  const findings = await runCli(['--findings', 'in.json'], repoRoot);
  assert.equal(findings.status, 1);
  assert.match(findings.stderr, /--findings needs --results/);
});

test('a classic --dry-run --json run keeps the 0.3.5 payload shape and changes no file', async () => {
  const server = await startServer('<html><body><label>Mail <input type="email" name="email" id="mail-x9" /></label></body></html>');
  const dir = makeProject(baseOf(server), {
    'tests/a.spec.ts': `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
`,
  });
  try {
    const before = fs.readFileSync(path.join(dir, 'tests/a.spec.ts'), 'utf8');
    const r = await runCli(['tests/a.spec.ts', '--json', '--dry-run'], dir);
    const out = JSON.parse(r.stdout);
    for (const key of ['schemaVersion', 'verdicts', 'summary']) assert.ok(key in out, `payload has ${key}`);
    assert.equal(out.schemaVersion, 1);
    assert.ok(!('findings' in out) && !('results' in out), 'no contract fields leak into the classic payload');
    assert.equal(fs.readFileSync(path.join(dir, 'tests/a.spec.ts'), 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(dir, 'heal-results.json')));
  } finally { server.close(); rm(dir); }
});

test('only the single word "capabilities" is the subcommand; a spec path with that name is not hijacked', async () => {
  const server = await startServer('<html><body></body></html>');
  const dir = makeProject(baseOf(server), {
    'tests/capabilities.spec.ts': `import { test } from '@playwright/test';
test('opens', async ({ page }) => { await page.goto('/'); });
`,
  });
  try {
    const r = await runCli(['tests/capabilities.spec.ts', '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('contract versions'));
    const caps = await runCli(['capabilities', '--json'], dir);
    assert.equal(caps.status, 0);
    assert.equal(JSON.parse(caps.stdout).tool.version, pkg.version);
  } finally { server.close(); rm(dir); }
});
