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

// 0.3.2 field bug: a heading whose text echoed a broken button's name was
// proposed as its heal. Headings are DEFINITELY not interactive targets —
// they must read as a definite kind so the guard can veto, not as null.
test('headings have a definite kind and conflict with interactive expectations', () => {
  assert.equal(kindOfElement({ tag: 'h2', type: null, role: null, href: false }), 'heading');
  assert.equal(kindOfElement({ tag: 'h1', type: null, role: null, href: false }), 'heading');
  assert.equal(kindOfElement({ tag: 'h6', type: null, role: null, href: false }), 'heading');
  assert.equal(kindOfElement({ tag: 'div', type: null, role: 'heading', href: false }), 'heading');
  assert.equal(kindConflict(['button'], 'heading'), true);
  assert.equal(kindConflict(['link'], 'heading'), true);
  // A heading expectation is never declared (no heading keyword/role in the
  // expectation maps), so nothing that healed before can newly expect one.
  assert.deepEqual(kindsFromTokens('#section-heading'), []);
});

// 0.3.2 doc-page decoys: common content tags are DEFINITE content kinds,
// so a paragraph/list-item decoy vetoes decisively and refusals name what
// was found ("candidate is paragraph") instead of "cannot be verified".
test('content tags have definite kinds; <a> is a link only WITH href', () => {
  assert.equal(kindOfElement({ tag: 'p', type: null, role: null, href: false }), 'paragraph');
  assert.equal(kindOfElement({ tag: 'li', type: null, role: null, href: false }), 'list item');
  assert.equal(kindOfElement({ tag: 'span', type: null, role: null, href: false }), 'inline text');
  assert.equal(kindOfElement({ tag: 'div', type: null, role: 'paragraph', href: false }), 'paragraph');
  assert.equal(kindOfElement({ tag: 'div', type: null, role: 'listitem', href: false }), 'list item');
  // A role attribute still wins over the content tag.
  assert.equal(kindOfElement({ tag: 'span', type: null, role: 'button', href: false }), 'button');
  // <a> WITH href is definitely a link; without href it stays unverifiable
  // (ARIA-correct), never a definite anything.
  assert.equal(kindOfElement({ tag: 'a', type: null, role: null, href: true }), 'link');
  assert.equal(kindOfElement({ tag: 'a', type: null, role: null, href: false }), null);
  assert.equal(kindConflict(['button'], 'paragraph'), true);
  assert.equal(kindConflict(['button'], 'list item'), true);
  assert.equal(kindConflict(['textbox'], 'inline text'), true);
  // No token/trailing-API expectation can declare a content kind.
  assert.deepEqual(kindsFromTokens('#news-paragraph-list-item-span'), []);
});

test('kindConflict fires only on a definite mismatch', () => {
  assert.equal(kindConflict(['button'], 'link'), true);
  assert.equal(kindConflict(['textbox'], 'link'), true);
  assert.equal(kindConflict(['button'], 'button'), false);
  assert.equal(kindConflict(['checkbox', 'radio'], 'radio'), false);
  assert.equal(kindConflict([], 'link'), false);      // nothing expected
  assert.equal(kindConflict(['button'], null), false); // candidate kind unknown
});
