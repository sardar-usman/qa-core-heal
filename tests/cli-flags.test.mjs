import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 0.2.2: the CLI flag surface. Hard constraints pinned here: zero-flag
 * output is byte-identical to the pre-flag CLI (snapshots below were
 * captured from it), --json carries the schemaVersion-1 contract, and
 * --dry-run never touches sources.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

function startServer(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const runCli = (args, cwd, env) => new Promise((resolve) => {
  // process.execPath, not 'node': tests that empty PATH must still spawn.
  const child = spawn(process.execPath, [cliJs, ...args], { cwd, env: env ? { ...process.env, ...env } : undefined });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

/** Temp project with its own package.json (never inherit the repo's). */
function makeProject(base, specSource) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, retries: 0, timeout: 8000,
  expect: { timeout: 1500 },
  use: { baseURL: '${base}', actionTimeout: 1500 },
  reporter: [['line']],
});
`);
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), specSource);
  return dir;
}

const HEALABLE_PAGE = '<html><body><label>Mail <input type="email" name="email" id="mail-x9" /></label></body></html>';
const HEALABLE_SPEC = `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
`;
const REFUSAL_PAGE = '<html><body><h1>Home</h1></body></html>';
const REFUSAL_SPEC = `import { test } from '@playwright/test';
test('clicks flux', async ({ page }) => {
  await page.goto('/');
  await page.locator('#flux-capacitor-zz').click();
});
`;
const PASSING_PAGE = '<html><body><h1>Home</h1><p id="status">Ready</p></body></html>';
const PASSING_SPEC = `import { test, expect } from '@playwright/test';
test('shows home', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
});
`;

const SCHEMA_KEYS = ['spec', 'testTitle', 'classification', 'message', 'healApplied', 'before', 'after', 'verified'];
function assertVerdictShape(v) {
  for (const k of SCHEMA_KEYS) assert.ok(k in v, `verdict missing ${k}: ${JSON.stringify(v)}`);
  assert.ok(['locator', 'non-locator'].includes(v.classification));
}
function assertSummaryShape(s) {
  for (const k of ['heals', 'refusals', 'nonLocator', 'errors']) {
    assert.equal(typeof s[k], 'number', `summary.${k}`);
  }
}

test('--help prints usage, all flags, and the --yes scope note; exits 0', async () => {
  const r = await runCli(['--help'], repoRoot);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /qa-core-heal tests\/checkout\.spec\.ts --dry-run/); // example
  for (const flag of ['--scan', '--dry-run', '--apply', '--yes', '--json', '--output', '--verbose', '--debug',
    '--config', '--base-url', '--project', '--route', '--storage-state', '--auth-setup', '--max-heals',
    '--verify', '--no-trace', '--audit-log', '--no-color', '--settle-ms']) {
    assert.ok(r.stdout.includes(flag), `help must list ${flag}`);
  }
  assert.match(r.stdout, /EVIDENCE-BASED HEALS ONLY/);
  assert.match(r.stdout, /--accept-suggestions/);
  const short = await runCli(['-h'], repoRoot);
  assert.equal(short.stdout, r.stdout);
});

test('--version and -v print the package.json version; exit 0', async () => {
  for (const flag of ['--version', '-v']) {
    const r = await runCli([flag], repoRoot);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkgVersion);
  }
});

test('an unknown flag errors with a help hint', async () => {
  const r = await runCli(['--frobnicate'], repoRoot);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown option '--frobnicate'/);
  assert.match(r.stderr, /--help/);
});

test('zero-flag runs produce the pre-flag output, byte-identical (snapshot)', async () => {
  const server = await startServer(PASSING_PAGE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = makeProject(base, PASSING_SPEC.replace("'/'", `'${base}/'`));
  fs.writeFileSync(path.join(dir, 'tests/pass.spec.ts'), PASSING_SPEC);
  fs.writeFileSync(path.join(dir, 'tests/broken.spec.ts'), REFUSAL_SPEC);
  fs.rmSync(path.join(dir, 'tests/a.spec.ts'));
  try {
    const norm = (s) => s.replaceAll(base, 'http://127.0.0.1:PORT');
    const a = await runCli(['tests/pass.spec.ts'], dir);
    assert.equal(a.status, 0);
    assert.equal(norm(a.stdout),
      '▸ Running tests/pass.spec.ts to find failures\nAll tests passing. Nothing to heal.\n');
    // The server hosts PASSING_PAGE (no flux element): the broken spec's
    // refusal output, exactly as the pre-flag CLI printed it.
    const b = await runCli(['tests/broken.spec.ts'], dir);
    assert.equal(b.status, 0);
    assert.equal(norm(b.stdout),
      '▸ Running tests/broken.spec.ts to find failures\n  1 of 1 test(s) failing\n\n'
      + "  → clicks flux — locator failure: locator('#flux-capacitor-zz')  (page: http://127.0.0.1:PORT/)\n\n"
      + '▸ Probing 1 failing locator(s) on their failure page(s)\n'
      + '  · scanned 1 locator(s) across 1 file(s)\n'
      + '  · opened http://127.0.0.1:PORT/\n\n'
      + '  tests/broken.spec.ts:\n'
      + "    → broken: page.locator('#flux-capacitor-zz')\n"
      + "    ✗ unhealable: page.locator('#flux-capacitor-zz')\n"
      + '        not found on route /: no matching or similar element on the probed page. The element may have been removed, renamed beyond recognition, or may only appear after user actions.\n\n'
      + '  0 intact · 0 healed · 1 unhealable (of 1 scanned)\n\n'
      + 'Nothing to heal. No files written.\n'
      + 'Done. 0 intact · 0 healed · 1 refused (1 failing locator(s) probed).\n');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run prints the diff, states its contract, and leaves sources byte-identical', async () => {
  const server = await startServer(HEALABLE_PAGE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = makeProject(base, HEALABLE_SPEC);
  const specPath = path.join(dir, 'tests/a.spec.ts');
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(specPath)).digest('hex');
  try {
    const r = await runCli(['tests/a.spec.ts', '--dry-run'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /- page\.locator\('#email-7d21ac'\)/);
    // 0.3.2: the heal names its target (input[type="email"]) — the old
    // nameless getByRole("textbox") is refused by the less-identity rule.
    assert.match(r.stdout, /\+ page\.locator\("input\[type=\\"email\\"\]"\)/);
    assert.match(r.stdout, /dry run: no files changed, heal not verified/);
    const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(specPath)).digest('hex');
    assert.equal(hashAfter, hashBefore);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--yes is accepted and auto-approves an evidence-based heal', async () => {
  const server = await startServer(HEALABLE_PAGE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = makeProject(base, HEALABLE_SPEC);
  try {
    const r = await runCli(['tests/a.spec.ts', '--yes', '--no-verify'], dir);
    assert.equal(r.status, 0);
    assert.match(fs.readFileSync(path.join(dir, 'tests/a.spec.ts'), 'utf8'), /input\[type=\\"email\\"\]/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--json: schemaVersion 1 on a heal and on a refusal', async () => {
  const server = await startServer(HEALABLE_PAGE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = makeProject(base, `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
