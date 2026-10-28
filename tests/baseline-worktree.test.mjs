import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { BASELINE_SHA, repoRoot } from './helpers/baseline.mjs';

test('a reused baseline that is not 8da827d is refused', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ensureBaseline } from './tests/helpers/baseline.mjs';
    ensureBaseline();
  `], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HEAL_BASELINE_ROOT: repoRoot },
  });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stderr}\n${run.stdout}`, new RegExp(BASELINE_SHA));
});

test('ensureBaseline builds 8da827d in a unique worktree and removes it on exit', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import path from 'node:path';
    import { spawnSync } from 'node:child_process';
    import { ensureBaseline, BASELINE_SHA } from './tests/helpers/baseline.mjs';
    const cli = ensureBaseline();
    const root = path.dirname(path.dirname(cli));
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    if (sha !== BASELINE_SHA) process.exit(2);
    process.stdout.write(root + '\\n');
  `], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const root = run.stdout.trim().split('\n').pop();
  assert.ok(root && root.includes('qa-core-heal-042-'), root);
  assert.equal(fs.existsSync(root), false, 'the worktree directory is removed');
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(listed.stdout.includes(root), false);
});
