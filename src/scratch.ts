import fs from 'node:fs';
import path from 'node:path';
import { renderHealPlan, type HealPlanEntry } from './heal.js';
import { runSelected } from './targeted.js';

/**
 * A one-run check of a proposed heal in a scratch copy of the project.
 *
 * The proposal is written into a temporary copy, the selected test runs
 * there once, and the copy is deleted. The real files are never touched.
 * The copy lives under <project>/.qa-core/ so that node_modules is found
 * by the normal folder walk (also in a monorepo), and it leaves out
 * node_modules, .git and the usual report folders.
 *
 * This is the smallest check that lets a locator heal be shown as a
 * proposal. Repeated runs, a baseline run in the copy and the weakening
 * guard come in a later release.
 */

/** Largest project copy this check will make. A bigger project is reported as unverifiable. */
export const MAX_COPY_BYTES = 256 * 1024 * 1024;

const SKIP_DIRS = new Set(['node_modules', '.git', '.qa-core', 'test-results', 'playwright-report', 'blob-report']);

export type ScratchOutcome =
  | { state: 'passed'; message: string }
  | { state: 'failed'; message: string }
  | { state: 'timeout'; message: string }
  | { state: 'unavailable'; message: string };

export interface ScratchOptions {
  root: string;
  plan: HealPlanEntry[];
  /** The exact selection arguments of the targeted run. */
  selectArgs: string[];
  timeoutMs?: number;
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

export function scratchVerify(opts: ScratchOptions): ScratchOutcome {
  const root = fs.realpathSync(opts.root);
  const rendered = renderHealPlan(opts.plan);
  for (const r of rendered) {
    const rel = path.relative(root, fs.realpathSync(r.file));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { state: 'unavailable', message: 'A file the heal would change is outside the project folder, so it cannot be checked in a copy.' };
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
        return { state: 'unavailable', message: `The project is larger than ${MAX_COPY_BYTES / (1024 * 1024)} MB without node_modules, so it was not copied for the check.` };
      }
      return { state: 'unavailable', message: `The project could not be copied for the check: ${(e as Error).message}` };
    }
    for (const r of rendered) {
      fs.writeFileSync(path.join(scratch, path.relative(root, fs.realpathSync(r.file))), r.after);
    }
    const one = runSelected(scratch, opts.selectArgs, [], opts.timeoutMs);
    if (one.kind === 'timeout') return { state: 'timeout', message: 'The re-run in the copy timed out.' };
    if (one.kind === 'error') return { state: 'unavailable', message: one.message };
    if (one.status === 'expected' && one.run.status === 0) {
      return { state: 'passed', message: 'The test passed once in a scratch copy with the proposed change.' };
    }
    if (one.status === 'flaky') {
      return { state: 'failed', message: 'The test passed only on a retry in a scratch copy, which is not enough to propose the change.' };
    }
    if (one.status === 'skipped') return { state: 'unavailable', message: 'The test was skipped in the scratch copy.' };
    return { state: 'failed', message: `The test still failed in a scratch copy with the proposed change: ${one.test.message.split('\n').find((l) => l.trim()) ?? 'no message'}` };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (!baseExisted) {
      try { fs.rmdirSync(base); } catch { /* not empty, leave it */ }
    }
  }
}
