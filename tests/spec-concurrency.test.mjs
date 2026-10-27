import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { baseOf, repoRoot, rm, runCli, startServer } from './helpers/contract.mjs';

/**
 * Two spec-mode runs at once must not share Playwright's output folder.
 * The URL is only in the trace (a template goto, and no baseURL), so a
 * shared test-results folder can delete the other run's trace.
 */

function traceOnlyProject(base) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, retries: 0, timeout: 20000,
  expect: { timeout: 1500 },
  use: {},
  reporter: [['line']],
});
`);
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
const ORIGIN = ${JSON.stringify(base)};
test('fills mail', async ({ page }) => {
  await page.goto(\`\${ORIGIN}/\`);
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
`);
  return dir;
}

test('several rounds of two spec-mode runs at once each keep a private output folder', async () => {
  const server = await startServer('<html><body><label>Mail <input id="mail-x9" name="email" type="email" /></label></body></html>');
  const dir = traceOnlyProject(baseOf(server));
  try {
    for (let round = 0; round < 3; round++) {
      const runs = await Promise.all([0, 1].map(() => runCli(['tests/a.spec.ts', '--dry-run', '--verbose'], dir)));
      for (const [i, r] of runs.entries()) {
        const text = `${r.stdout}\n${r.stderr}`;
        assert.equal(r.status, 0, `round ${round} run ${i}: ${text}`);
        assert.doesNotMatch(text, /Could not determine the target URL/);
        assert.match(r.stdout, /input\[type="email"\]/);
        const children = r.stderr.split('\n').filter((l) => l.startsWith('[verbose] child:'));
        assert.ok(children.length >= 1, r.stderr);
        const outputs = [];
        for (const c of children) {
          const m = c.match(/--output (\S+)/);
          assert.ok(m, c);
          assert.match(m[1], /qa-core-heal-out-/);
          outputs.push(m[1]);
        }
        for (const o of outputs) {
          const root = o.slice(0, o.indexOf('qa-core-heal-out-') + 'qa-core-heal-out-'.length);
          const full = o.match(/(.*qa-core-heal-out-[^/]+)/)?.[1];
          assert.ok(full, o);
          assert.equal(fs.existsSync(full), false, `${full} was left behind`);
          assert.ok(root);
        }
      }
      assert.equal(fs.existsSync(path.join(dir, 'test-results')), false);
    }
  } finally { server.close(); rm(dir); }
});
