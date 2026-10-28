import fs from 'node:fs';
import path from 'node:path';
import type { TestSelection } from './adapters/types.js';
import { escapeRegex } from './selectors.js';
import { runPlaywrightCli, toCliFileFilter, type PlaywrightRunResult } from './playwright-cli.js';
import { collectTests, parseJsonReport, stripAnsi, type TestOutcome } from './run.js';

/**
 * Targeted per-test runs.
 *
 * A normal heal run executes a whole spec file, so it can see a different
 * failure than the one a finding is about. Here one test is selected first
 * with `playwright test --list` (nothing runs), then run with a filter that
 * names its file and declaration line. The selection is checked twice: the
 * test must be the only match in the file, and the exact run filter must
 * list exactly one test. If either check finds a different count, nothing
 * is run.
 */

export interface ListedTest {
  /** Absolute path of the spec file. */
  file: string;
  line: number;
  /** Describe titles followed by the test title. */
  titlePath: string[];
  project: string | null;
}

export interface ListOutcome {
  ok: boolean;
  tests: ListedTest[];
  error?: string;
  timedOut?: boolean;
}

interface RawSpec { title: string; file: string; line?: number; tests?: Array<{ projectName?: string }> }
interface RawSuite { title?: string; specs?: RawSpec[]; suites?: RawSuite[] }

export type RunObserver = (run: PlaywrightRunResult) => void;

const BUFFER = 64 * 1024 * 1024;

/** Real path when the file exists, the input otherwise. Compares paths across symbolic links. */
export function realPathOf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** One short line about a failed child run: the exit status and the first error line, with no local paths. */
export function shortRunFailure(run: PlaywrightRunResult): string {
  if (run.error) return `The Playwright process could not start (${(run.error as NodeJS.ErrnoException).code ?? 'spawn error'}).`;
  const lines = stripAnsi(run.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => /^Error:/.test(l)) ?? lines[0] ?? 'no error output';
  return `Playwright exited with status ${run.status ?? 'unknown'}: ${first.replace(/\s+at .*$/, '')}`;
}

/** The `--output` argument pair for a private output folder, or nothing. */
export function outputArgs(dir?: string): string[] {
  return dir ? ['--output', dir] : [];
}

/** Run `playwright test --list` with the given selection arguments. */
export async function listTests(root: string, selectArgs: string[], timeoutMs?: number | (() => number | undefined), observe?: RunObserver, outputDir?: string): Promise<ListOutcome> {
  const run = await runPlaywrightCli(root, ['test', '--list', '--reporter=json', ...selectArgs, ...outputArgs(outputDir)], BUFFER, undefined, timeoutMs);
  observe?.(run);
  if (run.timedOut) return { ok: false, tests: [], timedOut: true, error: 'Listing the tests timed out.' };
  const report = parseJsonReport(run.stdout) as { config?: { rootDir?: string }; suites?: RawSuite[] } | null;
  if (!report) {
    // Playwright exits non-zero with no JSON when nothing matches.
    if (/No tests found/i.test(`${run.stdout}\n${run.stderr}`)) return { ok: true, tests: [] };
    return { ok: false, tests: [], error: `Could not list the tests. ${shortRunFailure(run)}` };
  }
  const rootDir = report.config?.rootDir ?? root;
  const out: ListedTest[] = [];
  const walk = (s: RawSuite, titles: string[]): void => {
    for (const spec of s.specs ?? []) {
      const projects = (spec.tests ?? []).map((t) => t.projectName ?? null);
      for (const project of projects.length > 0 ? projects : [null]) {
        out.push({ file: path.resolve(rootDir, spec.file), line: spec.line ?? 0, titlePath: [...titles, spec.title], project });
      }
    }
    for (const child of s.suites ?? []) walk(child, [...titles, child.title ?? '']);
  };
  // The top-level suites are files; their titles are not part of the title path.
  for (const top of report.suites ?? []) walk(top, []);
  return { ok: true, tests: out };
}

/**
 * A finding's title path may carry the project name or the file name in
 * front, depending on the writer. Those leading parts are not part of the
 * path Playwright reports, so they are dropped before comparing.
 */
export function normalizeTitlePath(titlePath: string[], project: string, file: string): string[] {
  const out = [...titlePath];
  const lead = new Set(['', project, file, path.basename(file)].filter((x) => x !== undefined));
  while (out.length > 1 && lead.has(out[0]!)) out.shift();
  return out;
}

