import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertValid, baseOf, finding, findingsDoc, makeProject, pkg, readJsonFile, rm, runCli, startServer,
  validateFindings, validateResults, writeFindings,
} from './helpers/contract.mjs';
import { chromiumDotDirs, chromiumProfiles, installSuiteTmp, removeNewChromiumProfiles, sweepTemps } from './helpers/temps.mjs';

installSuiteTmp();

const profilesAtStart = chromiumProfiles();
after(() => {
  sweepTemps();
  removeNewChromiumProfiles(profilesAtStart);
});

/**
 * 0.4.0: --findings <file> --results <file>. Every test builds a small
 * Playwright project, serves a local page, and runs the built CLI. Test
 * bodies append their name to a counter file, so "exactly one test ran" and
 * "no test ran" are counted, not assumed.
 */

const HEALABLE_PAGE = '<html><body><label>Mail <input type="email" name="email" id="mail-x9" /></label><p id="status">Ready</p></body></html>';

const specWith = (counter, bodies) => `import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const log = (n: string) => fs.appendFileSync(${JSON.stringify(counter)}, n + '\\n');
${bodies}
`;

const HEALABLE_BODY = `test('fills mail', async ({ page }) => {
  log('fills mail');
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});`;

const countOf = (counter) => (fs.existsSync(counter)
  ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean)
  : []);

/** A project, a server, a counter, and a cleanup. */
async function setup(bodies, { html = HEALABLE_PAGE, projects, timeout } = {}) {
  const server = await startServer(html);
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-count-'));
  const counter = path.join(holder, 'count.log');
  const dir = makeProject(baseOf(server), { 'tests/a.spec.ts': specWith(counter, bodies) }, { projects, timeout });
  return {
    server, dir, counter,
    spec: () => fs.readFileSync(path.join(dir, 'tests/a.spec.ts'), 'utf8'),
    done: () => { server.close(); rm(dir); rm(holder); },
  };
}

/** Run the CLI in findings mode and load the results file. */
async function runFindings(s, findings, extra = ['--dry-run'], { baseUrl = baseOf(s.server), shadowRuns = 1 } = {}) {
  const findingsPath = writeFindings(s.dir, findings, baseUrl);
  const resultsPath = path.join(s.dir, 'heal-results.json');
  const args = ['--findings', findingsPath, '--results', resultsPath, ...extra];
  if (shadowRuns != null && !extra.includes('--shadow-runs')) args.push('--shadow-runs', String(shadowRuns));
  const r = await runCli(args, s.dir);
  const results = fs.existsSync(resultsPath) ? readJsonFile(resultsPath) : null;
  if (results) assertValid(validateResults, results, 'results file');
  return { r, results, findingsPath, resultsPath };
}

const only = (results) => {
  assert.equal(results.results.length, 1);
  return results.results[0];
};

test('the findings fixtures used here are valid against the frozen findings schema', () => {
  assertValid(validateFindings, findingsDoc([finding()]), 'findings');
});

/* ───────────────────────── reading the findings file ───────────────────────── */

test('an unknown findings schema version exits 2 with a clear message and writes no results', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const doc = findingsDoc([finding()]);
    doc.schemaVersion = 2;
    const f = path.join(s.dir, 'f.json');
    fs.writeFileSync(f, JSON.stringify(doc));
    const out = path.join(s.dir, 'r.json');
    const r = await runCli(['--findings', f, '--results', out], s.dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unsupported findings schema version 2\./);
    assert.match(r.stderr, new RegExp(`qa-core-heal ${pkg.version.replace(/\./g, '\\.')} reads findings schema version 1`));
    assert.equal(fs.existsSync(out), false);
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

test('a findings file that is not valid is exit 1 and names the problem', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const out = path.join(s.dir, 'r.json');
    const bad = (name, text) => {
      const f = path.join(s.dir, name);
      fs.writeFileSync(f, text);
      return runCli(['--findings', f, '--results', out], s.dir);
    };
    let r = await bad('a.json', '{ not json');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not valid JSON/);

    r = await bad('b.json', JSON.stringify({ schema: 'something-else', schemaVersion: 1, findings: [] }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a qa-core heal findings file/);

    const dup = findingsDoc([finding({ findingId: 'aaaaaaaaaaaa' }), finding({ findingId: 'aaaaaaaaaaaa' })]);
    r = await bad('c.json', JSON.stringify(dup));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /findingId aaaaaaaaaaaa appears more than once/);

    const badMode = findingsDoc([finding()]);
    badMode.findings[0].handoff.mode = 'maybe';
    r = await bad('d.json', JSON.stringify(badMode));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /handoff\.mode must be one of locator, suggest, none/);

    r = await runCli(['--findings', path.join(s.dir, 'missing.json'), '--results', out], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Could not read the findings file/);
    assert.equal(fs.existsSync(out), false);
  } finally { s.done(); }
});

