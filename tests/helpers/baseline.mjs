import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The 0.4.2 tree the flaky client test compares against. */
export const BASELINE_SHA = '8da827d63849d14fbddde69cccd6f94522a55910';
/** The 0.5.0 tree the golden diff compares against. */
export const GOLDEN_BASELINE_SHA = '37ff5a1bbe8ee28fb488bc15d18eddebe0c2d6fb';
export const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const headCli = process.env.HEAL_CLI_JS || path.join(repoRoot, 'dist', 'cli.js');

/** Worktrees this process created, keyed by commit. Removed on exit. A caller-supplied root is left alone. */
const ownedRoots = new Map();

function headSha(root) {
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (rev.status !== 0) return '';
  return rev.stdout.trim();
}

function removeOwned(sha) {
  const root = ownedRoots.get(sha);
  if (!root) return;
  ownedRoots.delete(sha);
  spawnSync('git', ['worktree', 'remove', '--force', root], { cwd: repoRoot, encoding: 'utf8' });
  fs.rmSync(root, { recursive: true, force: true });
}

function ensureCommitPresent(sha) {
  const has = spawnSync('git', ['cat-file', '-t', sha], { cwd: repoRoot, encoding: 'utf8' });
  if (has.status === 0) return;
  // CI checks out a shallow commit, so 8da827d is not local until it is fetched.
  const fetch = spawnSync('git', ['fetch', '--depth', '1', 'origin', sha], {
    cwd: repoRoot, encoding: 'utf8',
  });
  if (fetch.status !== 0) {
    throw new Error(fetch.stderr || fetch.stdout || `could not fetch ${sha}`);
  }
}

function assertBaseline(root, sha) {
  const found = headSha(root);
  if (found !== sha) {
    throw new Error(`The baseline at ${root} is ${found || 'unreadable'}, not ${sha}.`);
  }
  const cli = path.join(root, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error(`No built CLI at ${cli}.`);
  return cli;
}

/**
 * Build one commit's CLI in a new git worktree, or reuse one this process
 * already built. A caller-supplied root is used only when its HEAD is `sha`.
 * That tree is not removed.
 */
export function ensureBaselineAt(sha, prefix, given) {
  if (given) return assertBaseline(given, sha);
  const existing = ownedRoots.get(sha);
  if (existing) return assertBaseline(existing, sha);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ownedRoots.set(sha, root);
  process.once('exit', () => removeOwned(sha));
  ensureCommitPresent(sha);
  const add = spawnSync('git', ['worktree', 'add', '--detach', root, sha], {
    cwd: repoRoot, encoding: 'utf8',
  });
  if (add.status !== 0) {
    removeOwned(sha);
    throw new Error(add.stderr || add.stdout || 'git worktree add failed');
  }
  if (headSha(root) !== sha) {
    removeOwned(sha);
    throw new Error(`The new worktree is ${headSha(root) || 'unreadable'}, not ${sha}.`);
  }
  const ci = spawnSync('npm', ['ci'], { cwd: root, encoding: 'utf8' });
  if (ci.status !== 0) {
    removeOwned(sha);
    throw new Error(ci.stderr || `npm ci failed in the ${sha} worktree`);
  }
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) {
    removeOwned(sha);
    throw new Error(build.stderr || `build failed in the ${sha} worktree`);
  }
  return assertBaseline(root, sha);
}

/**
 * Build the 0.4.2 CLI in a new git worktree, or reuse one this process already
 * built. HEAL_BASELINE_ROOT reuses a caller-supplied tree only when its HEAD
 * is 8da827d. That tree is not removed.
 */
export function ensureBaseline() {
  return ensureBaselineAt(BASELINE_SHA, 'qa-core-heal-042-', process.env.HEAL_BASELINE_ROOT);
}

/** Build the 0.5.0 CLI the golden diff compares against. */
export function ensureGoldenBaseline() {
  return ensureBaselineAt(GOLDEN_BASELINE_SHA, 'qa-core-heal-050-', process.env.HEAL_GOLDEN_BASELINE_ROOT);
}
