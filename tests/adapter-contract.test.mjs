import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { playwrightJs } = await import(path.join(repoRoot, 'dist', 'adapters', 'playwright-js', 'index.js'));
const { registeredAdapters, getAdapter } = await import(path.join(repoRoot, 'dist', 'adapters', 'index.js'));

const MEMBERS = [
  'id', 'enabled', 'detect', 'version', 'discoverConfig', 'listTests', 'runOne', 'runBatch', 'parseReport',
  'classifyFailure', 'parseLocators', 'emitLocator', 'uniqueInTarget', 'pageSource',
  'resolveProbeBase', 'probeLocator', 'probeScope', 'selectorSignature',
  'blocksTypeScriptConfig', 'typeStrippingMessage', 'locatorSignature',
  'assertionGrammar', 'routeCalls', 'cleanup', 'capabilities',
];

test('the registry lists Playwright and Cypress, in that order', () => {
  const ids = registeredAdapters().map((a) => a.id);
  assert.deepEqual(ids, ['playwright-js', 'cypress-js']);
  assert.equal(getAdapter('playwright-js'), playwrightJs);
  assert.equal(getAdapter('cypress-js')?.id, 'cypress-js');
  assert.equal(getAdapter('cypress-js')?.enabled, true);
  assert.equal(getAdapter('selenium-js'), null);
});

test('the Playwright JS adapter implements every interface member', () => {
  assert.equal(playwrightJs.id, 'playwright-js');
  for (const name of MEMBERS) {
    assert.notEqual(playwrightJs[name], undefined, name);
  }
  assert.equal(typeof playwrightJs.detect, 'function');
  assert.equal(typeof playwrightJs.version, 'function');
  assert.equal(typeof playwrightJs.discoverConfig, 'function');
  assert.equal(typeof playwrightJs.listTests, 'function');
  assert.equal(typeof playwrightJs.runOne, 'function');
  assert.equal(typeof playwrightJs.parseReport, 'function');
  assert.equal(typeof playwrightJs.classifyFailure, 'function');
  assert.equal(typeof playwrightJs.parseLocators, 'function');
  assert.equal(typeof playwrightJs.emitLocator, 'function');
  assert.equal(typeof playwrightJs.uniqueInTarget, 'function');
  assert.equal(playwrightJs.enabled, true);
  assert.equal(typeof playwrightJs.pageSource, 'function');
  assert.equal(typeof playwrightJs.runBatch, 'function');
  assert.equal(typeof playwrightJs.locatorSignature, 'function');
  assert.equal(playwrightJs.pageSource({}), null);
});

test('uniqueInTarget returns a count and treats a broken probe as zero', async () => {
  assert.equal(await playwrightJs.uniqueInTarget({}, { kind: 'css', selector: '#missing' }), 0);
  assert.equal(playwrightJs.assertionGrammar.assertionCallee, 'expect');
  assert.deepEqual([...playwrightJs.assertionGrammar.forms], ['soft', 'poll']);
  assert.equal(playwrightJs.routeCalls.method, 'goto');
  assert.deepEqual([...playwrightJs.cleanup.outputDirs], ['test-results', 'playwright-report', 'blob-report']);
  assert.deepEqual(playwrightJs.capabilities.frameworks, ['playwright-js']);
  assert.equal(playwrightJs.navigationError.source, 'page\\.goto:|net::|Navigation failed|NS_ERROR|Protocol error');
});
