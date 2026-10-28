import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pkg, repoRoot, runCli } from './helpers/contract.mjs';

const playwrightVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version;

test('capabilities --json reports the tool version, both contract versions and the Playwright version', async () => {
  const r = await runCli(['capabilities', '--json'], repoRoot);
  assert.equal(r.status, 0, r.stderr);
  const caps = JSON.parse(r.stdout);
  assert.deepEqual(caps, {
    schema: 'qa-core.heal-capabilities',
    schemaVersion: 1,
    tool: { name: 'qa-core-heal', version: pkg.version },
    contracts: { findings: [1], results: [1] },
    playwrightVersion,
    features: {
      findings: true,
      targetedRun: true,
      ruleSuggestions: false,
      ai: false,
      playwrightConfig: true,
      runTimeout: true,
      frameworks: ['playwright-js', 'cypress-js'],
    },
    frameworkVersions: { 'playwright-js': playwrightVersion, 'cypress-js': null },
  });
  assert.equal(caps.frameworkVersions['playwright-js'], caps.playwrightVersion);
  assert.deepEqual(Object.keys(caps), ['schema', 'schemaVersion', 'tool', 'contracts', 'playwrightVersion', 'features', 'frameworkVersions']);
  assert.deepEqual(Object.keys(caps.features), ['findings', 'targetedRun', 'ruleSuggestions', 'ai', 'playwrightConfig', 'runTimeout', 'frameworks']);
  assert.equal(r.stdout.trim().split('\n').length > 1, true, 'pretty printed, one object');
});

test('capabilities prints readable text without --json', async () => {
  const r = await runCli(['capabilities'], repoRoot);
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`^qa-core-heal ${pkg.version.replace(/\./g, '\\.')}`));
  assert.match(r.stdout, /findings contract versions: 1/);
  assert.match(r.stdout, /results contract versions: 1/);
  assert.match(r.stdout, /spec mode Playwright config: --playwright-config/);
  assert.match(r.stdout, /run timeout: --run-timeout/);
  assert.match(r.stdout, new RegExp(`Playwright: ${playwrightVersion.replace(/\./g, '\\.')}`));
  assert.match(r.stdout, /frameworks: playwright-js, cypress-js\n$/);
});

test('capabilities runs nothing: no test, no browser, no file written', async () => {
  // A private empty folder, so other tests that make folders in the repo cannot interfere.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-caps-'));
  try {
    const r = await runCli(['capabilities', '--json'], dir);
    assert.equal(r.status, 0);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capabilities lists only enabled adapters in Playwright, Cypress, Selenium, and mixed projects', async () => {
  const cases = [
    ['playwright-only', { 'playwright.config.ts': 'export default {};\n' }],
    ['cypress-only', { 'cypress.config.ts': 'export default {};\n' }],
    ['selenium-only', { 'package.json': JSON.stringify({ devDependencies: { 'selenium-webdriver': '4.6.0' } }) }],
    ['mixed', { 'playwright.config.ts': 'export default {};\n', 'cypress.config.js': 'module.exports = {};\n', 'package.json': JSON.stringify({ devDependencies: { 'selenium-webdriver': '4.6.0' } }) }],
  ];
  for (const [name, files] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-core-heal-caps-${name}-`));
    try {
      for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
      const r = await runCli(['capabilities', '--json'], dir);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      const caps = JSON.parse(r.stdout);
      assert.deepEqual(caps.features.frameworks, ['playwright-js', 'cypress-js'], name);
      assert.deepEqual(Object.keys(caps.frameworkVersions), ['playwright-js', 'cypress-js'], name);
      assert.equal(caps.frameworkVersions['playwright-js'], caps.playwrightVersion, name);
      const text = await runCli(['capabilities'], dir);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, /frameworks: playwright-js, cypress-js\n$/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a folder named capabilities is still reachable as ./capabilities', async () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  try {
    const r = await runCli(['./capabilities'], dir);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /findings contract versions/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