test('the findings flags are checked together', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const f = writeFindings(s.dir, [finding()]);
    const out = path.join(s.dir, 'r.json');
    let r = await runCli(['--findings', f], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--findings needs --results/);
    r = await runCli(['--results', out], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--results only works together with --findings/);
    r = await runCli(['tests/a.spec.ts', '--findings', f, '--results', out], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Do not pass a spec path/);
    r = await runCli(['--findings', f, '--results', out, '--scan'], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot be combined with --scan/);
    r = await runCli(['--findings', f, '--results', out, '--test', 'x'], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot be combined with --test/);
    r = await runCli(['--findings', f, '--results', out, '--dry-run', '--apply'], s.dir);
    assert.equal(r.status, 1);
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

/* ───────────────────────── the handoff gate ───────────────────────── */

test('refusal ineligible-handoff: a handoff of none is refused and no test runs', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const { r, results } = await runFindings(s, [
      finding({ mode: 'none', verdict: 'likely-real-bug', primaryRuleId: 'ASSERT-REAL' }),
    ]);
    assert.equal(r.status, 0);
    const e = only(results);
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'ineligible-handoff');
    assert.equal(e.verification.performed, false);
    assert.equal(e.verification.outcome, 'not-run');
    assert.deepEqual(e.changes, []);
    assert.equal(e.patchFile, null);
    assert.deepEqual(countOf(s.counter), [], 'no test may run');
    assert.equal(s.spec().includes('#email-7d21ac'), true);
  } finally { s.done(); }
});

