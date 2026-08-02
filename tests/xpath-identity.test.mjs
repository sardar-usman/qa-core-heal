import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 0.3.2: semantic identity from SIMPLE XPath shapes. The CSS form
 * [aria-label="Enable Prime mode"] carries fuzzy identity; the XPath
 * spelling of the same intent must not be blinder. The grammar is
 * deliberately narrow — everything outside it stays opaque and refuses
 * exactly as before.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { xpathIdentity } = await import(path.join(repoRoot, 'dist', 'heal.js'));

test('attribute-equality shapes on identity attributes extract token + tag', () => {
  assert.deepEqual(xpathIdentity("//a[@aria-label='Enable Prime mode']"),
    { token: 'Enable Prime mode', tag: 'a', role: null });
  assert.deepEqual(xpathIdentity('//input[@name="email"]'),
    { token: 'email', tag: 'input', role: null });
  assert.deepEqual(xpathIdentity("//*[@data-testid='save-draft']"),
    { token: 'save-draft', tag: null, role: null });
  assert.deepEqual(xpathIdentity('//button[@id="submitBtn"]'),
    { token: 'submitBtn', tag: 'button', role: null });
  assert.deepEqual(xpathIdentity('//span[@title="Refresh"]'),
    { token: 'Refresh', tag: 'span', role: null });
});

test('role + contains/text() extracts the text as token with the role', () => {
  assert.deepEqual(xpathIdentity('//div[@role="status"][contains(., "Prime accounts")]'),
    { token: 'Prime accounts', tag: 'div', role: 'status' });
  // Either predicate order; text()= accepted as the text half.
  assert.deepEqual(xpathIdentity('//div[contains(., "Prime accounts")][@role="status"]'),
    { token: 'Prime accounts', tag: 'div', role: 'status' });
  assert.deepEqual(xpathIdentity('//span[@role="alert"][text()="Saved"]'),
    { token: 'Saved', tag: 'span', role: 'alert' });
});

test('bare text identities: normalize-space() and text() equality (H-XPATH-01)', () => {
  assert.deepEqual(xpathIdentity("//*[normalize-space()='Start sync']"),
    { token: 'Start sync', tag: null, role: null });
  assert.deepEqual(xpathIdentity("//*[normalize-space(.)='Start sync']"),
    { token: 'Start sync', tag: null, role: null });
  assert.deepEqual(xpathIdentity('//h2[text()="Dashboard"]'),
    { token: 'Dashboard', tag: 'h2', role: null });
});

test('everything else stays opaque', () => {
  for (const xp of [
    '//ul/li[1]',                              // positional + path step
    '//li[last()]',                            // positional function
    '//h1/following-sibling::section',         // axis
    '//label/..',                              // parent step
    "//div[contains(@class,'btn-primary')]",   // class containment trick
    '//div[@class="btn btn-primary"]',         // class equality (styling)
    "//button[normalize-space(@class)='btn']", // normalize-space on CLASS
    '//div[contains(., "Prime accounts")]',    // bare contains: too weak alone
    '//div[@role="status"]',                   // role alone: the nameless shape
    '//div[@role="status"][@aria-label="x"]',  // two conditions, not role+text
    '//section//a[@aria-label="x"]',           // nested steps
    './/a[@aria-label="x"]',                   // relative prefix
    '(//a[@aria-label="x"])[2]',               // grouped positional
    '//div[@data-foo="x"]',                    // non-identity attribute
    "//a[@aria-label='']",                     // empty value
    '//a[@aria-label="x"][@name="y"][@id="z"]',// three predicates
    '//a',                                     // no predicate at all
  ]) {
    assert.equal(xpathIdentity(xp), null, xp);
  }
});
