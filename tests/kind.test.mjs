import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bug 3: element-kind guard. The kind the original selector implies (id /
 * class tokens, the getByRole role, the API chained on the locator) must not
 * conflict with the kind of the healed candidate. A submit button must never
 * be healed to a nav link.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { kindsFromTokens, kindsFromTrailingApi, kindOfElement, kindConflict } = await import(
  path.join(repoRoot, 'dist', 'kind.js')
);

test('selector tokens imply an expected kind', () => {
  assert.deepEqual(kindsFromTokens('#register-button'), ['button']);
  assert.deepEqual(kindsFromTokens('.terms-link'), ['link']);
  assert.deepEqual(kindsFromTokens('#digest-checkbox-52ba17'), ['checkbox']);
  assert.deepEqual(kindsFromTokens('input[type="email"]'), ['textbox']);
  assert.deepEqual(kindsFromTokens('#submitBtn'), ['button']); // camelCase split
});

test('tokens without a kind keyword imply nothing', () => {
  assert.deepEqual(kindsFromTokens('#Email_1'), []);
  assert.deepEqual(kindsFromTokens('.plan-selector'), []); // "selector" is not "select"
  assert.deepEqual(kindsFromTokens('.help-center'), []);
  assert.deepEqual(kindsFromTokens('[data-test="update-card"]'), []);
});

test('the API used on the locator implies an expected kind', () => {
  assert.deepEqual(kindsFromTrailingApi('.fill("x@example.com");'), ['textbox']);
  assert.deepEqual(kindsFromTrailingApi(".check();"), ['checkbox', 'radio']);
  assert.deepEqual(kindsFromTrailingApi(".selectOption('pro');"), ['combobox']);
  assert.deepEqual(kindsFromTrailingApi('.click();'), []); // anything is clickable
  assert.deepEqual(kindsFromTrailingApi(''), []);
});

test('kindOfElement classifies live elements', () => {
  assert.equal(kindOfElement({ tag: 'a', type: null, role: null, href: true }), 'link');
  assert.equal(kindOfElement({ tag: 'button', type: null, role: null, href: false }), 'button');
  assert.equal(kindOfElement({ tag: 'input', type: 'submit', role: null, href: false }), 'button');
  assert.equal(kindOfElement({ tag: 'input', type: 'text', role: null, href: false }), 'textbox');
  assert.equal(kindOfElement({ tag: 'input', type: 'checkbox', role: null, href: false }), 'checkbox');
  assert.equal(kindOfElement({ tag: 'select', type: null, role: null, href: false }), 'combobox');
  assert.equal(kindOfElement({ tag: 'textarea', type: null, role: null, href: false }), 'textbox');
  // An explicit ARIA role wins over the tag.
  assert.equal(kindOfElement({ tag: 'div', type: null, role: 'button', href: false }), 'button');
  // Unknown elements have no kind and can never conflict.
  assert.equal(kindOfElement({ tag: 'div', type: null, role: null, href: false }), null);
});

test('kindConflict fires only on a definite mismatch', () => {
  assert.equal(kindConflict(['button'], 'link'), true);
  assert.equal(kindConflict(['textbox'], 'link'), true);
  assert.equal(kindConflict(['button'], 'button'), false);
  assert.equal(kindConflict(['checkbox', 'radio'], 'radio'), false);
  assert.equal(kindConflict([], 'link'), false);      // nothing expected
  assert.equal(kindConflict(['button'], null), false); // candidate kind unknown
});