test('refusal ineligible-handoff: heal does not trust the mode alone', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    // These documents would not pass the findings schema. Heal must still refuse them.
    const real = finding({ verdict: 'likely-real-bug' });
    const env = finding({ verdict: 'environment-issue' });
    const gate = finding({ handoff: { mode: 'locator', reason: 'x', gates: [{ name: 'repeatable-failure', passed: false }] } });
    const { r, results } = await runFindings(s, [real, env, gate]);
    assert.equal(r.status, 0);
    assert.equal(results.results.length, 3);
    for (const e of results.results) {
      assert.equal(e.status, 'refused');
      assert.equal(e.refusal.code, 'ineligible-handoff');
    }
    assert.match(results.results[0].refusal.message, /likely-real-bug/);
    assert.match(results.results[1].refusal.message, /environment-issue/);
    assert.match(results.results[2].refusal.message, /repeatable-failure/);
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

/* ───────────────────────── the proposal path ───────────────────────── */

test('a locator handoff gives a verified proposal, writes no source file, and leaves no scratch copy', async () => {
  const body = `${HEALABLE_BODY}
test('other one', async ({ page }) => { log('other one'); await page.goto('/'); });
test('third one', async ({ page }) => { log('third one'); await page.goto('/'); });`;
  const s = await setup(body);
  try {
    const before = s.spec();
    const f = finding();
    const { r, results, findingsPath } = await runFindings(s, [f]);
    assert.equal(r.status, 0, r.stderr);
    const e = only(results);
    assert.equal(e.findingId, f.findingId);
    assert.equal(e.testId, f.testId);
    assert.equal(e.status, 'proposed');
    assert.equal(e.strategy, 'locator-heal');
    assert.equal(e.refusal, null);
    assert.equal(e.verification.performed, true);
    assert.equal(e.verification.outcome, 'passed');
    assert.equal(e.verification.runs, 1);
    assert.equal(e.changes.length, 1);
    assert.equal(e.changes[0].file, 'tests/a.spec.ts');
    assert.equal(e.changes[0].before, "page.locator('#email-7d21ac')");

    assert.equal(s.spec(), before, 'a proposal must not touch the source file');
    // One baseline run and one run in the scratch copy, both of the one target test.
    assert.deepEqual(countOf(s.counter), ['fills mail', 'fills mail']);
    const left = fs.readdirSync(path.join(s.dir, '.qa-core')).filter((n) => n.startsWith('scratch-'));
    assert.deepEqual(left, [], 'the scratch copy must be deleted');

    assert.equal(results.mode, 'dry-run');
    assert.equal(results.tool.name, 'qa-core-heal');
    assert.equal(results.tool.version, pkg.version);
    assert.equal(results.input.findingCount, 1);
    assert.equal(results.input.findingsSha256, crypto.createHash('sha256').update(fs.readFileSync(findingsPath)).digest('hex'));
    assert.equal(results.ai.enabled, false);
    assert.equal(e.ai.used, false);

    // The patch file is a real unified diff that applies to the untouched spec.
    const patch = path.join(s.dir, e.patchFile);
    assert.equal(fs.existsSync(patch), true);
    const check = spawnSync('git', ['apply', '--check', '-p1', patch], { cwd: s.dir, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    spawnSync('git', ['apply', '-p1', patch], { cwd: s.dir });
    assert.equal(s.spec().includes(e.changes[0].after), true);
    assert.equal(s.spec().includes('#email-7d21ac'), false);
  } finally { s.done(); }
});

test('a SEL-ZERO finding is proposed with the review level review-carefully', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const f = finding({
      primaryRuleId: 'SEL-ZERO',
      causes: [{ cause: 'selectors', ruleIds: ['SEL-ZERO'], confidence: 'high', evidence: ['element(s) not found'] }],
    });
    const { results } = await runFindings(s, [f]);
    const e = only(results);
    assert.equal(e.status, 'proposed');
    assert.equal(e.reviewLevel, 'review-carefully');
    assert.match(e.explanation, /Review it carefully/);
  } finally { s.done(); }
});

test('--apply without consent keeps the proposal and writes nothing; --apply --yes applies it', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const before = s.spec();
    // No TTY and no --yes: the prompt is never shown and the answer is no.
    let run = await runFindings(s, [finding()], ['--apply']);
    assert.equal(run.r.status, 0);
    assert.equal(run.results.mode, 'apply');
    assert.equal(only(run.results).status, 'proposed');
    assert.equal(s.spec(), before);

    run = await runFindings(s, [finding()], ['--apply', '--yes']);
    assert.equal(run.r.status, 0, run.r.stderr);
    const e = only(run.results);
    assert.equal(e.status, 'applied');
    assert.equal(e.verification.outcome, 'passed');
    assert.equal(s.spec().includes(e.changes[0].after), true);
    assert.equal(s.spec().includes('#email-7d21ac'), false);
    assert.match(e.explanation, /applied because --apply was given/);
  } finally { s.done(); }
});

test('suggest and dry-run never apply: the default is a dry run', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const before = s.spec();
    const { r, results } = await runFindings(s, [finding()], []);
    assert.equal(r.status, 0);
    assert.equal(results.mode, 'dry-run');
    assert.equal(only(results).status, 'proposed');
    assert.equal(s.spec(), before);
  } finally { s.done(); }
});

test('--json prints the same results document on stdout', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const { r, results } = await runFindings(s, [finding({ mode: 'none', verdict: 'likely-real-bug' })], ['--dry-run', '--json']);
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), results);
  } finally { s.done(); }
});

test('several findings give one result each, in the same order, and each runs only its own test', async () => {
  const body = `${HEALABLE_BODY}
test('checks status', async ({ page }) => {
  log('checks status');
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Never');
});
test('untouched', async ({ page }) => { log('untouched'); await page.goto('/'); });`;
  const s = await setup(body);
  try {
    const a = finding();
    const b = finding({ titlePath: ['checks status'], primaryRuleId: 'TIM-WAIT' });
    const c = finding({ mode: 'none', titlePath: ['untouched'], verdict: 'likely-real-bug' });
    const { r, results } = await runFindings(s, [b, a, c]);
    assert.equal(r.status, 0);
    assert.deepEqual(results.results.map((e) => e.findingId), [b.findingId, a.findingId, c.findingId]);
    assert.deepEqual(results.results.map((e) => e.status), ['not-locator', 'proposed', 'refused']);
    assert.deepEqual(countOf(s.counter).sort(), ['checks status', 'fills mail', 'fills mail']);
  } finally { s.done(); }
});

