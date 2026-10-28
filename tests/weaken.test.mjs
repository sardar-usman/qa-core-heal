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
      "await expect(page.locator('#a')).toHaveText('Hello', { exact: true });\n",
      "await expect(page.locator('#a')).toHaveText('Hello');\n",
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
  assert.equal(
    weakeningReason(
      "await expect(page.locator('#a')).toBeVisible();\n// expect(page.locator('#b')).toBeVisible();\n",
      "await expect(page.locator('#mail')).toBeVisible();\n// expect(page.locator('#b')).toBeVisible();\n",
    ),
    null,
  );
});

test('the six hidden or skipped assertion cases are a weakening', () => {
  const expectLine = "await expect(page.locator('#a')).toBeVisible();\n";
  assert.match(weakeningReason(expectLine, `// ${expectLine}`), /removes an assertion/);
  assert.match(weakeningReason(expectLine, `/* ${expectLine.trim()} */\n`), /removes an assertion/);
  assert.match(
    weakeningReason(expectLine, `const s = "await expect(page.locator('#a')).toBeVisible();";\n`),
    /removes an assertion/,
  );
  assert.match(
    weakeningReason("await expect.soft(page.locator('#a')).toBeVisible();\n", "await page.locator('#a').click();\n"),
    /removes an assertion: expect\.soft/,
  );
  assert.match(
    weakeningReason("await expect.poll(() => 1).toBe(1);\n", "const x = 1;\n"),
    /removes an assertion: expect\.poll/,
  );
  assert.match(
    weakeningReason(
      "test('t', async ({ page }) => {\n  await expect(page.locator('#a')).toBeVisible();\n});\n",
      "test.skip('t', async ({ page }) => {\n  await expect(page.locator('#a')).toBeVisible();\n});\n",
    ),
    /skips a test/,
  );
});

test('swapping expect for expect.soft or expect.poll is a weakening', () => {
  const before = "await expect(page.locator('#a')).toBeVisible();\n";
  assert.match(
    weakeningReason(before, "await expect.soft(page.locator('#a')).toBeVisible();\n"),
    /loosens an assertion: expect\(\.\.\.\)\.toBeVisible\(\) becomes expect\.soft/,
  );
  assert.match(
    weakeningReason(before, "await expect.poll(page.locator('#a')).toBeVisible();\n"),
    /loosens an assertion: expect\(\.\.\.\)\.toBeVisible\(\) becomes expect\.poll/,
  );
  assert.match(
    weakeningReason(
      "await expect.soft(page.locator('#a')).toBeVisible();\n",
      "await expect.poll(page.locator('#a')).toBeVisible();\n",
    ),
    /loosens an assertion/,
  );
  assert.equal(
    weakeningReason("await expect.soft(page.locator('#a')).toBeVisible();\n", before),
    null,
  );
});

test('an added test.fixme or test.describe.fixme skips a test', () => {
  const body = "test('t', async () => {\n  await expect(page.locator('#a')).toBeVisible();\n});\n";
  assert.match(weakeningReason(body, body.replace("test('t'", "test.fixme('t'")), /skips a test/);
  assert.match(
    weakeningReason(
      "test.describe('d', () => {\n  test('t', async () => {\n    await expect(page.locator('#a')).toBeVisible();\n  });\n});\n",
      "test.describe.fixme('d', () => {\n  test('t', async () => {\n    await expect(page.locator('#a')).toBeVisible();\n  });\n});\n",
    ),
    /skips a test/,
  );
  assert.equal(weakeningReason(body, body), null);
});

test('a regex literal does not hide a later expect, and a template expression counts', () => {
  const withRe = "const re = /it's/;\nawait expect(page.locator('#a')).toBeVisible();\n";
  assert.match(
    weakeningReason(withRe, "const re = /it's/;\nawait page.locator('#a').click();\n"),
    /removes an assertion/,
  );
  const klass = "const re = /['\"]/;\nawait expect(page.locator('#a')).toBeVisible();\n";
  assert.match(weakeningReason(klass, "const re = /['\"]/;\n"), /removes an assertion/);
  const div = "const n = a / b;\nawait expect(page.locator('#a')).toBeVisible();\n";
  assert.match(weakeningReason(div, "const n = a / b;\n"), /removes an assertion/);
  const interp = 'const s = `hello ${expect(page.locator(\'#a\')).toBeVisible()}`;\n';
  assert.match(weakeningReason(interp, 'const s = `hello ${1}`;\n'), /removes an assertion/);
  const nested = 'const s = `a ${`b ${expect(page.locator(\'#a\')).toBeVisible()}`}`;\n';
  assert.match(weakeningReason(nested, 'const s = `a ${1}`;\n'), /removes an assertion/);
  assert.equal(
    weakeningReason(
      'const s = `expect(page.locator(\'#a\')).toBeVisible()`;\n',
      'const s = `gone`;\n',
    ),
    null,
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
