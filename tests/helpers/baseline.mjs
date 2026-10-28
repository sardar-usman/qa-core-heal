import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The 0.4.2 tree the golden diff and the flaky client test compare against. */
export const BASELINE_SHA = '8da827d63849d14fbddde69cccd6f94522a55910';
export const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const baselineRoot = process.env.HEAL_BASELINE_ROOT || '/tmp/qa-core-heal-042';
export const baselineCli = path.join(baselineRoot, 'dist', 'cli.js');
export const headCli = process.env.HEAL_CLI_JS || path.join(repoRoot, 'dist', 'cli.js');

/** Build the 0.4.2 CLI in a git worktree when it is not already built. */
export function ensureBaseline() {
  if (fs.existsSync(baselineCli)) return baselineCli;
  fs.mkdirSync(path.dirname(baselineRoot), { recursive: true });
  if (!fs.existsSync(path.join(baselineRoot, 'package.json'))) {
    const add = spawnSync('git', ['worktree', 'add', '--detach', baselineRoot, BASELINE_SHA], {
      cwd: repoRoot, encoding: 'utf8',
    });
    if (add.status !== 0) throw new Error(add.stderr || add.stdout || 'git worktree add failed');
  }
  const ci = spawnSync('npm', ['ci'], { cwd: baselineRoot, encoding: 'utf8' });
  if (ci.status !== 0) throw new Error(ci.stderr || 'npm ci failed in the 0.4.2 worktree');
  const build = spawnSync('npm', ['run', 'build'], { cwd: baselineRoot, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(build.stderr || 'build failed in the 0.4.2 worktree');
  return baselineCli;
}
