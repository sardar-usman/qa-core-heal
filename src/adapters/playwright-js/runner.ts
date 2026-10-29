import path from 'node:path';
import type { ChildRun } from '../types.js';
import { escapeRegex } from '../../selectors.js';
import { runPlaywrightCli, toCliFileFilter, type PlaywrightRunResult } from './cli.js';
import { collectTests, parseJsonReport, stripAnsi, type TestOutcome } from './report.js';

/**
 * Playwright's own list and single-test run. The core does not call these.
 * It asks the adapter, and the adapter calls them.
 */

export interface ListedTest {
  file: string;
  line: number;
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

export type RunObserver = (run: ChildRun) => void;

const BUFFER = 64 * 1024 * 1024;

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
  for (const top of report.suites ?? []) walk(top, []);
  return { ok: true, tests: out };
}

/** Selection arguments for one file, optionally pinned to a line. */
export function selectionArgs(root: string, file: string, project: string | null | undefined, line: number | null, title: string | null, config?: string | null): string[] {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const args = [`${toCliFileFilter(rel)}${line ? `:${line}` : ''}`];
  if (config) args.push('--config', config);
  if (project) args.push('--project', project);
  if (title !== null) args.push('--grep', escapeRegex(title));
  return args;
}

export type OneRun =
  | { kind: 'ran'; run: PlaywrightRunResult; report: { config?: { rootDir?: string } }; test: TestOutcome; status: string }
  | { kind: 'timeout'; run: PlaywrightRunResult }
  | { kind: 'error'; message: string; run: PlaywrightRunResult };

interface RawResult { status?: string }
interface RawTest { status?: string; results?: RawResult[] }
interface RawRunSpec { tests?: RawTest[] }
interface RawRunSuite { specs?: RawRunSpec[]; suites?: RawRunSuite[] }

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
