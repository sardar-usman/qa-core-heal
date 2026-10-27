import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './helpers/contract.mjs';

const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
const configDoc = fs.readFileSync(path.join(repoRoot, 'skill', 'references', 'config.md'), 'utf8');

test('the README documents the 0.4.1 behavior in plain places', () => {
  const paths = readme.indexOf('**Paths in a findings file.**');
  const dry = readme.indexOf('An explicit `--dry-run` is accepted with `--findings`');
  const config = readme.indexOf('**The Playwright config.**');
  const separate = readme.indexOf('**Separate output folders.**');
  assert.ok(paths >= 0 && dry > paths && dry < config, 'the dry-run sentences follow the paths paragraph');
  assert.equal(readme.slice(separate).includes('An explicit `--dry-run` is accepted with `--findings`'), false);
  assert.match(readme, /hard link inside the project/);
  assert.match(readme, /--playwright-config/);
  assert.match(readme, /shadowRuns/);
  assert.match(readme, /A SauceDemo session lasts only a short time/);
  assert.match(readme, /\.auth\/state\.json/);
  assert.match(readme, /qa-core-flaky --heal-findings heal-findings\.json/);
  assert.match(readme, /broken\.spec\.ts/);
  assert.match(readme, /weakens-test/);
  assert.match(readme, /login page at \//);
  assert.match(readme, /Not in 0\.4\.1/);
  assert.match(readme, /"version": "0\.4\.1"/);
  assert.match(readme, /playwrightConfig/);
  assert.match(readme, /runTimeout/);
  assert.match(readme, /qa-core-heal-out-/);
});

test('the changelog and the config notes have no long dashes', () => {
  assert.match(changelog, /## 0\.4\.1 \(2026-10-27\)/);
  assert.doesNotMatch(changelog, /[—–]/);
  assert.doesNotMatch(configDoc, /[—–]/);
  assert.match(configDoc, /shadowRuns/);
});
