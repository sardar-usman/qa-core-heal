import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finding } from './helpers/contract.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { weakeningReason } = await import(path.join(repoRoot, 'dist', 'weaken.js'));
const { scratchVerify } = await import(path.join(repoRoot, 'dist', 'scratch.js'));
const { scratchStopEntry } = await import(path.join(repoRoot, 'dist', 'findings-flow.js'));

test('a locator-only rewrite is not a weakening, and a looser or missing assertion is', () => {
  assert.equal(
    weakeningReason(
      "await expect(page.locator('#a')).toBeVisible();\n",
      "await expect(page.locator('#mail-x9')).toBeVisible();\n",
    ),
    null,
  );
  assert.match(
    weakeningReason(
      "await expect(page.locator('#a')).toContainText('hello world');\n",
      "await expect(page.locator('#a')).toContainText('hello');\n",
    ),
    /loosens an assertion/,
  );
  assert.match(
    weakeningReason(
      "await expect(page.getByRole('button', { exact: true })).toBeVisible();\n",
      "await expect(page.getByRole('button')).toBeVisible();\n",
    ),
    /loosens an assertion/,
  );
  assert.match(
    weakeningReason(
      "await expect(page.locator('#a')).toBeVisible({ timeout: 1000 });\n",
      "await expect(page.locator('#a')).toBeVisible({ timeout: 5000 });\n",
    ),
    /loosens an assertion/,
  );
  assert.match(
    weakeningReason(
      "await expect(page.locator('#a')).toBeVisible();\n",
      "await page.locator('#a').click();\n",
    ),
    /removes an assertion/,
  );
  assert.match(
    weakeningReason("assert.equal(1, 1);\n", 'const x = 1;\n'),
    /removes an assertion/,
  );
});

test('scratchVerify refuses a weakened diff before it copies the project', async () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const spec = path.join(dir, 'tests', 'a.spec.ts');
  fs.mkdirSync(path.dirname(spec), { recursive: true });
  const line = "  await expect(page.locator('#a')).toBeVisible();";
  const src = `import { test, expect } from '@playwright/test';\ntest('t', async ({ page }) => {\n${line}\n});\n`;
  fs.writeFileSync(spec, src);
  try {
    const out = await scratchVerify({
      root: dir,
      plan: [{
        file: spec,
        src,
        edits: [{ line: 3, startCol: 0, endLine: 3, endCol: line.length, newRaw: "  await expect(page.locator('#a')).toBeTruthy();" }],
      }],
      selectArgs: ['tests/a.spec.ts'],
      runs: 3,
    });
    assert.equal(out.state, 'weakened');
    assert.equal(out.runs, 0);
    assert.equal(out.passed, 0);
    assert.equal(out.failed, 0);
    assert.equal(fs.existsSync(path.join(dir, '.qa-core')), false);
    const entry = scratchStopEntry(finding(), out);
    assert.equal(entry.status, 'refused');
    assert.equal(entry.refusal.code, 'weakens-test');
    assert.match(entry.explanation, /not proposed/);
    assert.equal(scratchStopEntry(finding(), { state: 'passed', message: 'ok', runs: 1, passed: 1, failed: 0 }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
