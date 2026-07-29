import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 0.2.2: cross-platform Playwright child runs. The internal run must not
 * assume POSIX: no bare `npx` (npx.cmd on Windows), no shell:true argv
 * mangling (cmd.exe turns a --grep "a|b" into a pipe), env via the spawn
 * options object. And a failed run must tell the whole story: command,
 * spawn error code, stderr tail.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { runPlaywrightCli, describeFailedRun, toCliFileFilter } = await import(path.join(repoRoot, 'dist', 'playwright-cli.js'));

test('the local @playwright/test CLI is resolved and run directly — no npx, no shell', () => {
  // The direct path must NEVER print the npx-fallback note.
  const errLines = [];
  const origErr = console.error;
  console.error = (...a) => { errLines.push(a.join(' ')); };
  let run;
  try {
    run = runPlaywrightCli(repoRoot, ['--version'], 1024 * 1024);
  } finally {
    console.error = origErr;
  }
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /\d+\.\d+/);
  // The command is our own node + the resolved cli.js, platform-neutral.
  assert.ok(run.command.includes(path.join('@playwright', 'test', 'cli.js')), run.command);
  assert.ok(!run.command.startsWith('npx'), run.command);
  assert.ok(!errLines.some((l) => l.includes('using npx fallback')), errLines.join('\n'));
});

test('a --grep pattern with a pipe survives verbatim (no shell parsing)', () => {
  // A scoped project (INSIDE the repo on purpose — the upward
  // node_modules walk finds the repo's Playwright) with two tests;
  // --list --grep "alpha one|beta two" must match BOTH: a shell would
  // split the argv at '|' and pipe into a program named "beta".
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'),
      "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
    fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('alpha one', async () => {});
test('beta two', async () => {});
test('gamma three', async () => {});
`);
    const run = runPlaywrightCli(dir, ['test', '--list', '--grep', 'alpha one|beta two'], 1024 * 1024);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('alpha one'), run.stdout);
    assert.ok(run.stdout.includes('beta two'), run.stdout);
    assert.ok(!run.stdout.includes('gamma three'), run.stdout);
    assert.doesNotMatch(run.stderr, /is not recognized|command not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The Windows field bug: file filters built with path.relative carry
// backslash separators on win32; Playwright matches filters against
// forward-slash paths as REGEX fragments, so "\1" in a path is a
// backreference and the filter can never match ("no tests" while a
// direct npx run finds 5).
test('toCliFileFilter: win32 paths become forward-slash, regex-safe filters', () => {
  const filter = toCliFileFilter('tests\\systematic\\1-dynamic-ids.spec.js');
  assert.equal(filter, 'tests/systematic/1-dynamic-ids\\.spec\\.js');
  // No separator backslashes survive: a backslash may only introduce a
  // regex escape of a special character, never precede an alphanumeric
  // (that is what turned "\1" into a backreference).
  assert.ok(!/\\[A-Za-z0-9]/.test(filter), filter);
  // POSIX paths pass through with only regex specials escaped.
  assert.equal(toCliFileFilter('tests/sub/c.spec.ts'), 'tests/sub/c\\.spec\\.ts');
  // Regex-significant path characters (Next.js-style dirs) are escaped.
  assert.equal(toCliFileFilter('tests/[id]/a.spec.ts'), 'tests/\\[id\\]/a\\.spec\\.ts');
  assert.equal(toCliFileFilter('tests/(group)/b.spec.ts'), 'tests/\\(group\\)/b\\.spec\\.ts');
});

test('bracket and paren dirs match through the escaped filter (raw filters match nothing)', () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'),
      "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
    for (const sub of ['tests/[id]', 'tests/(group)']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    const spec = "import { test } from '@playwright/test';\ntest('t', async () => {});\n";
    fs.writeFileSync(path.join(dir, 'tests/[id]/a.spec.ts'), spec);
    fs.writeFileSync(path.join(dir, 'tests/(group)/b.spec.ts'), spec);
    for (const p of ['tests/[id]/a.spec.ts', 'tests/(group)/b.spec.ts']) {
      const raw = runPlaywrightCli(dir, ['test', '--list', p], 1024 * 1024);
      assert.match(raw.stdout, /Total: 0 tests/, `raw filter must demonstrate the breakage for ${p}`);
      const escaped = runPlaywrightCli(dir, ['test', '--list', toCliFileFilter(p)], 1024 * 1024);
      assert.match(escaped.stdout, /Total: 1 test in 1 file/, `${p}: ${escaped.stdout}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('describeFailedRun names the command, the cause, and the stderr tail', () => {
  const enoent = Object.assign(new Error('spawnSync npx ENOENT'), { code: 'ENOENT' });
  const failed = describeFailedRun({
    status: null, stdout: '', stderr: '', command: 'npx playwright test a.spec.ts', error: enoent,
  });
  assert.ok(failed.includes('command: npx playwright test a.spec.ts'), failed);
  assert.ok(failed.includes('ENOENT'), failed);
  const exited = describeFailedRun({
    status: 1, stdout: '', stderr: 'line1\nline2\nError: config exploded', command: 'node cli.js test',
  });
  assert.ok(exited.includes('exit status 1'), exited);
  assert.ok(exited.includes('Error: config exploded'), exited);
});

test('a forced spawn failure surfaces command + error code through the CLI', () => {
  // A project with NO local playwright (resolution fails -> npx fallback)
  // and an empty PATH (npx cannot spawn): the CLI must die with the
  // command, the spawn code, and never the bare forbidden message. The
  // temp dir must live OUTSIDE this repo: Node's upward node_modules walk
  // would otherwise resolve the repo's own Playwright and run it for real.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "no-pw", "private": true }');
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), 'export {};\n');
    const run = spawnSync(process.execPath, [path.join(repoRoot, 'dist', 'cli.js'), 'tests/a.spec.ts'], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: '', Path: '' },
    });
    assert.notEqual(run.status, 0);
    const out = (run.stderr ?? '') + (run.stdout ?? '');
    assert.ok(out.includes('Could not run the Playwright tests'), out);
    assert.ok(out.includes('command: npx playwright test'), out);
    assert.ok(out.includes('ENOENT'), out);
    // The fallback path announces itself, exactly once.
    assert.ok(out.includes('using npx fallback: local Playwright CLI not resolved'), out);
    assert.equal(out.split('using npx fallback').length - 1, 1, out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
