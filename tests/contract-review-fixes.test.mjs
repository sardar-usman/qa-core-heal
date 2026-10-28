import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertValid, baseOf, finding, findingsDoc, inventoryServer, makeNestedProject, makeProject, readJsonFile, repoRoot, rm, runCli,
  startServer, validateFindings, validateResults, writeFindings,
} from './helpers/contract.mjs';

/**
 * Review round 1 for 0.4.0:
 *   1. project.configPath is passed to Playwright as --config.
 *   2. A spec must be inside the project folder for every base folder.
 *   3. Every run has its own Playwright --output folder.
 */

const TYPO_TITLE = 'typo locator never finds the backpack button';
const typoFinding = (specFile) => finding({
  file: specFile, titlePath: [TYPO_TITLE], failingSelector: '#add-to-cart-sauce-labs-bakpack',
  errorLocation: { file: specFile, line: 6, column: 40 },
});

async function nested(opts) {
  const server = await inventoryServer();
  const p = makeNestedProject(baseOf(server), opts);
  return { ...p, server, done: () => { server.close(); rm(p.dir); } };
}

const entryOf = (results) => { assert.equal(results.results.length, 1); return results.results[0]; };

/* ───────────────────────── Fix 1: --config from project.configPath ───────────────────────── */

test('a nested config (SauceDemo kit layout, no config at the root) ends as proposed, and --config is passed to every Playwright call', async () => {
  const n = await nested();
  try {
    const spec = path.join(n.dir, n.specFile);
    const before = fs.readFileSync(spec, 'utf8');
    const f = typoFinding(n.specFile);
    const findingsPath = writeFindings(n.dir, [f], null, 'heal-findings.json', n.configPath);
    const resultsPath = path.join(n.dir, 'heal-results.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--verbose', '--shadow-runs', '1'], n.dir);
    assert.equal(r.status, 0, r.stderr);
    const results = readJsonFile(resultsPath);
    assertValid(validateResults, results, 'results file');
    const e = entryOf(results);
    assert.equal(e.status, 'proposed', e.explanation);
    assert.equal(e.changes[0].before, "page.locator('#add-to-cart-sauce-labs-bakpack')");
    assert.equal(e.changes[0].after, "page.locator('#add-to-cart-sauce-labs-backpack')");
    assert.match(r.stderr, /skipped template route at/);
    assert.doesNotMatch(r.stderr, /%7BDEMO_ORIGIN/);
    assert.equal(fs.readFileSync(spec, 'utf8'), before, 'a proposal must not touch the spec');
    // The two --list calls, the first run and the scratch run all carry --config.
    const children = r.stderr.split('\n').filter((l) => l.startsWith('[verbose] child:'));
    assert.ok(children.length >= 4, `expected at least 4 child runs, saw ${children.length}`);
    for (const c of children) assert.ok(c.includes(`--config ${n.configPath}`), `missing --config: ${c}`);
  } finally { n.done(); }
});

test('a configPath that does not exist is ignored, as before: Playwright finds its own config', async () => {
  const server = await startServer('<html><body><input id="mail-x9" name="email" type="email"></body></html>');
  const dir = makeProject(baseOf(server), {
    'tests/a.spec.ts': `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => { await page.goto('/'); await page.locator('#email-7d21ac').fill('a@b.dev'); });
`,
  });
  try {
    const findingsPath = writeFindings(dir, [finding()], baseOf(server), 'f.json', 'no/such/playwright.config.ts');
    const resultsPath = path.join(dir, 'r.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--verbose', '--shadow-runs', '1'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(entryOf(readJsonFile(resultsPath)).status, 'proposed');
    assert.ok(!r.stderr.includes('--config'));
    assert.match(r.stderr, /\[verbose\] ignored configPath no\/such\/playwright\.config\.ts: the file is missing/);
  } finally { server.close(); rm(dir); }
});

/* ───────────────────────── Fix 2: the spec must stay inside the project ───────────────────────── */

/** An outside project whose spec writes a marker file when it is loaded or run. */
function outsideProject(base) {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-mark-')), 'marker.log');
  const dir = makeProject(base, {
    'tests/x.spec.ts': `import { test } from '@playwright/test';
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(marker)}, 'loaded\\n');
test('fills mail', async ({ page }) => {
  fs.appendFileSync(${JSON.stringify(marker)}, 'ran\\n');
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
`,
  });
  return { dir, marker, done: () => { rm(dir); rm(path.dirname(marker)); } };
}

async function escapeCase(configPath, fileOf) {
  const server = await startServer('<html><body><input id="mail-x9" name="email" type="email"></body></html>');
  const outside = outsideProject(baseOf(server));
  const project = makeProject(baseOf(server), {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('inside', async () => {});\n",
  });
  try {
    fileOf.setup?.(project, outside.dir);
    const f = finding({ file: fileOf.file(outside.dir) });
    const findingsPath = writeFindings(project, [f], baseOf(server), 'f.json', configPath(outside.dir));
    const resultsPath = path.join(project, 'r.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run'], project);
    assert.equal(r.status, 0, r.stderr);
    const e = entryOf(readJsonFile(resultsPath));
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'spec-not-found');
    assert.equal(fs.existsSync(outside.marker), false, 'the outside spec was loaded or run');
  } finally { server.close(); rm(project); outside.done(); }
}

