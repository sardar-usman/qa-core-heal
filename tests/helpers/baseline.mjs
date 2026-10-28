import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The 0.4.2 tree the golden diff and the flaky client test compare against. */
export const BASELINE_SHA = '8da827d63849d14fbddde69cccd6f94522a55910';
export const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const headCli = process.env.HEAL_CLI_JS || path.join(repoRoot, 'dist', 'cli.js');

/** A worktree this process created. Removed on exit. A caller-supplied root is left alone. */
let ownedRoot = null;

function headSha(root) {
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (rev.status !== 0) return '';
  return rev.stdout.trim();
}

function removeOwned() {
  if (!ownedRoot) return;
  const root = ownedRoot;
  ownedRoot = null;
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

function assertBaseline(root) {
  const sha = headSha(root);
  if (sha !== BASELINE_SHA) {
    throw new Error(`The baseline at ${root} is ${sha || 'unreadable'}, not ${BASELINE_SHA}.`);
  }
  const cli = path.join(root, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error(`No built CLI at ${cli}.`);
  return cli;
}

/**
 * Build the 0.4.2 CLI in a new git worktree, or reuse one this process already
 * built. HEAL_BASELINE_ROOT reuses a caller-supplied tree only when its HEAD
 * is 8da827d. That tree is not removed.
 */
export function ensureBaseline() {
  const given = process.env.HEAL_BASELINE_ROOT;
  if (given) return assertBaseline(given);
  if (ownedRoot) return assertBaseline(ownedRoot);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-042-'));
  ownedRoot = root;
  process.once('exit', removeOwned);
  ensureCommitPresent(BASELINE_SHA);
  const add = spawnSync('git', ['worktree', 'add', '--detach', root, BASELINE_SHA], {
    cwd: repoRoot, encoding: 'utf8',
  });
  if (add.status !== 0) {
    removeOwned();
    throw new Error(add.stderr || add.stdout || 'git worktree add failed');
  }
  if (headSha(root) !== BASELINE_SHA) {
    removeOwned();
    throw new Error(`The new worktree is ${headSha(root) || 'unreadable'}, not ${BASELINE_SHA}.`);
  }
  const ci = spawnSync('npm', ['ci'], { cwd: root, encoding: 'utf8' });
  if (ci.status !== 0) {
    removeOwned();
    throw new Error(ci.stderr || 'npm ci failed in the 0.4.2 worktree');
  }
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) {
    removeOwned();
    throw new Error(build.stderr || 'build failed in the 0.4.2 worktree');
  }
  return assertBaseline(root);
}
