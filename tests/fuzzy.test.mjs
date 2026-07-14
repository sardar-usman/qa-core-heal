import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Issue 2: fuzzy matching for typo'd identifiers. Normalization strips
 * separators and case; similarity is an edit-distance ratio with adjacent
 * transpositions counted as one edit. Fuzzy sits BELOW exact and
 * suffix-stripped matching, heals only a single in-band candidate, and
 * reports near-misses honestly.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {
  normalizeIdentifier, similarity, matchFuzzy, isGeneratedIdentifier,
  FUZZY_HEAL_THRESHOLD, FUZZY_NEAR_MISS_FLOOR,
} = await import(path.join(repoRoot, 'dist', 'fuzzy.js'));

test('normalizeIdentifier strips separators and case', () => {
  assert.equal(normalizeIdentifier('Emai_l'), 'email');
  assert.equal(normalizeIdentifier('quantity-field'), 'quantityfield');
  assert.equal(normalizeIdentifier('Email:'), 'email');
  assert.equal(normalizeIdentifier('data-test-42'), 'datatest42');
});

test('similarity is an edit-distance ratio that forgives transpositions', () => {
  assert.equal(similarity('email', 'email'), 1);
  // In-word typo: one dropped letter out of twelve.
  assert.ok(similarity('exportbutton', 'exportbuttn') >= 0.9);
  // Adjacent transposition counts as ONE edit: "emial" stays in the band.
  assert.ok(similarity('email', 'emial') >= FUZZY_HEAL_THRESHOLD);
  // Unrelated identifiers stay far apart.
  assert.ok(similarity('email', 'password') < FUZZY_NEAR_MISS_FLOOR);
  // Locks issue 3: ".result" must NOT near-miss against "register".
  assert.ok(similarity('result', 'register') < FUZZY_NEAR_MISS_FLOOR);
});

const el = (display, ...values) => ({ display, values });

test('a single in-band candidate is a match', () => {
  const r = matchFuzzy('Emai_l', [
    el('#Email', 'Email', 'Email:'),
    el('#Password', 'Password'),
    el('#newsletter-email', 'newsletter-email', 'NewsletterEmail'),
  ]);
  assert.equal(r.kind, 'match');
  assert.equal(r.candidate.display, '#Email');
  assert.equal(r.value, 'Email');
});

test('two candidates inside the band refuse as ambiguous', () => {
  const r = matchFuzzy('emai_l', [
    el('#contact-email', 'email'),
    el('#backup-email', 'email'),
  ]);
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.displays, ['#contact-email', '#backup-email']);
});

test('a below-threshold candidate is reported as a scored near-miss, not healed', () => {
  const r = matchFuzzy('Emai_l', [el('#emailz9', 'emailz9')]);
  assert.equal(r.kind, 'near-miss');
  assert.equal(r.closest.length, 1);
  assert.equal(r.closest[0].display, '#emailz9');
  assert.ok(r.closest[0].score >= FUZZY_NEAR_MISS_FLOOR && r.closest[0].score < FUZZY_HEAL_THRESHOLD);
});

test('near-misses name the top 3 non-generated candidates with scores', () => {
  const r = matchFuzzy('Emai_l', [
    el('#emailz9', 'emailz9'),
    el('#emalz88', 'emalz88'),
    el('#emaiz777', 'emaiz777'),
    el('#emz6666', 'emz6666'),
  ]);
  assert.equal(r.kind, 'near-miss');
  assert.ok(r.closest.length <= 3);
  // Sorted best-first.
  for (let i = 1; i < r.closest.length; i++) {
    assert.ok(r.closest[i - 1].score >= r.closest[i].score);
  }
});

test('isGeneratedIdentifier spots React useId patterns and hash ids', () => {
  assert.equal(isGeneratedIdentifier('_r_17_-form-item'), true);
  assert.equal(isGeneratedIdentifier(':r1a:'), true);
  assert.equal(isGeneratedIdentifier('9c31f7'), true);        // hash word
  assert.equal(isGeneratedIdentifier('42'), true);            // bare number
  assert.equal(isGeneratedIdentifier('r_type_selector'), false); // r + no digits
  assert.equal(isGeneratedIdentifier('contact-email'), false);
  assert.equal(isGeneratedIdentifier('Search by account or login'), false);
});

test('generated identifiers contribute nothing and are not named as closest', () => {
  const r = matchFuzzy('search1', [
    { display: '#_r_12_-form-item', values: ['_r_12_-form-item'], attrOf: { '_r_12_-form-item': 'id' } },
  ]);
  // The render-random id is noise: no match, no near-miss naming it...
  assert.notEqual(r.kind, 'match');
  if (r.kind === 'near-miss') {
    // ...unless nothing else exists — then it may appear, clearly scored.
    assert.ok(r.closest.every((c) => c.display === '#_r_12_-form-item'));
  }
});

test('a stripped identifier matching a whole word of the accessible name is a strong match', () => {
  // The real-repo case: mutation "search1", accessible name much longer.
  const label = { display: '"Search by account or login"', values: ['Search by account or login'], attrOf: { 'Search by account or login': 'label' } };
  const r = matchFuzzy('search1', [label]);
  assert.equal(r.kind, 'match');
  assert.equal(r.value, 'Search by account or login');
  assert.ok(r.score >= FUZZY_HEAL_THRESHOLD && r.score < 1, `score ${r.score}`);
});

test('two candidates containing the token refuse as ambiguous, both named', () => {
  const r = matchFuzzy('search1', [
    { display: '"Search by account or login"', values: ['Search by account or login'], attrOf: { 'Search by account or login': 'label' } },
    { display: '"Search by amount"', values: ['Search by amount'], attrOf: { 'Search by amount': 'label' } },
  ]);
  assert.equal(r.kind, 'ambiguous');
  assert.deepEqual(r.displays, ['"Search by account or login"', '"Search by amount"']);
});

test('token containment on id-ish values requires real coverage (the .result guard)', () => {
  // "result" IS a whole-word token of this id — but matching it would heal
  // a state-dependent locator to an unrelated block. Ids need coverage.
  const r = matchFuzzy('result', [
    { display: '#newsletter-result-block', values: ['newsletter-result-block'], attrOf: { 'newsletter-result-block': 'id' } },
  ]);
  assert.notEqual(r.kind, 'match');
  // But a lead token covering half the id is a real identity match.
  const r2 = matchFuzzy('search1', [
    { display: '#search-accounts', values: ['search-accounts'], attrOf: { 'search-accounts': 'id' } },
  ]);
  assert.equal(r2.kind, 'match');
});

test('nothing similar at all yields none', () => {
  const r = matchFuzzy('result', [
    el('#register-button', 'register-button'),
    el('#FirstName', 'FirstName', 'First name:'),
  ]);
  assert.equal(r.kind, 'none');
});

test('short tokens only match exactly after normalization', () => {
  // "id" normalized is 2 chars: an edit away must not fuzzy-match.
  assert.equal(matchFuzzy('qq', [el('#qx', 'qx')]).kind, 'none');
  // But an exact-after-normalization match still works.
  assert.equal(matchFuzzy('q-q', [el('#qq', 'qq')]).kind, 'match');
});