/* ───────────────────────── outcomes without a proposal ───────────────────────── */

test('a failure that is not a locator problem is reported as not-locator, once, with no change', async () => {
  const s = await setup(`test('checks status', async ({ page }) => {
  log('checks status');
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('Never');
});
test('bystander', async ({ page }) => { log('bystander'); await page.goto('/'); });`);
  try {
    const { r, results } = await runFindings(s, [finding({ titlePath: ['checks status'], primaryRuleId: 'ASSERT-VALUE' })]);
    assert.equal(r.status, 0);
    const e = only(results);
    assert.equal(e.status, 'not-locator');
    assert.deepEqual(e.changes, []);
    assert.deepEqual(countOf(s.counter), ['checks status']);
  } finally { s.done(); }
});

test('a test that passes when heal runs it is nothing-to-heal, and is called weak evidence', async () => {
  const s = await setup(`test('passes', async ({ page }) => { log('passes'); await page.goto('/'); await expect(page.locator('#status')).toHaveText('Ready'); });`);
  try {
    const { results } = await runFindings(s, [finding({ titlePath: ['passes'] })]);
    const e = only(results);
    assert.equal(e.status, 'nothing-to-heal');
    assert.match(e.explanation, /weak evidence/);
    assert.deepEqual(countOf(s.counter), ['passes']);
  } finally { s.done(); }
});

