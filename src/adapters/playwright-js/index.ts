import path from 'node:path';
import type { Page } from 'playwright';
import { describeFailedRun, runPlaywrightCli, toCliFileFilter } from './cli.js';
import { playwrightVersion } from '../../playwright-version.js';
import { escapeRegex } from '../../selectors.js';
import {
  outputArgs,
  runSelected,
  selectionArgs,
  listTests as listTestsImpl,
} from './runner.js';
import { collectTests, parseJsonReport, traceFailureUrl, type TestOutcome } from './report.js';
import { findPlaywrightConfig, resolvePlaywrightConfig, supportsTypeStripping, typeStrippingGateMessage } from './config.js';
import { emitLocatorCall } from './emit.js';
import type { CascadeLevel } from '../../selectors.js';
import { locatorSignature as signatureOfCall, parseLocatorCalls, selectorSignature as signatureOf } from './parse-locators.js';
import { classifyFailure, type FailureClass } from './report.js';
import { countQuery } from './unique.js';
import { resolveBaseUrl } from './base-url.js';
import { buildLocator, scopeFor } from './build-locator.js';
import type { LocatorCall } from './parse-locators.js';
import type {
  ChildRun,
  DetectHit,
  DiscoveredConfig,
  DiscoverOptions,
  Emit,
  FrameworkAdapter,
  ListQuery,
  ListTestsResult,
  NeutralTestResult,
  ProbeQuery,
  RunMode,
  RunRequest,
  RunResult,
  SpecBatchRequest,
  SpecBatchResult,
} from '../types.js';
import { playwrightCleanup } from './cleanup.js';
import { playwrightAssertionGrammar, playwrightRouteGrammar } from './grammar.js';

/**
 * Playwright JS/TS. The only enabled adapter in 0.5.
 * Parsing, reports, config loading, and the test runner live in this folder.
 */

/** A spec path inside `root`. A scratch copy keeps the project-relative path. */
export function fileInRoot(root: string, specPath: string, specRel?: string): string {
  if (path.isAbsolute(specPath)) {
    const rel = path.relative(root, specPath);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return specPath;
  }
  if (specRel) return path.join(root, specRel);
  return specPath;
}

function toNeutral(test: TestOutcome, attempts: number): NeutralTestResult {
  return {
    titlePath: [test.title],
    file: test.file,
    line: test.line,
    state: test.ok ? 'passed' : 'failed',
    errorText: test.message,
    attempts,
    title: test.title,
    ok: test.ok,
    tracePath: test.tracePath,
    locations: test.locations,
    status: 'unknown',
  };
}

