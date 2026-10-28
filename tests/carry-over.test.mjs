import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  baseOf, finding, makeProject, readJsonFile, rm, runCli, startServer, writeFindings,
} from './helpers/contract.mjs';

test('absolute in-project paths and paths with .. are refused as outside', async () => {
  const dir = makeProject('http://127.0.0.1:9', {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('inside', async () => {});\n",
  });
  const spec = path.join(dir, 'tests', 'a.spec.ts');
  try {
    const before = fs.readFileSync(spec, 'utf8');
    const absolute = spec.split(path.sep).join('/');
    const dotdot = 'tests/../tests/a.spec.ts';
    const missingDotdot = `tests/../../${path.basename(dir)}/tests/nope.spec.ts`;
    const findingsPath = writeFindings(dir, [
      finding({ file: absolute }),
      finding({ file: dotdot }),
      finding({ file: missingDotdot }),
    ], null, 'f.json');
    const resultsPath = path.join(dir, 'r.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    const results = readJsonFile(resultsPath).results;
    assert.equal(results.length, 3);
    for (const e of results) {
      assert.equal(e.status, 'refused');
      assert.equal(e.refusal.code, 'spec-not-found');
      assert.match(e.explanation, /outside the project/);
      assert.doesNotMatch(e.explanation, /not found inside the project folder/);
    }
    assert.equal(fs.readFileSync(spec, 'utf8'), before);
  } finally { rm(dir); }
});

test('--test reports a timeout during the re-run and restores the spec', { timeout: 90000 }, async () => {
  const server = await startServer('<html><body><label>Mail <input type="email" name="email" id="mail-x9" /></label></body></html>');
  const dir = makeProject(baseOf(server), {
    'tests/a.spec.ts': `import { test } from '@playwright/test';
import fs from 'node:fs';
test('fills mail', async ({ page }) => {
  const n = Number(fs.existsSync('count') ? fs.readFileSync('count', 'utf8') : '0') + 1;
  fs.writeFileSync('count', String(n));
  await page.goto('/');
  if (n === 1) await page.locator('#email-7d21ac').fill('a@b.dev');
  else await new Promise((r) => setTimeout(r, 60000));
});
`,
  }, { timeout: 90000 });
  const spec = path.join(dir, 'tests/a.spec.ts');
  const original = fs.readFileSync(spec, 'utf8');
  try {
    const r = await runCli(['tests/a.spec.ts', '--test', 'fills mail', '--yes', '--run-timeout', '20'], dir);
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /The run timeout was reached during the re-run, so the heal was reverted/);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /re-run still failing after heal/);
    assert.equal(fs.readFileSync(spec, 'utf8'), original);
  } finally { server.close(); rm(dir); }
});

test('a finding that never started after the budget ran out has its own timeout message', { timeout: 90000 }, async () => {
  const server = await startServer('<html><body><input id="mail-x9" /></body></html>');
  const dir = makeProject(baseOf(server), {
    'tests/a.spec.ts': `import { test } from '@playwright/test';
test('hangs', async ({ page }) => {
  await page.goto('/');
  await new Promise((r) => setTimeout(r, 60000));
});
test('later', async () => {});
`,
  }, { timeout: 90000 });
  try {
    const findingsPath = writeFindings(dir, [
      finding({ titlePath: ['hangs'], file: 'tests/a.spec.ts' }),
      finding({ titlePath: ['later'], file: 'tests/a.spec.ts' }),
    ], baseOf(server));
    const resultsPath = path.join(dir, 'r.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--run-timeout', '12', '--shadow-runs', '1'], dir);
    assert.equal(r.status, 0, r.stderr);
    const results = readJsonFile(resultsPath).results;
    assert.equal(results[0].refusal.code, 'timeout');
    assert.match(results[0].explanation, /The test run timed out before it finished/);
    assert.equal(results[1].refusal.code, 'timeout');
    assert.match(results[1].explanation, /The run timeout was used up before this finding started\. No test was run/);
  } finally { server.close(); rm(dir); }
});
