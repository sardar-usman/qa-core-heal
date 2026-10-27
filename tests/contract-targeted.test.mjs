import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseOf, makeProject, rm, runCli, startServer } from './helpers/contract.mjs';

/**
 * 0.4.0: --test "<title>" runs exactly one test of one spec file. Test
 * bodies append their name to a counter file, so "exactly one ran" is
 * counted from the outside.
 */

const PAGE = '<html><body><label>Mail <input type="email" name="email" id="mail-x9" /></label><p id="status">Ready</p></body></html>';

const specWith = (counter, bodies) => `import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const log = (n: string) => fs.appendFileSync(${JSON.stringify(counter)}, n + '\\n');
${bodies}
`;

const FILLS = (title, locator = '#email-7d21ac') => `test(${JSON.stringify(title)}, async ({ page }) => {
  log(${JSON.stringify(title)});
  await page.goto('/');
  await page.locator('${locator}').fill('a@b.dev');
});
`;

const countOf = (counter) => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean) : []);

async function setup(bodies, { projects } = {}) {
  const server = await startServer(PAGE);
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-count-'));
  const counter = path.join(holder, 'count.log');
  const dir = makeProject(baseOf(server), { 'tests/a.spec.ts': specWith(counter, bodies) }, { projects });
  return {
    dir, counter,
    spec: () => fs.readFileSync(path.join(dir, 'tests/a.spec.ts'), 'utf8'),
    done: () => { server.close(); rm(dir); rm(holder); },
  };
}

const THREE = `${FILLS('fills mail')}${FILLS('fills mail twice')}
test('other test', async ({ page }) => {
  log('other test');
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Ready');
});
`;

test('--test runs exactly one test; the others in the file never run (counted)', async () => {
  const s = await setup(THREE);
  try {
    const r = await runCli(['tests/a.spec.ts', '--test', 'fills mail', '--dry-run'], s.dir);
    assert.deepEqual(countOf(s.counter), ['fills mail'], `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally { s.done(); }
});

test('a title that is part of another title runs only the exact one', async () => {
  const s = await setup(THREE);
  try {
    await runCli(['tests/a.spec.ts', '--test', 'fills mail twice', '--dry-run'], s.dir);
    assert.deepEqual(countOf(s.counter), ['fills mail twice']);
  } finally { s.done(); }
});

test('a test that passes runs once and nothing is changed', async () => {
  const s = await setup(THREE);
  try {
    const before = s.spec();
    const r = await runCli(['tests/a.spec.ts', '--test', 'other test', '--dry-run'], s.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(countOf(s.counter), ['other test']);
    assert.equal(s.spec(), before);
  } finally { s.done(); }
});

test('a missing title is exit 1 and nothing runs', async () => {
  const s = await setup(THREE);
  try {
    const r = await runCli(['tests/a.spec.ts', '--test', 'no such test', '--dry-run'], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No test titled "no such test"/);
    assert.match(r.stderr, /Nothing was run/);
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

test('a title in two projects is ambiguous until --project is given', async () => {
  const s = await setup(FILLS('fills mail'), { projects: [{ name: 'chromium' }, { name: 'second' }] });
  try {
    const r = await runCli(['tests/a.spec.ts', '--test', 'fills mail', '--dry-run'], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /2 tests match/);
    assert.match(r.stderr, /--project/);
    assert.deepEqual(countOf(s.counter), []);
    await runCli(['tests/a.spec.ts', '--test', 'fills mail', '--project', 'second', '--dry-run'], s.dir);
    assert.deepEqual(countOf(s.counter), ['fills mail']);
  } finally { s.done(); }
});

test('the Describe > title form selects one test inside a describe block', async () => {
  const s = await setup(`test.describe('Form', () => {\n${FILLS('fills mail')}${FILLS('fills mail twice')}});\n`);
  try {
    await runCli(['tests/a.spec.ts', '--test', 'Form › fills mail', '--dry-run'], s.dir);
    assert.deepEqual(countOf(s.counter), ['fills mail']);
  } finally { s.done(); }
});

test('--test needs exactly one spec file path', async () => {
  const s = await setup(THREE);
  try {
    const none = await runCli(['--test', 'fills mail', '--dry-run'], s.dir);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /Usage: qa-core-heal/);
    const dirTarget = await runCli(['tests', '--test', 'fills mail', '--dry-run'], s.dir);
    assert.equal(dirTarget.status, 1);
    assert.match(dirTarget.stderr, /exactly one spec file/);
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

test('--test is checked together with the other flags', async () => {
  const s = await setup(THREE);
  try {
    const scan = await runCli(['tests/a.spec.ts', '--test', 'fills mail', '--scan'], s.dir);
    assert.equal(scan.status, 1);
    assert.match(scan.stderr, /--test cannot be combined with --scan/);
    const empty = await runCli(['tests/a.spec.ts', '--test', ' '], s.dir);
    assert.equal(empty.status, 1);
    const lone = await runCli(['tests/a.spec.ts', '--run-timeout', '5', '--dry-run'], s.dir);
    assert.equal(lone.status, 1);
    assert.match(lone.stderr, /--run-timeout works with --findings or --test/);
    for (const bad of ['0', '-3', 'abc']) {
      const r = await runCli(['tests/a.spec.ts', '--test', 'fills mail', `--run-timeout=${bad}`], s.dir);
      assert.equal(r.status, 1, `--run-timeout ${bad}`);
      assert.match(r.stderr, /positive number of seconds/);
    }
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

test('--test with --apply --yes heals only that test and re-runs only that test', async () => {
  const s = await setup(`${FILLS('fills mail')}${FILLS('fills other', '#email-zz91bb')}`);
  try {
    const r = await runCli(['tests/a.spec.ts', '--test', 'fills mail', '--apply', '--yes'], s.dir);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const src = s.spec();
    assert.ok(!src.includes('#email-7d21ac'), 'the targeted locator was healed');
    assert.ok(src.includes('#email-zz91bb'), 'the other test is untouched');
    const ran = countOf(s.counter);
    assert.ok(ran.length >= 2, 'the test ran before and after the heal');
    assert.ok(ran.every((n) => n === 'fills mail'), `only the targeted test ran: ${ran.join(', ')}`);
  } finally { s.done(); }
});