function attemptCounts(report: { suites?: ReportSuite[] }): number[] {
  const out: number[] = [];
  const walk = (suite: ReportSuite): void => {
    for (const spec of suite.specs ?? []) {
      const results = spec.tests?.[0]?.results;
      out.push(Array.isArray(results) && results.length > 0 ? results.length : 1);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}

interface ReportSuite {
  specs?: Array<{ tests?: Array<{ results?: unknown[] }> }>;
  suites?: ReportSuite[];
}

function neutralFromReport(report: { config?: { rootDir?: string }; suites?: ReportSuite[] }, fallbackRoot: string): {
  tests: NeutralTestResult[];
  rootDir: string;
} {
  const outcomes = collectTests(report as Parameters<typeof collectTests>[0]);
  const attempts = attemptCounts(report);
  return {
    rootDir: report.config?.rootDir ?? fallbackRoot,
    tests: outcomes.map((test, i) => toNeutral(test, attempts[i] ?? 1)),
  };
}

function batchArgs(root: string, req: SpecBatchRequest): { args: string[]; buffer: number; timeoutMs?: SpecBatchRequest['timeoutMs'] } {
  const configRel = req.configRel ?? null;
  const extra = [
    ...(req.outputDir ? outputArgs(req.outputDir) : []),
    ...(configRel ? ['--config', configRel] : []),
  ];
  if (req.op === 'first') {
    const head = req.selection
      ? selectionArgs(
        root,
        fileInRoot(root, req.selection.specPath, req.selection.specRel),
        req.selection.project,
        req.selection.line > 0 ? req.selection.line : null,
        req.selection.title,
        req.selection.config,
      )
      : req.specsRel.map((rel) => toCliFileFilter(rel));
    const traceArgs = req.trace ? ['--trace', 'retain-on-failure'] : [];
    return {
      args: ['test', ...head, '--reporter=json', ...traceArgs, ...extra],
      buffer: 64 * 1024 * 1024,
      timeoutMs: req.timeoutMs,
    };
  }
  if (req.op === 'scan-verify') {
    return {
      args: ['test', toCliFileFilter(req.specsRel[0] ?? ''), '--reporter=json', ...extra],
      buffer: 32 * 1024 * 1024,
    };
  }
  if (req.op === 'rerun') {
    const line = req.shiftedLine ?? req.selection?.line ?? 0;
    const head = req.selection
      ? selectionArgs(
        root,
        fileInRoot(root, req.selection.specPath, req.selection.specRel),
        req.selection.project,
        line > 0 ? line : null,
        req.selection.title,
        req.selection.config,
      )
      : [...(req.grepFilesRel ?? []).map((rel) => toCliFileFilter(rel)), '--grep', (req.grepTitles ?? []).map((title) => escapeRegex(title)).join('|')];
    return { args: ['test', ...head, ...extra], buffer: 32 * 1024 * 1024, timeoutMs: req.timeoutMs };
  }
  const line = req.shiftedLine ?? req.selection?.line ?? 0;
  const head = req.selection
    ? selectionArgs(
      root,
      fileInRoot(root, req.selection.specPath, req.selection.specRel),
      req.selection.project,
      line > 0 ? line : null,
      req.selection.title,
      req.selection.config,
    )
    : [toCliFileFilter(req.oneFileRel ?? ''), '--grep', escapeRegex(req.oneTitle ?? '')];
  return {
    args: ['test', ...head, '--reporter=json', ...extra],
    buffer: 32 * 1024 * 1024,
    timeoutMs: req.timeoutMs,
  };
}

export const playwrightJs: FrameworkAdapter = {
  id: 'playwright-js',
  enabled: true,

  detect(root: string): DetectHit | null {
    const config = findPlaywrightConfig(root);
    if (!config) return null;
    return { id: 'playwright-js', reason: path.basename(config) };
  },

  version(root: string): string | null {
    return playwrightVersion(root);
  },

  async discoverConfig(root: string, opts?: DiscoverOptions): Promise<DiscoveredConfig> {
    const res = await resolvePlaywrightConfig(root, opts?.project, opts?.explicitConfig);
    return {
      baseUrl: res?.baseUrl ?? null,
      testDir: res?.testDir && res.testDir.length > 0 ? res.testDir : null,
      testIdAttribute: null,
    };
  },

  async listTests(root: string, query: ListQuery, opts?: {
    timeoutMs?: number | (() => number | undefined);
    observe?: (run: ChildRun) => void;
    outputDir?: string;
  }): Promise<ListTestsResult> {
    const selectArgs = query.specPath
      ? selectionArgs(root, query.specPath, query.project, query.line ?? null, query.title ?? null, query.config)
      : [];
    return listTestsImpl(root, selectArgs, opts?.timeoutMs, opts?.observe, opts?.outputDir);
  },

  async runOne(root: string, test: RunRequest, mode: RunMode): Promise<RunResult> {
    const grep = test.grepTitle === undefined
      ? (test.selection.titlePath[test.selection.titlePath.length - 1] ?? null)
      : test.grepTitle;
    const selectArgs = selectionArgs(
      root,
      fileInRoot(root, test.selection.specPath, test.selection.specRel),
      test.project,
      test.selection.line > 0 ? test.selection.line : null,
      grep,
      test.config,
    );
    const extra = [...(test.extraArgs ?? [])];
    if (test.outputDir) extra.push(...outputArgs(test.outputDir));
    if (mode === 'first' && !test.noTrace) extra.push('--trace', 'retain-on-failure');
    const ran = await runSelected(root, selectArgs, extra, test.timeoutMs, test.observe);
    if (ran.kind !== 'ran') return ran;
    const attempts = ran.report ? attemptCounts(ran.report as { suites?: ReportSuite[] }) : [];
    return { ...ran, test: { ...toNeutral(ran.test, attempts[0] ?? 1), status: ran.status } };
  },

  async runBatch(root: string, request: SpecBatchRequest): Promise<SpecBatchResult> {
    const built = batchArgs(root, request);
    const run = await runPlaywrightCli(root, built.args, built.buffer, undefined, built.timeoutMs);
    request.observe?.(run);
    const failureDetail = describeFailedRun(run);
    if (run.timedOut) return { kind: 'timeout', run, tests: [], rootDir: root, failureDetail };
    if (request.op === 'rerun') return { kind: 'ran', run, tests: [], rootDir: root, failureDetail };
    const report = parseJsonReport(run.stdout ?? '') as { config?: { rootDir?: string }; suites?: ReportSuite[] } | null;
    if (!report) return { kind: 'no-report', run, tests: [], rootDir: root, failureDetail };
    const parsed = neutralFromReport(report, root);
    return { kind: 'ran', run, tests: parsed.tests, rootDir: parsed.rootDir, failureDetail };
  },

  parseReport(output: string): NeutralTestResult[] {
    const report = parseJsonReport(output);
    if (!report) return [];
    return neutralFromReport(report as { suites?: ReportSuite[] }, '').tests;
  },

  classifyFailure(message: string, stack?: string): FailureClass {
    const raw = stack && !message.includes(stack) ? `${message}\n${stack}` : message;
    return classifyFailure(raw);
  },

  parseLocators(source: string, file: string): LocatorCall[] {
    return parseLocatorCalls(source, file);
  },

  emitLocator(identity, ladder): Emit | null {
    const code = emitLocatorCall(
      ladder.level as CascadeLevel,
      ladder.arg as Parameters<typeof emitLocatorCall>[1],
      ladder.ambiguous === true,
      identity.frameChain,
    );
    if (!code) return null;
    return { code: identity.root === 'this.page' ? `this.${code}` : code };
  },

  uniqueInTarget(probePage: unknown, query: ProbeQuery): Promise<number> {
    return countQuery(probePage, query);
  },

  pageSource(input): string | null {
    if (input.tracePath) return traceFailureUrl(input.tracePath);
    return null;
  },

  resolveProbeBase(input) {
    return resolveBaseUrl(input.files, input.roots, input.baseUrl, input.project, input.explicitConfig);
  },

  probeLocator(probePage: unknown, call) {
    return buildLocator(probePage as Page, call as LocatorCall);
  },

  probeScope(probePage: unknown, frameChain: string[]) {
    return scopeFor(probePage as Page, frameChain);
  },

  selectorSignature(text: string): string | null {
    return signatureOf(text);
  },

  locatorSignature(call) {
    return signatureOfCall(call.method, call.args);
  },

  blocksTypeScriptConfig(root: string): boolean {
    if (supportsTypeStripping()) return false;
    return findPlaywrightConfig(root)?.endsWith('.ts') === true;
  },

  typeStrippingMessage(): string {
    return typeStrippingGateMessage();
  },

  assertionGrammar: playwrightAssertionGrammar,
  routeCalls: playwrightRouteGrammar,
  cleanup: playwrightCleanup,
  navigationError: /page\.goto:|net::|Navigation failed|NS_ERROR|Protocol error/,
  capabilities: {
    frameworks: ['playwright-js'],
    features: { playwrightConfig: true },
  },
};