test('a skipped test is an error entry, not a refusal, and the file is still written', async () => {
  const s = await setup(`test.skip('skipped one', async ({ page }) => { log('skipped one'); await page.goto('/'); });`);
  try {
    const { r, results } = await runFindings(s, [finding({ titlePath: ['skipped one'] })]);
    assert.equal(r.status, 0);
    assert.equal(only(results).status, 'error');
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

test('a suggest handoff is not run: SEL-STRICT is strict-needs-human, others are no-safe-pattern', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const strict = finding({ mode: 'suggest', primaryRuleId: 'SEL-STRICT' });
    const other = finding({ mode: 'suggest', primaryRuleId: 'TIM-SLOW-LOAD' });
    const { results } = await runFindings(s, [strict, other]);
    assert.equal(results.results[0].refusal.code, 'strict-needs-human');
    assert.equal(results.results[1].refusal.code, 'no-safe-pattern');
    for (const e of results.results) { assert.equal(e.status, 'refused'); assert.deepEqual(e.changes, []); }
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

/* ───────────────────────── one fixture per refusal code ───────────────────────── */

const FUZZY_PAGE = [
  '<html><body><h1>Inventory</h1>',
  '<label for="contact-email">Contact email</label><input id="contact-email" name="email" type="text" />',
  '<label for="backup-email">Backup email</label><input id="backup-email" name="email" type="text" />',
  '</body></html>',
].join('\n');

const refusalOf = async (bodies, opts, f, extra) => {
  const s = await setup(bodies, opts);
  try {
    const run = await runFindings(s, [f ?? finding()], extra);
    assert.equal(run.r.status, 0, run.r.stderr);
    const e = only(run.results);
    assert.equal(e.status, 'refused', e.explanation);
    assert.deepEqual(e.changes, []);
    assert.equal(e.patchFile, null);
    return { e, s, spec: s.spec(), count: countOf(s.counter) };
  } finally { s.done(); }
};

test('refusal ambiguous-match: two close candidates', async () => {
  const { e } = await refusalOf(
    `test('fills mail', async ({ page }) => { log('fills mail'); await page.goto('/'); await page.locator('#emai_l').fill('x@y.dev'); });`,
    { html: FUZZY_PAGE },
  );
  assert.equal(e.refusal.code, 'ambiguous-match');
});

test('refusal element-changed: the candidate is a different kind of element', async () => {
  const { e } = await refusalOf(
    `test('fills mail', async ({ page }) => { log('fills mail'); await page.goto('/'); await page.locator('#register-button').click(); });`,
    { html: '<html><body><nav><a href="/register" class="ico-register">Register</a></nav></body></html>' },
  );
  assert.equal(e.refusal.code, 'element-changed');
});

test('refusal strict-needs-human: several elements, identical by name', async () => {
  const { e } = await refusalOf(
    `test('fills mail', async ({ page }) => { log('fills mail'); await page.goto('/'); await page.locator('.add').click(); });`,
    { html: '<html><body><button class="add">Add to cart</button><button class="add">Add to cart</button></body></html>' },
  );
  assert.equal(e.refusal.code, 'strict-needs-human');
});

test('refusal possible-real-bug: the element is not on the page at all', async () => {
  const { e } = await refusalOf(
    `test('fills mail', async ({ page }) => { log('fills mail'); await page.goto('/'); await page.locator('#flux-capacitor-zz').click(); });`,
    { html: '<html><body><h1>Home</h1></body></html>' },
  );
  assert.equal(e.refusal.code, 'possible-real-bug');
});

test('refusal verification-failed: the new locator works but the test still fails in the scratch copy', async () => {
  const s = await setup(`test('fills mail', async ({ page }) => {
  log('fills mail');
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
  await expect(page.locator('#status')).toHaveText('Saved');
});`);
  try {
    const before = s.spec();
    const { r, results } = await runFindings(s, [finding()]);
    assert.equal(r.status, 0);
    const e = only(results);
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'verification-failed');
    assert.deepEqual(e.changes, [], 'a change that failed verification is never shown as a proposal');
    assert.equal(e.patchFile, null);
    assert.equal(s.spec(), before);
    assert.equal(fs.existsSync(path.join(s.dir, '.qa-core', 'heal', 'patches')), false);
    // Even with --apply --yes, nothing that failed verification is written.
    const again = await runFindings(s, [finding()], ['--apply', '--yes']);
    assert.equal(only(again.results).status, 'refused');
    assert.equal(s.spec(), before);
  } finally { s.done(); }
});

test('refusal no-safe-pattern: a locator built from a variable cannot be matched', async () => {
  const { e, count } = await refusalOf(
    `test('fills mail', async ({ page }) => { log('fills mail'); await page.goto('/'); const id = '#email-' + '7d21ac'; await page.locator(id).fill('a@b.dev'); });`,
  );
  assert.equal(e.refusal.code, 'no-safe-pattern');
  assert.deepEqual(count, ['fills mail']);
});

test('refusal navigation-or-network: a page.goto that cannot connect is not a test change', async () => {
  const { e, count } = await refusalOf(
    `test('fills mail', async ({ page }) => { log('fills mail'); await page.goto('http://127.0.0.1:1/'); });`,
  );
  assert.equal(e.refusal.code, 'navigation-or-network');
  assert.deepEqual(count, ['fills mail']);
});

test('refusal spec-not-found: a missing file, a missing test, and a path outside the project', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const gone = finding({ file: 'tests/missing.spec.ts' });
    const noTest = finding({ titlePath: ['no such test'] });
    const outside = finding({ file: '../outside.spec.ts' });
    const absolute = finding({ file: '/etc/hostname' });
    const { r, results } = await runFindings(s, [gone, noTest, outside, absolute]);
    assert.equal(r.status, 0);
    for (const e of results.results) {
      assert.equal(e.status, 'refused');
      assert.equal(e.refusal.code, 'spec-not-found');
    }
    assert.match(results.results[0].explanation, /not found inside the project folder/);
    assert.match(results.results[2].explanation, /outside the project/);
    assert.doesNotMatch(results.results[2].explanation, /symlink/);
    assert.match(results.results[3].explanation, /outside the project/);
    assert.deepEqual(countOf(s.counter), []);
  } finally { s.done(); }
});

test('a symlink that points outside the project says symlink', async () => {
  const s = await setup(HEALABLE_BODY);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-out-spec-'));
  fs.writeFileSync(path.join(outside, 'x.spec.ts'), 'export {};\n');
  try {
    fs.symlinkSync(path.join(outside, 'x.spec.ts'), path.join(s.dir, 'tests', 'out.spec.ts'));
    const { results } = await runFindings(s, [finding({ file: 'tests/out.spec.ts' })]);
    const e = only(results);
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'spec-not-found');
    assert.match(e.explanation, /symlink/);
    assert.match(e.explanation, /outside the project/);
  } finally {
    s.done();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('refusal timeout: a run that goes past --run-timeout is stopped', async () => {
  const profiles = chromiumProfiles();
  const dots = chromiumDotDirs();
  const s = await setup(`test('fills mail', async ({ page }) => { log('fills mail'); await new Promise((r) => setTimeout(r, 120000)); });`, { timeout: 200000 });
  try {
    const before = s.spec();
    const { r, results } = await runFindings(s, [finding()], ['--dry-run', '--run-timeout', '6', '--verbose']);
    assert.equal(r.status, 0, r.stderr);
    const e = only(results);
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'timeout');
    assert.equal(s.spec(), before);
    const outs = [...r.stderr.matchAll(/--output (\S*qa-core-heal-out-[^/\s]+)/g)].map((m) => m[1]);
    assert.ok(outs.length > 0, `expected a private output folder in verbose output:\n${r.stderr}`);
    for (const out of outs) assert.equal(fs.existsSync(out), false, out);
    removeNewChromiumProfiles(profiles);
    assert.deepEqual(chromiumProfiles().filter((p) => !profiles.includes(p)), [], 'no Chromium profile left by the timed out run');
    assert.deepEqual(chromiumDotDirs().filter((p) => !dots.includes(p)), [], 'no Chromium temp folder left by the timed out run');
    // The workers of the stopped run are stopped too. A worker has the project folder as its
    // working directory. /proc is read on Linux only; the check is skipped elsewhere.
    if (fs.existsSync('/proc/self/cwd')) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const real = fs.realpathSync(s.dir);
      const left = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => {
        try { return fs.readlinkSync(`/proc/${n}/cwd`).startsWith(real); } catch { return false; }
      });
      assert.deepEqual(left, [], 'no process of the timed out run is left');
    }
  } finally { s.done(); }
});

