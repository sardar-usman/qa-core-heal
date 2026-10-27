import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertValid, pkg, readJsonFile, repoRoot, validateFindings, validateResults } from './helpers/contract.mjs';

/**
 * The vendored contract v1 schemas are frozen. These tests pin their bytes,
 * check the shared examples, and prove the validator rejects what the
 * contract says it must. ajv is a dev dependency only.
 */

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fx = (name) => readJsonFile(path.join(repoRoot, 'tests', 'fixtures', 'contract', name));
const copy = (o) => structuredClone(o);

test('the vendored schemas are byte for byte the frozen contract v1 files', () => {
  assert.equal(sha(path.join(repoRoot, 'schemas', 'heal-findings.v1.schema.json')),
    '0770177865f22aa0117fde757a6172feddb59033a562bc6c081cc96833315583');
  assert.equal(sha(path.join(repoRoot, 'schemas', 'heal-results.v1.schema.json')),
    '92b6debf0d0612ecae1498c7fdd25d9e572d4f7b6565ec6065634e04ee8eb3d4');
});

test('the shared examples are valid against their schemas', () => {
  assertValid(validateFindings, fx('heal-findings.example.json'), 'findings example');
  assertValid(validateResults, fx('heal-results.example.json'), 'results example');
});

test('the results schema rejects what the contract forbids', () => {
  const ok = fx('heal-results.example.json');
  const bad = (mutate, label) => {
    const doc = copy(ok);
    mutate(doc);
    assert.equal(validateResults(doc), false, label);
  };
  bad((d) => { d.results[0].verification.outcome = 'failed'; }, 'a proposal needs a passed verification');
  bad((d) => { d.results[0].changes = []; }, 'a proposal needs changes');
  bad((d) => { d.results[2].refusal = null; }, 'a refusal needs a refusal object');
  bad((d) => { d.schemaVersion = 2; }, 'only version 1');
  bad((d) => { d.results[0].extra = 1; }, 'no unknown fields');
  bad((d) => { d.results[0].status = 'applied-ish'; }, 'status must be a known one');
  bad((d) => { d.results[1].status = 'applied'; }, 'a rule suggestion is never applied');
});

test('the findings schema rejects an unknown version and a real bug handed off as a locator', () => {
  const ok = fx('heal-findings.example.json');
  let doc = copy(ok);
  doc.schemaVersion = 2;
  assert.equal(validateFindings(doc), false);
  doc = copy(ok);
  doc.findings[2].handoff.mode = 'locator';
  assert.equal(validateFindings(doc), false);
});

test('ajv is a dev dependency only: nothing in dist or the runtime dependencies uses it', () => {
  assert.equal(pkg.dependencies?.ajv, undefined);
  assert.equal(pkg.dependencies?.['ajv-formats'], undefined);
  assert.ok(pkg.devDependencies.ajv);
  assert.ok(pkg.devDependencies['ajv-formats']);
  for (const f of fs.readdirSync(path.join(repoRoot, 'dist')).filter((n) => n.endsWith('.js'))) {
    assert.equal(/\bajv\b/.test(fs.readFileSync(path.join(repoRoot, 'dist', f), 'utf8')), false, f);
  }
});

test('the package ships the schemas', () => {
  assert.ok(pkg.files.includes('schemas'));
  assert.ok(fs.existsSync(path.join(repoRoot, 'schemas', 'README.md')));
});

test('the package version is 0.4.1', () => {
  assert.equal(pkg.version, '0.4.1');
});