const sameTitle = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export interface TargetSpec {
  /** Project root: the folder Playwright runs in. */
  root: string;
  /** Absolute spec path. */
  file: string;
  /** Pick the test inside the file. */
  match: (t: ListedTest) => boolean;
  /** The test title, used for the narrowing grep. */
  title: string;
  /** Playwright project name; empty or null means no project filter. */
  project?: string | null;
  timeoutMs?: number | (() => number | undefined);
  observe?: RunObserver;
  /** Config file for every Playwright call, relative to `root`. Unset means Playwright finds its own. */
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

/** Selection arguments for one file, optionally pinned to a line. */
export function selectionArgs(root: string, file: string, project: string | null | undefined, line: number | null, title: string | null, config?: string | null): string[] {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const args = [`${toCliFileFilter(rel)}${line ? `:${line}` : ''}`];
  if (config) args.push('--config', config);
  if (project) args.push('--project', project);
  if (title !== null) args.push('--grep', escapeRegex(title));
  return args;
}

/** Find exactly one test, without running anything. */
export async function resolveTarget(spec: TargetSpec): Promise<Resolution> {
  const all = await listTests(spec.root, selectionArgs(spec.root, spec.file, spec.project, null, null, spec.config), spec.timeoutMs, spec.observe, spec.outputDir);
  if (!all.ok) return { kind: 'error', message: all.error ?? 'Could not list the tests.', timedOut: all.timedOut };
  const wantFile = realPathOf(spec.file);
  const found = all.tests.filter((t) => realPathOf(t.file) === wantFile && spec.match(t));
  if (found.length === 0) return { kind: 'not-found' };
  if (found.length > 1) return { kind: 'ambiguous', count: found.length };
  const test = found[0]!;
  const project = spec.project ?? test.project ?? null;
  const config = spec.config ?? null;
  const line = test.line > 0 ? test.line : 0;
  const selectArgs = selectionArgs(spec.root, spec.file, project, line > 0 ? line : null, spec.title, config);
  // The exact run filter must list exactly one test. A line shared by
  // several tests (a loop) or a title that is part of another title shows
  // up here, before anything has run.
  const exact = await listTests(spec.root, selectArgs, spec.timeoutMs, spec.observe, spec.outputDir);
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

export type OneRun =
  | { kind: 'ran'; run: PlaywrightRunResult; report: { config?: { rootDir?: string } }; test: TestOutcome; status: string }
  | { kind: 'timeout'; run: PlaywrightRunResult }
  | { kind: 'error'; message: string; run: PlaywrightRunResult };

interface RawResult { status?: string }
interface RawTest { status?: string; results?: RawResult[] }
interface RawRunSpec { tests?: RawTest[] }
interface RawRunSuite { specs?: RawRunSpec[]; suites?: RawRunSuite[] }

/** Playwright's own status for each test in a JSON report (expected, unexpected, flaky, skipped). */
function testStatuses(report: { suites?: RawRunSuite[] }): string[] {
  const out: string[] = [];
  const walk = (s: RawRunSuite): void => {
    for (const spec of s.specs ?? []) out.push(spec.tests?.[0]?.status ?? 'unknown');
    for (const c of s.suites ?? []) walk(c);
  };
  for (const s of report.suites ?? []) walk(s);
  return out;
}

/**
 * Run the selected test once, from a project root, and require that exactly
 * one test ran.
 */
export async function runSelected(root: string, selectArgs: string[], extraArgs: string[], timeoutMs?: number | (() => number | undefined), observe?: RunObserver): Promise<OneRun> {
  const run = await runPlaywrightCli(root, ['test', ...selectArgs, '--reporter=json', ...extraArgs], BUFFER, undefined, timeoutMs);
  observe?.(run);
  if (run.timedOut) return { kind: 'timeout', run };
  const report = parseJsonReport(run.stdout) as { config?: { rootDir?: string }; suites?: RawRunSuite[] } | null;
  if (!report) return { kind: 'error', message: `Could not run the test (no JSON report). ${shortRunFailure(run)}`, run };
  const tests = collectTests(report as Parameters<typeof collectTests>[0]);
  if (tests.length !== 1) {
    return { kind: 'error', message: `The targeted run reported ${tests.length} tests, but exactly one was expected.`, run };
  }
  return { kind: 'ran', run, report, test: tests[0]!, status: testStatuses(report)[0] ?? 'unknown' };
}
