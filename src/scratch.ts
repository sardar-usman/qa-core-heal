import fs from 'node:fs';
import path from 'node:path';
import { renderHealPlan, type HealPlanEntry } from './heal.js';
import { outputArgs, runSelected, type RunObserver } from './targeted.js';
import { weakeningReason } from './weaken.js';

/**
 * A check of a proposed heal in a scratch copy of the project.
 *
 * The proposal is written into a temporary copy, the selected test runs
 * there the requested number of times, and the copy is deleted. The real
 * files are never touched. The copy lives under <project>/.qa-core/ so
 * that node_modules is found by the normal folder walk (also in a
 * monorepo), and it leaves out node_modules, .git and the usual report
 * folders.
 *
 * A diff that removes or loosens an assertion is refused before anything
 * is copied. Every requested run must pass. One failure stops the check.
 */

/** Largest project copy this check will make. A bigger project is reported as unverifiable. */
export const MAX_COPY_BYTES = 256 * 1024 * 1024;

const SKIP_DIRS = new Set(['node_modules', '.git', '.qa-core', 'test-results', 'playwright-report', 'blob-report']);

export type ScratchOutcome = {
  state: 'passed' | 'failed' | 'timeout' | 'unavailable' | 'weakened';
  message: string;
  /** Shadow runs that were started. Zero when the diff was refused first. */
  runs: number;
  passed: number;
  failed: number;
};

export interface ScratchOptions {
  root: string;
  plan: HealPlanEntry[];
  /** The exact selection arguments of the targeted run. */
  selectArgs: string[];
  timeoutMs?: number;
  /** How many times the changed test must pass. Default 1. The CLI default is 3. */
  runs?: number;
  /** A private Playwright output folder for the runs. */
  outputDir?: string;
  /** Called with the finished child run, for --verbose. */
  observe?: RunObserver;
}

/**
 * Copy the project into the scratch folder, which sits inside it. Node's
 * own recursive copy refuses a destination inside its source, so this walks
 * the tree by hand. Symbolic links are copied as links.
 */
function copyTree(src: string, dst: string, root: string, state = { bytes: 0 }): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else if (entry.isDirectory()) {
      fs.mkdirSync(to);
      copyTree(from, to, root, state);
    } else if (entry.isFile()) {
      state.bytes += fs.statSync(from).size;
      if (state.bytes > MAX_COPY_BYTES) throw new Error('COPY_TOO_LARGE');
      fs.copyFileSync(from, to);
    }
  }
}

export async function scratchVerify(opts: ScratchOptions): Promise<ScratchOutcome> {
  const runs = opts.runs ?? 1;
  const rendered = renderHealPlan(opts.plan);
  for (const r of rendered) {
    const why = weakeningReason(r.before, r.after);
    if (why) return { state: 'weakened', message: why, runs: 0, passed: 0, failed: 0 };
  }
  const root = fs.realpathSync(opts.root);
  for (const r of rendered) {
    const rel = path.relative(root, fs.realpathSync(r.file));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { state: 'unavailable', message: 'A file the heal would change is outside the project folder, so it cannot be checked in a copy.', runs: 0, passed: 0, failed: 0 };
    }
  }
  const base = path.join(root, '.qa-core');
  const baseExisted = fs.existsSync(base);
  let scratch: string | null = null;
  try {
    fs.mkdirSync(base, { recursive: true });
    scratch = fs.mkdtempSync(path.join(base, 'scratch-'));
    try {
      copyTree(root, scratch, root);
    } catch (e) {
      if ((e as Error).message === 'COPY_TOO_LARGE') {
        return { state: 'unavailable', message: `The project is larger than ${MAX_COPY_BYTES / (1024 * 1024)} MB without node_modules, so it was not copied for the check.`, runs: 0, passed: 0, failed: 0 };
      }
      return { state: 'unavailable', message: `The project could not be copied for the check: ${(e as Error).message}`, runs: 0, passed: 0, failed: 0 };
    }
    for (const r of rendered) {
      fs.writeFileSync(path.join(scratch, path.relative(root, fs.realpathSync(r.file))), r.after);
    }
    let passed = 0;
    for (let i = 1; i <= runs; i++) {
      if (opts.outputDir) fs.rmSync(opts.outputDir, { recursive: true, force: true });
      const one = await runSelected(scratch, opts.selectArgs, outputArgs(opts.outputDir), opts.timeoutMs, opts.observe);
      if (one.kind === 'timeout') return { state: 'timeout', message: 'The re-run in the copy timed out.', runs: i, passed, failed: 0 };
      if (one.kind === 'error') return { state: 'unavailable', message: one.message, runs: i, passed, failed: 0 };
      if (one.status === 'expected' && one.run.status === 0) { passed++; continue; }
      if (one.status === 'flaky') {
        return { state: 'failed', message: 'The test passed only on a retry in a scratch copy, which is not enough to propose the change.', runs: i, passed, failed: 1 };
      }
      if (one.status === 'skipped') return { state: 'unavailable', message: 'The test was skipped in the scratch copy.', runs: i, passed, failed: 0 };
      const line = one.test.message.split('\n').find((l) => l.trim()) ?? 'no message';
      return {
        state: 'failed',
        message: `The test did not pass every shadow run (${passed} of ${runs} passed): ${line}`,
        runs: i, passed, failed: 1,
      };
    }
    const times = runs === 1 ? 'once' : `${runs} times`;
    return { state: 'passed', message: `The test passed ${times} in a scratch copy with the proposed change.`, runs, passed, failed: 0 };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (!baseExisted) {
      try { fs.rmdirSync(base); } catch { /* not empty, leave it */ }
    }
  }
}
