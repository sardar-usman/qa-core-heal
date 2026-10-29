import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRoot, runCli } from './helpers/contract.mjs';

const { detectFramework } = await import(path.join(repoRoot, 'dist', 'adapters', 'detect.js'));
const { useAdapter } = await import(path.join(repoRoot, 'dist', 'adapters', 'index.js'));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-fw-'));
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const finding = (configPath, mode = 'none') => ({
  schema: 'qa-core.heal-findings',
  schemaVersion: 1,
  project: { configPath, baseUrl: null },
  findings: [{
    findingId: 'a1b2c3d4e5f6',
    testId: 't',
    file: 'tests/a.spec.ts',
    line: 1,
    project: '',
    titlePath: ['a'],
    verdict: 'broken-test',
    primaryRuleId: 'SEL-NOTFOUND',
    handoff: { mode, reason: '', gates: [] },
  }],
});

test('a single Playwright config selects playwright-js and prints nothing without --verbose', async () => {
  const dir = tempDir();
  try {
    write(dir, 'playwright.config.ts', 'export default {};\n');
    const found = detectFramework({ root: dir });
    assert.equal(found.ok, true);
    assert.equal(found.id, 'playwright-js');
    assert.equal(found.reason, 'playwright.config.ts');
    const r = await runCli(['capabilities'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const capsVerbose = await runCli(['capabilities', '--verbose'], dir);
    assert.equal(capsVerbose.status, 0);
    assert.equal(capsVerbose.stderr, '');
    const verbose = await runCli(['--dry-run', '--verbose'], dir);
    assert.match(verbose.stderr, /\[verbose\] framework playwright-js \(playwright\.config\.ts\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no framework match falls back to playwright-js with the same output', async () => {
  const dir = tempDir();
  try {
    const quiet = await runCli(['capabilities'], dir);
    const capsVerbose = await runCli(['capabilities', '--verbose'], dir);
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stderr, '');
    assert.equal(capsVerbose.stdout, quiet.stdout);
    assert.equal(capsVerbose.stderr, '');
    const verbose = await runCli(['--dry-run', '--verbose'], dir);
    assert.match(verbose.stderr, /\[verbose\] framework playwright-js \(fallback\)/);
    assert.equal(detectFramework({ root: dir }).reason, 'fallback');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('two framework matches are refused with exit 2 and no file is written', async () => {
  const dir = tempDir();
  try {
    write(dir, 'playwright.config.ts', 'export default {};\n');
    write(dir, 'cypress.config.js', 'module.exports = {};\n');
    write(dir, 'findings.json', JSON.stringify(finding(null)));
    const before = fs.readdirSync(dir).sort();
    const r = await runCli(['--findings', 'findings.json', '--results', 'heal-results.json', '--dry-run'], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /More than one framework was found: playwright-js \(playwright\.config\.ts\), cypress-js \(cypress\.config\.js\)/);
    assert.match(r.stderr, /Pass --framework to choose one/);
    assert.match(r.stderr, /Nothing was run/);
    assert.equal(fs.existsSync(path.join(dir, 'heal-results.json')), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the framework flag overrides two matches', async () => {
  const dir = tempDir();
  try {
    write(dir, 'playwright.config.ts', 'export default {};\n');
    write(dir, 'cypress.config.js', 'module.exports = {};\n');
    const caps = await runCli(['capabilities', '--framework', 'playwright-js', '--verbose'], dir);
    assert.equal(caps.status, 0, caps.stderr);
    assert.equal(caps.stderr, '');
    const r = await runCli(['--dry-run', '--framework', 'playwright-js', '--verbose'], dir);
    assert.match(r.stderr, /\[verbose\] framework playwright-js \(flag\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the framework flag overrides a non-Playwright match by refusing', async () => {
  const dir = tempDir();
  try {
    write(dir, 'cypress.config.js', 'module.exports = {};\n');
    write(dir, 'findings.json', JSON.stringify(finding('cypress.config.js')));
    const flagged = await runCli(['--findings', 'findings.json', '--results', 'out.json', '--framework', 'cypress-js'], dir);
    assert.equal(flagged.status, 0, flagged.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).results[0].refusal.code, 'ineligible-handoff');
    fs.rmSync(path.join(dir, 'out.json'));
    const detected = await runCli(['--findings', 'findings.json', '--results', 'out.json'], dir);
    assert.equal(detected.status, 0, detected.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).results[0].refusal.code, 'ineligible-handoff');
    fs.rmSync(path.join(dir, 'out.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an empty --framework value is a usage error', async () => {
  const dir = tempDir();
  try {
    const r = await runCli(['--dry-run', '--framework', ''], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown framework ""/);
    assert.doesNotMatch(r.stderr, /\[verbose\] framework/);
    const blank = detectFramework({ root: dir, flag: '   ' });
    assert.equal(blank.ok, false);
    assert.match(blank.message, /Unknown framework ""/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown framework value is a usage error and lists the accepted values', async () => {
  const dir = tempDir();
  try {
    const r = await runCli(['--dry-run', '--framework', 'webdriver'], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown framework "webdriver"/);
    assert.match(r.stderr, /Supported now: playwright-js, cypress-js, selenium-js/);
    assert.match(r.stderr, /Planned: playwright-py, selenium-py/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('project.configPath names each framework', async () => {
  const dir = tempDir();
  try {
    write(dir, 'playwright.config.ts', 'export default {};\n');
    write(dir, 'cypress.config.js', 'module.exports = {};\n');
    write(dir, 'pytest.ini', 'import playwright\n');
    write(dir, 'pyproject.toml', 'import selenium\n');
    write(dir, 'setup.cfg', '');
    write(dir, 'conftest.py', 'import playwright\nimport selenium\n');
    write(dir, 'pw.json', JSON.stringify(finding('playwright.config.ts')));
    const pwRun = await runCli(['--findings', 'pw.json', '--results', 'out.json', '--dry-run', '--verbose'], dir);
    assert.equal(pwRun.status, 0, pwRun.stderr);
    assert.match(pwRun.stderr, /\[verbose\] framework playwright-js \(project\.configPath playwright\.config\.ts\)/);
    assert.equal(fs.existsSync(path.join(dir, 'out.json')), true);
    fs.rmSync(path.join(dir, 'out.json'));

    write(dir, 'cy.json', JSON.stringify(finding('cypress.config.js')));
    const cy = await runCli(['--findings', 'cy.json', '--results', 'out.json', '--dry-run'], dir);
    assert.equal(cy.status, 0, cy.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).results[0].refusal.code, 'ineligible-handoff');
    fs.rmSync(path.join(dir, 'out.json'));

    write(dir, 'py.json', JSON.stringify(finding('pytest.ini')));
    const py = await runCli(['--findings', 'py.json', '--results', 'out.json'], dir);
    assert.equal(py.status, 2);
    assert.match(py.stderr, /playwright-py is planned and is not supported yet/);

    write(dir, 'sel.json', JSON.stringify(finding('pyproject.toml')));
    const sel = await runCli(['--findings', 'sel.json', '--results', 'out.json'], dir);
    assert.equal(sel.status, 2);
    assert.match(sel.stderr, /selenium-py is planned and is not supported yet/);

    write(dir, 'bare.json', JSON.stringify(finding('setup.cfg')));
    const bare = await runCli(['--findings', 'bare.json', '--results', 'out.json'], dir);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /A Python config was found \(setup\.cfg\)/);

    write(dir, 'both.json', JSON.stringify(finding('conftest.py')));
    const both = await runCli(['--findings', 'both.json', '--results', 'out.json'], dir);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /More than one framework was found: playwright-py \(project\.configPath conftest\.py\), selenium-py \(project\.configPath conftest\.py\)/);
    assert.equal(fs.existsSync(path.join(dir, 'out.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('selenium-webdriver with Mocha is selected, and Jest stays planned', async () => {
  const mochaDir = tempDir();
  const jestDir = tempDir();
  try {
    write(mochaDir, 'package.json', JSON.stringify({ devDependencies: { 'selenium-webdriver': '4.6.0', mocha: '10.0.0' } }));
    write(mochaDir, '.mocharc.json', '{}\n');
    const found = detectFramework({ root: mochaDir });
    assert.equal(found.ok, true);
    assert.equal(found.id, 'selenium-js');
    write(jestDir, 'package.json', JSON.stringify({ devDependencies: { 'selenium-webdriver': '4.6.0', jest: '29.0.0' } }));
    const jest = detectFramework({ root: jestDir });
    assert.equal(jest.ok, false);
    assert.match(jest.message, /Jest is planned and is not supported yet/);
  } finally {
    fs.rmSync(mochaDir, { recursive: true, force: true });
    fs.rmSync(jestDir, { recursive: true, force: true });
    useAdapter('playwright-js');
  }
});

test('selenium-webdriver in package.json is refused for a run, and capabilities still answers', async () => {
  const dir = tempDir();
  try {
    write(dir, 'package.json', JSON.stringify({ devDependencies: { 'selenium-webdriver': '4.0.0' } }));
    const plain = await runCli(['capabilities'], dir);
    const json = await runCli(['capabilities', '--json'], dir);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(json.status, 0, json.stderr);
    assert.match(plain.stdout, /frameworks: playwright-js, cypress-js, selenium-js/);
    assert.equal(JSON.parse(json.stdout).features.runTimeout, true);
    assert.equal(plain.stderr, '');
    const run = await runCli(['tests/nope.spec.ts', '--dry-run'], dir);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /selenium-js is planned and is not supported yet\. Nothing was run\./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capabilities answers in a two-framework project and in a Cypress-only project', async () => {
  const both = tempDir();
  const cypress = tempDir();
  try {
    write(both, 'playwright.config.ts', 'export default {};\n');
    write(both, 'cypress.config.js', 'module.exports = {};\n');
    write(cypress, 'cypress.config.js', 'module.exports = {};\n');
    for (const dir of [both, cypress]) {
      for (const args of [['capabilities'], ['capabilities', '--json']]) {
        const r = await runCli(args, dir);
        assert.equal(r.status, 0, `${args.join(' ')} in ${dir}: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /More than one framework|not supported yet/);
        if (args.includes('--json')) {
          const caps = JSON.parse(r.stdout);
          assert.equal(caps.features.runTimeout, true);
          assert.ok(caps.contracts.findings.includes(1));
        } else {
          assert.match(r.stdout, /findings contract versions: 1/);
        }
      }
    }
    const refused = await runCli(['tests/nope.spec.ts'], both);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /More than one framework was found/);
  } finally {
    fs.rmSync(both, { recursive: true, force: true });
    fs.rmSync(cypress, { recursive: true, force: true });
  }
});

test('detection never spawns a process', async () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'adapters', 'detect.ts'), 'utf8');
  assert.equal(src.includes('child_process'), false);
  assert.equal(src.includes('spawn'), false);
  const dir = tempDir();
  const marker = path.join(dir, 'spawned');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'playwright'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  fs.writeFileSync(path.join(bin, 'python'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  for (const name of ['playwright', 'python', 'npm']) fs.chmodSync(path.join(bin, name), 0o755);
  write(dir, 'playwright.config.ts', 'export default {};\n');
  write(dir, 'pytest.ini', 'import playwright\n');
  try {
    const found = detectFramework({ root: dir, configPath: 'pytest.ini' });
    assert.equal(found.ok, false);
    assert.equal(fs.existsSync(marker), false);
    const r = await runCli(['capabilities', '--framework', 'playwright-js'], dir, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(marker), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--help lists --framework and keeps the neighbouring flags', async () => {
  const r = await runCli(['--help'], repoRoot);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--playwright-config <path>.*\n {6}--framework <id>.*\n {6}--base-url <url>/);
});