test('a configPath with .. cannot bring in a spec from a folder outside the project', async () => {
  await escapeCase((outside) => `../${path.basename(outside)}/playwright.config.ts`, { file: () => 'tests/x.spec.ts' });
});

test('an absolute configPath cannot bring in a spec from a folder outside the project', async () => {
  await escapeCase((outside) => path.join(outside, 'playwright.config.ts'), { file: () => 'tests/x.spec.ts' });
});

test('a configPath folder that is a symbolic link out of the project cannot bring in a spec', async () => {
  await escapeCase(() => 'linked/playwright.config.ts', {
    file: () => 'tests/x.spec.ts',
    setup: (project, outsideDir) => fs.symlinkSync(outsideDir, path.join(project, 'linked'), 'dir'),
  });
});

test('a spec reached through a symbolic link folder that points out of the project is refused', async () => {
  await escapeCase(() => 'playwright.config.ts', {
    file: () => 'linked/tests/x.spec.ts',
    setup: (project, outsideDir) => fs.symlinkSync(outsideDir, path.join(project, 'linked'), 'dir'),
  });
});

test('a findings file is resolved against testDir when it is not found from the project root', async () => {
  const n = await nested();
  try {
    const f = typoFinding('broken.spec.ts');
    const findingsPath = writeFindings(n.dir, [f], null, 'f.json', n.configPath);
    const resultsPath = path.join(n.dir, 'r.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--shadow-runs', '1'], n.dir);
    assert.equal(r.status, 0, r.stderr);
    const e = entryOf(readJsonFile(resultsPath));
    assert.equal(e.status, 'proposed', e.explanation);
    assert.notEqual(e.refusal?.code, 'spec-not-found');
  } finally { n.done(); }
});

test('a testDir that is a symbolic link outside the project is not used', async () => {
  const server = await startServer('<html><body><input id="mail-x9" name="email" type="email"></body></html>');
  const outside = outsideProject(baseOf(server));
  const project = makeProject(baseOf(server), {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('inside', async () => {});\n",
  });
  try {
    fs.symlinkSync(outside.dir, path.join(project, 'escaped'), 'dir');
    const cfg = fs.readFileSync(path.join(project, 'playwright.config.ts'), 'utf8').replace("testDir: './tests'", "testDir: './escaped'");
    fs.writeFileSync(path.join(project, 'playwright.config.ts'), cfg);
    const f = finding({ file: 'tests/x.spec.ts' });
    const findingsPath = writeFindings(project, [f], baseOf(server), 'f.json', 'playwright.config.ts');
    const resultsPath = path.join(project, 'r.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--shadow-runs', '1'], project);
    assert.equal(r.status, 0, r.stderr);
    const e = entryOf(readJsonFile(resultsPath));
    assert.equal(e.status, 'refused');
    assert.equal(e.refusal.code, 'spec-not-found');
    assert.equal(fs.existsSync(outside.marker), false, 'the outside spec was loaded or run');
  } finally { server.close(); rm(project); outside.done(); }
});

test('a configPath that is a folder, outside the project, or unsafe is ignored and --verbose says why', async () => {
  const server = await startServer('<html><body></body></html>');
  const dir = makeProject(baseOf(server), {
    'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('inside', async () => {});\n",
  });
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-cfg-')), 'playwright.config.ts');
  fs.writeFileSync(outsideFile, 'export default {};\n');
  try {
    const run = async (configPath, prepare) => {
      prepare?.();
      const findingsPath = writeFindings(dir, [finding({ mode: 'none' })], null, `f-${configPath.replace(/[^a-z0-9]+/gi, '-')}.json`, configPath);
      return runCli(['--findings', findingsPath, '--results', path.join(dir, 'r.json'), '--verbose'], dir);
    };
    fs.mkdirSync(path.join(dir, 'cfgdir'));
    let r = await run('cfgdir');
    assert.match(r.stderr, /\[verbose\] ignored configPath cfgdir: it is a folder/);
    fs.rmSync(path.join(dir, 'playwright.config.ts'));
    fs.symlinkSync(outsideFile, path.join(dir, 'playwright.config.ts'));
    r = await run('playwright.config.ts');
    assert.match(r.stderr, /\[verbose\] ignored configPath playwright\.config\.ts: it is outside the project/);
    r = await run('../nope.ts');
    assert.match(r.stderr, /\[verbose\] ignored configPath \.\.\/nope\.ts: it is absolute or it contains \.\./);
  } finally { server.close(); rm(dir); rm(path.dirname(outsideFile)); }
});