test('refusal ambiguous-match: a test that exists in two projects is not guessed, until --project picks one', async () => {
  const s = await setup(HEALABLE_BODY, { projects: [{ name: 'chromium' }, { name: 'second' }] });
  try {
    const f = finding({ project: '' });
    let run = await runFindings(s, [f]);
    let e = only(run.results);
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'ambiguous-match');
    assert.deepEqual(countOf(s.counter), []);

    run = await runFindings(s, [f], ['--dry-run', '--project', 'second']);
    e = only(run.results);
    assert.equal(e.status, 'proposed');
    assert.deepEqual(countOf(s.counter), ['fills mail', 'fills mail'], 'only the chosen project ran');
  } finally { s.done(); }
});

test('a test whose title contains regex characters and sits in a describe block runs exactly once', async () => {
  const s = await setup(`test.describe('Checkout (v2)', () => {
  test('pays [card] $5 + tax?', async ({ page }) => { log('pays'); await page.goto('/'); await page.locator('#email-7d21ac').fill('a'); });
  test('pays [card] $5 + tax? again', async ({ page }) => { log('again'); await page.goto('/'); });
});`);
  try {
    const f = finding({ titlePath: ['Checkout (v2)', 'pays [card] $5 + tax?'] });
    const { results } = await runFindings(s, [f]);
    assert.equal(only(results).status, 'proposed');
    assert.deepEqual(countOf(s.counter), ['pays', 'pays']);
  } finally { s.done(); }
});

test('a findings title path that starts with the project name still finds the test', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const f = finding({ titlePath: ['chromium', 'a.spec.ts', 'fills mail'] });
    const { results } = await runFindings(s, [f]);
    assert.equal(only(results).status, 'proposed');
  } finally { s.done(); }
});

