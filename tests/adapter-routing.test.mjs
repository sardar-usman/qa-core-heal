import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { resolveTarget } = await import(path.join(repoRoot, 'dist', 'targeted.js'));
const { registerAdapter, unregisterAdapter, useAdapter } = await import(path.join(repoRoot, 'dist', 'adapters', 'index.js'));
const { setPlaywrightSpawnObserver } = await import(path.join(repoRoot, 'dist', 'adapters', 'playwright-js', 'cli.js'));
const { detectFramework } = await import(path.join(repoRoot, 'dist', 'adapters', 'detect.js'));

test('resolveTarget uses the active adapter and does not spawn Playwright', async () => {
  const cliSrc = fs.readFileSync(path.join(repoRoot, 'src', 'cli.ts'), 'utf8');
  const findingsSrc = fs.readFileSync(path.join(repoRoot, 'src', 'findings-flow.ts'), 'utf8');
  assert.match(cliSrc, /resolveTarget\(/);
  assert.match(findingsSrc, /resolveTarget\(/);
  assert.doesNotMatch(cliSrc, /runPlaywrightCli\(/);
  assert.doesNotMatch(findingsSrc, /runPlaywrightCli\(/);
  assert.doesNotMatch(cliSrc, /\blistTests\(/);
  assert.doesNotMatch(findingsSrc, /\blistTests\(/);

  const root = path.join(os.tmpdir(), 'qa-core-heal-stub-root');
  const file = path.join(root, 'tests', 'a.spec.ts');
  const queries = [];
  const spawns = [];
  setPlaywrightSpawnObserver((notice) => { spawns.push(notice); });
  registerAdapter({
    id: 'cypress-js',
    enabled: true,
    async listTests(_root, query) {
      queries.push(query);
      return {
        ok: true,
        tests: [{ file, line: 12, titlePath: ['login'], project: 'chromium' }],
      };
    },
  });
  try {
    useAdapter('cypress-js');
    const res = await resolveTarget({
      root,
      file,
      title: 'login',
      project: null,
      match: (t) => t.titlePath.at(-1) === 'login',
    });
    assert.equal(res.kind, 'resolved');
    assert.equal(queries.length, 2);
    assert.equal(queries[0].specPath, file);
    assert.equal(queries[0].title, null);
    assert.equal(queries[0].line, null);
    assert.equal(queries[1].title, 'login');
    assert.equal(queries[1].line, 12);
    assert.equal(queries[1].project, 'chromium');
    assert.equal(res.selection.specRel, 'tests/a.spec.ts');
    assert.deepEqual(spawns, []);
  } finally {
    setPlaywrightSpawnObserver(null);
    unregisterAdapter('cypress-js');
    useAdapter('playwright-js');
  }
});

test('a disabled adapter reports planned', () => {
  registerAdapter({
    id: 'cypress-js',
    enabled: false,
    detect(dir) {
      return fs.existsSync(path.join(dir, 'adapter-marker.txt'))
        ? { id: 'cypress-js', reason: 'adapter-marker.txt' }
        : null;
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-disabled-'));
  try {
    fs.writeFileSync(path.join(dir, 'adapter-marker.txt'), 'marker\n');
    const found = detectFramework({ root: dir });
    assert.equal(found.ok, false);
    assert.equal(found.message, 'cypress-js is planned and is not supported yet. Nothing was run.');
    const flagged = detectFramework({ root: dir, flag: 'cypress-js' });
    assert.equal(flagged.ok, false);
    assert.equal(flagged.message, 'cypress-js is planned and is not supported yet. Nothing was run.');
  } finally {
    unregisterAdapter('cypress-js');
    useAdapter('playwright-js');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
