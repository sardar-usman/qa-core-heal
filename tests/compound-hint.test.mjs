import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 0.3.2: hint selection per selector shape. The compound-CSS teaching
 * appendix must only decorate refusals of selectors that ARE compound —
 * the field bug appended it to a lone GUID-style id (digit-leading ids
 * fell out of the "simple" pattern) and to input[type='file']. The rule,
 * pinned: simple = #id (digit-leading allowed), .class, [attr], tag, and
 * tag[attr] with one attribute (the shape our own smart-CSS heals emit);
 * compound = multi-class stacks, tag+class, combinators, pseudo-classes,
 * multi-attribute stacks. A simple #id that is ENTIRELY generated noise
 * gets the generated-per-load teaching instead; a half-generated id gets
 * neither.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { isCompoundCss, withCompoundHint } = await import(path.join(repoRoot, 'dist', 'heal.js'));

const cssCall = (css) => ({ level: 'css', args: { css } });
const COMPOUND = 'compound CSS selectors carry little recoverable identity';
const GENERATED = 'this id looks generated per load; target by role or a data-testid';

test('simple selectors are not compound — including digit-leading ids and tag[attr]', () => {
  for (const css of [
    '#21296a37-d443-d48e-6a55-8614388691ac', // the field GUID id
    "input[type='file']",                    // the field tag+attr (our own heal shape)
    'input[type="email"]',
    '#login', '#email-7d21ac', '.legal-link', '[data-test="update-card"]', 'button',
  ]) {
    assert.equal(isCompoundCss(cssCall(css)), false, css);
  }
});

test('genuinely compound selectors keep the compound hint', () => {
  for (const css of [
    '.btn.btn-primary', 'button.btn.btn-primary', 'div > span',
    'li:nth-child(2)', 'input[type="text"][name="q"]', '#toolbar [aria-label="Refresh"]',
  ]) {
    assert.equal(isCompoundCss(cssCall(css)), true, css);
    assert.match(withCompoundHint(cssCall(css), 'not found.'), new RegExp(COMPOUND), css);
  }
});

test('a fully generated simple #id gets the generated-per-load teaching, not the compound hint', () => {
  const r = withCompoundHint(cssCall('#21296a37-d443-d48e-6a55-8614388691ac'), 'not found.');
  assert.ok(r.includes(GENERATED), r);
  assert.ok(!r.includes(COMPOUND), r);
});

test('a half-generated id and a tag[attr] selector get neither appendix', () => {
  for (const css of ['#email-7d21ac', "input[type='file']", '#login', '.legal-link']) {
    assert.equal(withCompoundHint(cssCall(css), 'not found.'), 'not found.', css);
  }
});

test('non-css levels never get an appendix', () => {
  assert.equal(withCompoundHint({ level: 'role', args: { role: 'button' } }, 'not found.'), 'not found.');
});
