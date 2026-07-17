import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 0.2.1 item 2: tag-typo corrections for compound CSS selectors. The
 * correction is pure string work (probing and the unique-match gate live in
 * heal()); these tests pin what may ever be OFFERED for probing.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { tagTypoCorrections, closestKnownTag } = await import(path.join(repoRoot, 'dist', 'heal.js'));

test('an invalid tag one edit from a real one is corrected, selector preserved', () => {
  assert.deepEqual(tagTypoCorrections('buttons.btn.btn-primary'), ['button.btn.btn-primary']);
  assert.deepEqual(tagTypoCorrections('imgs.hero-image'), ['img.hero-image']);
  assert.deepEqual(tagTypoCorrections('divv.card'), ['div.card']);
});

test('a valid tag is never corrected', () => {
  assert.deepEqual(tagTypoCorrections('button.btn.btn-primary'), []);
  assert.deepEqual(tagTypoCorrections('td:nth-child(3).col-total'), []);
  assert.deepEqual(tagTypoCorrections('svg.icon'), []);
});

test('selectors without a leading tag token are never corrected', () => {
  assert.deepEqual(tagTypoCorrections('.btn.btn-primary'), []);
  assert.deepEqual(tagTypoCorrections('#toolbar > [aria-label="x"]'), []);
  assert.deepEqual(tagTypoCorrections('[data-test="save"]'), []);
});

test('custom elements (dashed tags) are never corrected', () => {
  assert.deepEqual(tagTypoCorrections('my-widget.active'), []);
});

test('a bare tag with nothing else is not a compound selector, never corrected', () => {
  assert.deepEqual(tagTypoCorrections('buttons'), []);
});

test('a typo more than one edit from any tag yields no correction', () => {
  assert.deepEqual(tagTypoCorrections('buttonzz.btn'), []);
});

test('several plausible corrections are all offered (the unique-match gate decides)', () => {
  const out = tagTypoCorrections('ba.item');
  assert.ok(out.includes('a.item'));
  assert.ok(out.includes('b.item'));
  assert.ok(out.length >= 2);
});

test('attribute and pseudo-class tails survive correction', () => {
  assert.deepEqual(tagTypoCorrections('buttons[type="submit"]'), ['button[type="submit"]']);
  assert.deepEqual(tagTypoCorrections('buttons:first-child'), ['button:first-child']);
});

// 0.2.1 ITEM 2: underscores are illegal in ANY tag name (custom elements
// use dashes), so an underscored token is always a typo: strip the
// underscore suffix, then the same one-edit correction (distance 0
// included — the strip itself was the edit).
test('underscored tag tokens strip and correct (always typos, never custom elements)', () => {
  assert.deepEqual(tagTypoCorrections('buttons_1.btn.btn-primary'), ['button.btn.btn-primary']);
  assert.deepEqual(tagTypoCorrections('button_1.btn.btn-primary'), ['button.btn.btn-primary']);
  assert.deepEqual(tagTypoCorrections('imgs_2.hero'), ['img.hero']);
});

// 0.2.1 ITEM 1: dashed tags are spec-legal custom-element names — NEVER
// auto-healed; the closest valid tag feeds the refusal hint only.
test('dashed tag tokens are never corrected, only hinted', () => {
  assert.deepEqual(tagTypoCorrections('button-1.btn.btn-primary'), []);
  assert.deepEqual(tagTypoCorrections('buttons-1.btn.btn-primary'), []);
  assert.equal(closestKnownTag('button-1', 2), 'button');
  assert.equal(closestKnownTag('buttons-1', 2), null); // distance 3, out of hint range
  assert.equal(closestKnownTag('my-widget', 2), null);
});
