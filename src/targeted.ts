import fs from 'node:fs';
import path from 'node:path';
import { activeAdapter } from './adapters/index.js';
import type { ChildRun, TestSelection } from './adapters/types.js';

/**
 * Targeted per-test runs.
 *
 * The core asks the active adapter to list tests. It does not start a
 * runner itself. The selection is checked twice: the test must be the
 * only match in the file, and the exact filter must list exactly one
 * test. If either check finds a different count, nothing is run.
 */

export interface ListedTest {
  /** Absolute path of the spec file. */
  file: string;
  line: number;
  /** Describe titles followed by the test title. */
  titlePath: string[];
  project: string | null;
}

export type RunObserver = (run: ChildRun) => void;

/** Real path when the file exists, the input otherwise. Compares paths across symbolic links. */
export function realPathOf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * A finding's title path may carry the project name or the file name in
 * front, depending on the writer. Those leading parts are not part of the
 * path the runner reports, so they are dropped before comparing.
 */
export function normalizeTitlePath(titlePath: string[], project: string, file: string): string[] {
  const out = [...titlePath];
  const lead = new Set(['', project, file, path.basename(file)].filter((x) => x !== undefined));
  while (out.length > 1 && lead.has(out[0]!)) out.shift();
  return out;
}

const sameTitle = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export interface TargetSpec {
  /** Project root: the folder the adapter runs in. */
  root: string;
  /** Absolute spec path. */
  file: string;
  /** Pick the test inside the file. */
  match: (t: ListedTest) => boolean;
  /** The test title, used for the narrowing list. */
  title: string;
  /** Project name; empty or null means no project filter. */
  project?: string | null;
  timeoutMs?: number | (() => number | undefined);
  observe?: RunObserver;
  /** Config file for every list call, relative to `root`. Unset means the adapter finds its own. */
  config?: string | null;
  /** A private output folder for the list calls, so concurrent runs do not clear each other's files. */
  outputDir?: string;
}

export type Resolution =
  | {
      kind: 'resolved';
      /** The test the adapter runs. The adapter builds the runner arguments. */
      selection: TestSelection;
      /** The grep title. Null is not used here: a resolved test always has one. */
      grepTitle: string;
      project: string | null;
      config: string | null;
      test: ListedTest;
      /** Declaration lines of every test in the file, ascending. */
      startLines: number[];
    }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'error'; message: string; timedOut?: boolean };

/** Find exactly one test, without running anything. Both callers use this. */
export async function resolveTarget(spec: TargetSpec): Promise<Resolution> {
  const adapter = activeAdapter();
  const listOpts = { timeoutMs: spec.timeoutMs, observe: spec.observe, outputDir: spec.outputDir };
  const all = await adapter.listTests(spec.root, {
    specPath: spec.file,
    project: spec.project ?? null,
    line: null,
    title: null,
    config: spec.config ?? null,
  }, listOpts);
  if (!all.ok) return { kind: 'error', message: all.error ?? 'Could not list the tests.', timedOut: all.timedOut };
  const wantFile = realPathOf(spec.file);
  const found = all.tests.filter((t) => realPathOf(t.file) === wantFile && spec.match(t));
  if (found.length === 0) return { kind: 'not-found' };
  if (found.length > 1) return { kind: 'ambiguous', count: found.length };
  const test = found[0]!;
  const project = spec.project ?? test.project ?? null;
  const config = spec.config ?? null;
  const line = test.line > 0 ? test.line : 0;
  // The exact filter must list exactly one test. A line shared by several
  // tests (a loop) or a title that is part of another title shows up here,
  // before anything has run.
  const exact = await adapter.listTests(spec.root, {
    specPath: spec.file,
    project,
    line: line > 0 ? line : null,
    title: spec.title,
    config,
  }, listOpts);
  if (!exact.ok) return { kind: 'error', message: exact.error ?? 'Could not list the tests.', timedOut: exact.timedOut };
  if (exact.tests.length === 0) return { kind: 'not-found' };
  if (exact.tests.length !== 1) return { kind: 'ambiguous', count: exact.tests.length };
  const startLines = [...new Set(all.tests.map((t) => t.line).filter((l) => l > 0))].sort((a, b) => a - b);
  return {
    kind: 'resolved',
    selection: {
      specPath: spec.file,
      specRel: path.relative(spec.root, spec.file).split(path.sep).join('/'),
      titlePath: test.titlePath,
      line,
    },
    grepTitle: spec.title,
    project,
    config,
    test,
    startLines,
  };
}

/** The match function for a finding: same file (checked by the caller), same title path, same project. */
export function matchFinding(titlePath: string[], project: string, fileRel: string): (t: ListedTest) => boolean {
  const want = normalizeTitlePath(titlePath, project, fileRel);
  return (t) => sameTitle(t.titlePath, want) && (project === '' || t.project === project);
}

/** The match function for --test: the test title, or the full title path joined with ›  or >. */
export function matchTitle(value: string): (t: ListedTest) => boolean {
  return (t) => {
    const last = t.titlePath[t.titlePath.length - 1];
    return last === value || t.titlePath.join(' › ') === value || t.titlePath.join(' > ') === value;
  };
}
