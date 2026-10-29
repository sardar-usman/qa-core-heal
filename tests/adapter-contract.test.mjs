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
});

test('assertionGrammar is expect, with soft and poll forms', () => {
  assert.equal(playwrightJs.assertionGrammar.assertionCallee, 'expect');
  assert.deepEqual([...playwrightJs.assertionGrammar.forms], ['soft', 'poll']);
});

test('route, cleanup, capabilities, and navigation stay on the adapter', () => {
  assert.equal(playwrightJs.routeCalls.method, 'goto');
  assert.deepEqual([...playwrightJs.cleanup.outputDirs], ['test-results', 'playwright-report', 'blob-report']);
  assert.deepEqual(playwrightJs.capabilities.frameworks, ['playwright-js']);
  assert.equal(playwrightJs.navigationError.source, 'page\\.goto:|net::|Navigation failed|NS_ERROR|Protocol error');
});

test('a text lookup uses selector when it is set and ignores nothing when it is omitted', async () => {
  const calls = [];
  const inner = {
    getByText(text, opts) {
      calls.push(['getByText', text, opts ?? null]);
      return { count: async () => 1 };
    },
  };
  const page = {
    locator(sel) {
      calls.push(['locator', sel]);
      return inner;
    },
    getByText(text, opts) {
      calls.push(['page.getByText', text, opts ?? null]);
      return { count: async () => 4 };
    },
  };
  const narrowed = await playwrightJs.uniqueInTarget(page, { kind: 'text', text: 'Login', selector: 'button' });
  assert.equal(narrowed, 1);
  assert.deepEqual(calls, [['locator', 'button'], ['getByText', 'Login', null]]);
  const plain = await playwrightJs.uniqueInTarget(page, { kind: 'text', text: 'Login' });
  assert.equal(plain, 4);
  assert.deepEqual(calls.at(-1), ['page.getByText', 'Login', null]);
  const exact = await playwrightJs.uniqueInTarget(page, { kind: 'text', text: 'Login', exact: true });
  assert.equal(exact, 4);
  assert.deepEqual(calls.at(-1), ['page.getByText', 'Login', { exact: true }]);
});