test('a spec inside the project is still found through the config folder base', async () => {
  const n = await nested();
  try {
    // The finding names the spec relative to the config folder (tests/broken.spec.ts under demo/saucedemo).
    const f = typoFinding('tests/broken.spec.ts');
    const findingsPath = writeFindings(n.dir, [f], null, 'f.json', n.configPath);
    const resultsPath = path.join(n.dir, 'r.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--shadow-runs', '1'], n.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(entryOf(readJsonFile(resultsPath)).status, 'proposed');
  } finally { n.done(); }
});

/* ───────────────────────── Fix 3: a private --output folder for every run ───────────────────────── */

test('every Playwright call has its own --output folder, and the project test-results folder is not used', async () => {
  const n = await nested({ configDir: '.' });
  try {
    const findingsPath = writeFindings(n.dir, [typoFinding(n.specFile)], null, 'f.json', n.configPath);
    const resultsPath = path.join(n.dir, 'r.json');
    const r = await runCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--verbose', '--shadow-runs', '1'], n.dir);
    assert.equal(r.status, 0, r.stderr);
    const children = r.stderr.split('\n').filter((l) => l.startsWith('[verbose] child:'));
    const outputs = children.map((c) => c.match(/--output (\S+)/)?.[1]);
    for (const [i, o] of outputs.entries()) assert.ok(o, `child ${i} has no --output: ${children[i]}`);
    for (const o of outputs) assert.ok(path.basename(path.dirname(o)).startsWith('qa-core-heal-out-'), o);
    // list, first run and scratch run use three different folders.
    assert.equal(new Set(outputs.map((o) => path.basename(o))).size, new Set(['list', 'first', 'scratch']).size);
    assert.ok(outputs.some((o) => o.endsWith('/list')) && outputs.some((o) => o.endsWith('/first')) && outputs.some((o) => o.endsWith('/scratch')));
    for (const o of new Set(outputs)) assert.equal(fs.existsSync(path.dirname(o)), false, `${o} was not removed`);
        assert.equal(fs.existsSync(path.join(n.dir, 'test-results')), false);
  } finally { n.done(); }
});

test('two runs at the same time in one project give the same answer every time', async () => {
  // The config is at the root here, so only the output folders can make the difference.
  const n = await nested({ configDir: '.' });
  try {
    const findingsPath = writeFindings(n.dir, [typoFinding(n.specFile)], null, 'f.json', n.configPath);
    for (let round = 0; round < 3; round++) {
      const paths = [path.join(n.dir, `r${round}a.json`), path.join(n.dir, `r${round}b.json`)];
      const runs = await Promise.all(paths.map((p) => runCli(['--findings', findingsPath, '--results', p, '--dry-run', '--shadow-runs', '1'], n.dir)));
      for (const [i, r] of runs.entries()) {
        assert.equal(r.status, 0, r.stderr);
        const e = entryOf(readJsonFile(paths[i]));
        assert.equal(e.status, 'proposed', `round ${round} run ${i}: ${e.status} ${e.explanation}`);
      }
    }
  } finally { n.done(); }
});

/* ───────────────────────── The interop fixtures from the review ───────────────────────── */

const interopDir = path.join(repoRoot, 'tests', 'fixtures', 'contract', 'interop');

test('the interop findings from qa-core-flaky are valid against the frozen findings schema', () => {
  for (const name of ['heal-findings.raw.json', 'heal-findings.rootcfg.json']) {
    assertValid(validateFindings, readJsonFile(path.join(interopDir, name)), name);
  }
});

test('the raw interop findings (file relative to testDir) are refused without running any test', async () => {
  const server = await startServer('<html><body></body></html>');
  const dir = makeProject(baseOf(server), { 'tests/a.spec.ts': "import { test } from '@playwright/test';\ntest('x', async () => {});\n" });
  try {
    const resultsPath = path.join(dir, 'r.json');
    fs.copyFileSync(path.join(interopDir, 'heal-findings.raw.json'), path.join(dir, 'f.json'));
    const r = await runCli(['--findings', 'f.json', '--results', resultsPath, '--dry-run'], dir);
    assert.equal(r.status, 0, r.stderr);
    const results = readJsonFile(resultsPath);
    assertValid(validateResults, results, 'results file');
    assert.equal(results.results.length, 7);
    assert.ok(results.results.every((e) => e.status === 'refused'));
    const codes = results.results.map((e) => e.refusal.code);
    assert.equal(codes[codes.length - 1], 'spec-not-found', 'the locator finding with a testDir relative file is spec-not-found');
    assert.deepEqual(codes.slice(0, 2), ['ineligible-handoff', 'ineligible-handoff']);
  } finally { server.close(); rm(dir); }
});