test('every refusal code in the schema is a code this build knows', async () => {
  const schema = readJsonFile(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'schemas', 'heal-results.v1.schema.json'));
  const text = JSON.stringify(schema);
  const codes = ['ambiguous-match', 'element-changed', 'strict-needs-human', 'possible-real-bug', 'weakens-test',
    'verification-failed', 'baseline-not-reproduced', 'no-safe-pattern', 'ai-disabled', 'ai-invalid-output',
    'ineligible-handoff', 'navigation-or-network', 'spec-not-found', 'timeout'];
  for (const c of codes) assert.equal(text.includes(`"${c}"`), true, c);
  const { REFUSAL_CODES } = await import(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'contract.js'));
  assert.deepEqual([...REFUSAL_CODES].sort(), [...codes].sort());
});

test('the default is three shadow runs and every one must pass', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    const { r, results } = await runFindings(s, [finding()], ['--dry-run', '--verbose'], { shadowRuns: null });
    assert.equal(r.status, 0, r.stderr);
    const e = only(results);
    assert.equal(e.status, 'proposed', e.explanation);
    assert.equal(e.verification.runs, 3);
    assert.equal(e.verification.passed, 3);
    assert.equal(e.verification.failed, 0);
    const scratch = r.stderr.split('\n').filter((l) => l.startsWith('[verbose] child:') && /--output \S+\/scratch(?:\s|$)/.test(l));
    assert.equal(scratch.length, 3, r.stderr);
    assert.equal(countOf(s.counter).length, 4);
  } finally { s.done(); }
});

test('a later shadow run that fails stops the check and the change is not proposed', async () => {
  const s = await setup('PLACE');
  const body = `import { test } from '@playwright/test';
import fs from 'node:fs';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
  const n = fs.existsSync(${JSON.stringify(s.counter)}) ? Number(fs.readFileSync(${JSON.stringify(s.counter)}, 'utf8')) : 0;
  fs.writeFileSync(${JSON.stringify(s.counter)}, String(n + 1));
  if (n >= 1) throw new Error('second shadow run');
});
`;
  fs.writeFileSync(path.join(s.dir, 'tests/a.spec.ts'), body);
  try {
    const { r, results } = await runFindings(s, [finding()], ['--dry-run', '--shadow-runs', '2']);
    assert.equal(r.status, 0, r.stderr);
    const e = only(results);
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'verification-failed');
    assert.equal(e.verification.runs, 2);
    assert.equal(e.verification.passed, 1);
    assert.equal(e.verification.failed, 1);
  } finally { s.done(); }
});

test('heal.shadowRuns in the config is used when the flag is absent, and the flag wins', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    fs.writeFileSync(path.join(s.dir, 'qa-core.config.json'), JSON.stringify({ heal: { shadowRuns: 2 } }));
    let run = await runFindings(s, [finding()], ['--dry-run'], { shadowRuns: null });
    assert.equal(only(run.results).verification.runs, 2);
    assert.equal(countOf(s.counter).length, 3);
    fs.writeFileSync(s.counter, '');
    run = await runFindings(s, [finding()], ['--dry-run', '--shadow-runs', '1'], { shadowRuns: null });
    assert.equal(only(run.results).verification.runs, 1);
    assert.equal(countOf(s.counter).filter(Boolean).length, 2);
  } finally { s.done(); }
});

test('heal.shadowRuns must be a positive integer', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    fs.writeFileSync(path.join(s.dir, 'qa-core.config.json'), JSON.stringify({ heal: { shadowRuns: 0 } }));
    const findingsPath = writeFindings(s.dir, [finding({ mode: 'none' })]);
    const r = await runCli(['--findings', findingsPath, '--results', path.join(s.dir, 'r.json')], s.dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /heal\.shadowRuns in the config expects a positive integer/);
  } finally { s.done(); }
});

test('a spec symlink inside the project is refused and the message says it is a symbolic link', async () => {
  const s = await setup(HEALABLE_BODY);
  try {
    fs.symlinkSync('a.spec.ts', path.join(s.dir, 'tests/link.spec.ts'));
    const { results } = await runFindings(s, [finding({ file: 'tests/link.spec.ts' })]);
    const e = only(results);
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'spec-not-found');
    assert.match(e.explanation, /symbolic link/);
    assert.match(e.explanation, /Playwright lists the real file/);
  } finally { s.done(); }
});