test('clicks flux', async ({ page }) => {
  await page.goto('/');
  await page.locator('#flux-capacitor-zz').click();
});
`);
  try {
    const r = await runCli(['tests/a.spec.ts', '--json', '-y', '--no-verify'], dir);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.schemaVersion, 1);
    assert.ok(Array.isArray(payload.verdicts));
    assert.equal(payload.verdicts.length, 2);
    for (const v of payload.verdicts) assertVerdictShape(v);
    assertSummaryShape(payload.summary);
    const healed = payload.verdicts.find((v) => v.healApplied);
    assert.ok(healed, JSON.stringify(payload.verdicts));
    assert.equal(healed.testTitle, 'fills mail');
    assert.match(healed.before, /#email-7d21ac/);
    assert.match(healed.after, /input\[type=\\?"email\\?"\]/);
    const refused = payload.verdicts.find((v) => !v.healApplied);
    assert.equal(refused.after, null);
    assert.match(refused.message, /not found on route/);
    assert.equal(payload.summary.heals, 1);
    assert.equal(payload.summary.refusals, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--json: a forced run failure emits valid JSON with the failure story', async () => {
  // Outside the repo (no upward playwright resolution) + empty PATH.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "no-pw", "private": true }');
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), 'export {};\n');
    const r = await runCli(['tests/a.spec.ts', '--json'], dir, { PATH: '', Path: '' });
    assert.equal(r.status, 1);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.schemaVersion, 1);
    assert.match(payload.error, /Could not run the Playwright tests/);
    assert.match(payload.error, /command: npx playwright test/);
    assert.match(payload.error, /ENOENT/);
    assert.deepEqual(payload.verdicts, []);
    assert.equal(payload.summary.errors, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--verbose prints the child command; --debug adds raw child output', async () => {
  const server = await startServer(PASSING_PAGE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = makeProject(base, PASSING_SPEC);
  try {
    const v = await runCli(['tests/a.spec.ts', '--verbose'], dir);
    assert.equal(v.status, 0);
    assert.match(v.stderr, /\[verbose\] child: .*cli\.js test /);
    // Verdict lines are untouched: stdout identical to a plain run.
    const plain = await runCli(['tests/a.spec.ts'], dir);
    assert.equal(v.stdout, plain.stdout);
    const d = await runCli(['tests/a.spec.ts', '--debug'], dir);
    assert.match(d.stderr, /\[verbose\] child: /);
    assert.match(d.stderr, /\[debug\] child stdout:/);
    assert.equal(d.stdout, plain.stdout);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--config errors with the full failure story when the file is missing or invalid', async () => {
  const missing = await runCli(['tests/a.spec.ts', '--config', 'nope.json'], repoRoot);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Config file not found: .*nope\.json/);
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    const bad = await runCli(['tests/a.spec.ts', '--config', path.join(dir, 'bad.json')], repoRoot);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Could not parse .*bad\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--output writes the human report to a file; stdout unchanged', async () => {
  const server = await startServer(PASSING_PAGE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = makeProject(base, PASSING_SPEC);
  const outFile = path.join(dir, 'report.txt');
  try {
    const r = await runCli(['tests/a.spec.ts', '--output', outFile], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /All tests passing\. Nothing to heal\./);
    const written = fs.readFileSync(outFile, 'utf8');
    assert.match(written, /All tests passing\. Nothing to heal\./);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-color and NO_COLOR are accepted; output is unchanged', async () => {
  const server = await startServer(PASSING_PAGE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = makeProject(base, PASSING_SPEC);
  try {
    const plain = await runCli(['tests/a.spec.ts'], dir);
    const flag = await runCli(['tests/a.spec.ts', '--no-color'], dir);
    const env = await runCli(['tests/a.spec.ts'], dir, { NO_COLOR: '1' });
    assert.equal(flag.status, 0);
    assert.equal(flag.stdout, plain.stdout);
    assert.equal(env.stdout, plain.stdout);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
