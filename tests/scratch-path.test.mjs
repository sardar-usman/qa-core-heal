import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { fileInRoot } = await import(path.join(repoRoot, 'dist', 'adapters', 'playwright-js', 'index.js'));

test('fileInRoot keeps an absolute spec that is already inside the root', () => {
  const root = path.join(repoRoot, 'space dir');
  const spec = path.join(root, 'tests', 'a.spec.ts');
  assert.equal(fileInRoot(root, spec, 'tests/a.spec.ts'), spec);
});

test('fileInRoot uses specRel when the absolute spec is outside the root', () => {
  const root = path.join(repoRoot, '.qa-core', 'scratch-abc');
  const outside = path.join(repoRoot, 'tests', 'a.spec.ts');
  assert.equal(fileInRoot(root, outside, 'tests/a.spec.ts'), path.join(root, 'tests', 'a.spec.ts'));
});

test('fileInRoot joins a nested specRel that contains spaces', () => {
  const root = path.join(repoRoot, '.qa-core', 'scratch-abc');
  const outside = path.join(repoRoot, 'tests', 'nested dir', 'a.spec.ts');
  assert.equal(
    fileInRoot(root, outside, 'tests/nested dir/a.spec.ts'),
    path.join(root, 'tests', 'nested dir', 'a.spec.ts'),
  );
});

test('fileInRoot normalises a specRel that starts with ./', () => {
  const root = path.join(repoRoot, 'space dir');
  const outside = path.join(repoRoot, 'elsewhere', 'a.spec.ts');
  assert.equal(
    fileInRoot(root, outside, './tests/nested dir/a.spec.ts'),
    path.join(root, 'tests', 'nested dir', 'a.spec.ts'),
  );
});

test('scratch run with a space, a nested directory, and a ./ specRel runs the copied spec', { timeout: 60000 }, async () => {
  const { scratchVerify } = await import(path.join(repoRoot, 'dist', 'scratch.js'));
  const parent = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const dir = path.join(parent, 'space dir');
  const specRel = './tests/nested dir/a.spec.ts';
  const specPath = path.join(dir, 'tests', 'nested dir', 'a.spec.ts');
  const src = `import { test } from '@playwright/test';
test('passes', async () => { throw new Error('ORIGINAL'); });
`;
  const needle = "throw new Error('ORIGINAL');";
  try {
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'),
      "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
    fs.writeFileSync(specPath, src);
    const line = src.split('\n')[1];
    const startCol = line.indexOf(needle);
    const commands = [];
    const out = await scratchVerify({
      root: dir,
      plan: [{
        file: specPath,
        src,
        edits: [{ line: 2, startCol, endLine: 2, endCol: startCol + needle.length, newRaw: 'await Promise.resolve();' }],
      }],
      selection: {
        specPath,
        specRel,
        titlePath: ['passes'],
        line: 2,
      },
      grepTitle: 'passes',
      runs: 1,
      observe: (run) => { commands.push(run.command); },
    });
    assert.equal(out.state, 'passed', out.message);
    assert.equal(commands.length, 1);
    assert.match(commands[0], /tests\/nested dir\/a\\\.spec\\\.ts:2/);
    assert.equal(commands[0].includes(specPath), false);
    assert.equal(fs.readFileSync(specPath, 'utf8'), src);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
