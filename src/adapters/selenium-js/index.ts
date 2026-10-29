import fs from 'node:fs';
import path from 'node:path';
import type {
  ChildRun,
  DetectHit,
  DiscoveredConfig,
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
import { classifySeleniumFailure } from './classify.js';
import { healSelenium } from './heal-run.js';
import { seleniumCleanup } from './cleanup.js';
import { seleniumAssertionGrammar, seleniumRouteGrammar } from './grammar.js';
import { setSeleniumCaptureDir } from './heal-run.js';
import { parseSeleniumCalls } from './parse.js';
import { testsFromMocha } from './report.js';
import { runSeleniumInScratch } from './spawn.js';
import { countSeleniumQuery } from './unique.js';
import { seleniumVersion } from './version.js';

const MOCHA_FILES = ['.mocharc.js', '.mocharc.cjs', '.mocharc.json', '.mocharc.yml', '.mocharc.yaml'];

function hasMocha(root: string): boolean {
  if (MOCHA_FILES.some((name) => fs.existsSync(path.join(root, name)))) return true;
  const pkgFile = path.join(root, 'package.json');
  if (!fs.existsSync(pkgFile)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as {
      mocha?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    if (pkg.mocha) return true;
    return pkg.dependencies?.mocha != null || pkg.devDependencies?.mocha != null;
  } catch {
    return false;
  }
}

function hasSelenium(root: string): boolean {
  const pkgFile = path.join(root, 'package.json');
  if (!fs.existsSync(pkgFile)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return pkg.dependencies?.['selenium-webdriver'] != null || pkg.devDependencies?.['selenium-webdriver'] != null;
  } catch {
    return false;
  }
}

/** Jest, or Selenium without Mocha, stays planned. */
export function seleniumRunnerBlock(root: string): string | null {
  if (!hasSelenium(root) || hasMocha(root)) return null;
  const pkgFile = path.join(root, 'package.json');
  let jest = fs.existsSync(path.join(root, 'jest.config.js')) || fs.existsSync(path.join(root, 'jest.config.ts'));
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as {
        jest?: unknown;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      if (pkg.jest || pkg.dependencies?.jest != null || pkg.devDependencies?.jest != null) jest = true;
    } catch { /* ignore */ }
  }
  if (jest) return 'Jest is planned and is not supported yet. Nothing was run.';
  return 'selenium-js is planned and is not supported yet. Nothing was run.';
}

async function execute(root: string, specPath: string, titlePath: string[], title: string | null, timeoutMs?: RunRequest['timeoutMs'], observe?: (run: ChildRun) => void): Promise<SpecBatchResult> {
  const absolute = path.isAbsolute(specPath) ? specPath : path.join(root, specPath);
  const spawned = await runSeleniumInScratch({ projectRoot: root, specPath: absolute, titlePath, title, timeoutMs, observe });
  setSeleniumCaptureDir(spawned.captureDir);
  if (spawned.timedOut) return { kind: 'timeout', run: spawned.run, tests: [], rootDir: root, failureDetail: spawned.failureDetail };
  if (!spawned.report || spawned.failureDetail) {
    return { kind: 'no-report', run: spawned.run, tests: [], rootDir: root, failureDetail: spawned.failureDetail || 'Mocha did not write a report.' };
  }
  const tests = testsFromMocha(spawned.report, absolute, spawned.captureDir);
  return { kind: 'ran', run: spawned.run, tests, rootDir: root, failureDetail: '' };
}

export const seleniumJs: FrameworkAdapter = {
  id: 'selenium-js',
  enabled: true,

  detect(root: string): DetectHit | null {
    if (!hasSelenium(root) || !hasMocha(root)) return null;
    const marker = MOCHA_FILES.find((name) => fs.existsSync(path.join(root, name))) ?? 'package.json';
    return { id: 'selenium-js', reason: marker };
  },

  version: seleniumVersion,

  async discoverConfig(): Promise<DiscoveredConfig> {
    return { baseUrl: null, testDir: null, testIdAttribute: 'data-test' };
  },

  async listTests(root: string, query: ListQuery): Promise<ListTestsResult> {
    const spec = query.specPath ? (path.isAbsolute(query.specPath) ? query.specPath : path.join(root, query.specPath)) : '';
    if (!spec || !fs.existsSync(spec)) return { ok: true, tests: [] };
    const lines = fs.readFileSync(spec, 'utf8').split('\n');
    const tests: ListTestsResult['tests'] = [];
    for (let i = 0; i < lines.length; i++) {
      const found = /\b(?:it|test)\s*(?:\.\s*only\s*)?\(\s*(['"`])(.*?)\1/.exec(lines[i] ?? '');
      if (!found || /\.skip\s*\(/.test(lines[i] ?? '')) continue;
      const title = found[2] ?? '';
      if (query.title && title !== query.title) continue;
      if (query.line && query.line > 0 && query.line !== i + 1) continue;
      tests.push({ file: spec, line: i + 1, titlePath: [title], project: null });
    }
    return { ok: true, tests };
  },

  async runOne(root: string, test: RunRequest, _mode: RunMode): Promise<RunResult> {
    const title = test.grepTitle === undefined
      ? (test.selection.titlePath[test.selection.titlePath.length - 1] ?? null)
      : test.grepTitle;
    const spec = test.selection.specRel ? path.join(root, test.selection.specRel) : test.selection.specPath;
    const batch = await execute(root, spec, test.selection.titlePath, title, test.timeoutMs, test.observe);
    if (batch.kind === 'timeout') return { kind: 'timeout', run: batch.run };
    if (batch.kind !== 'ran') return { kind: 'error', message: batch.failureDetail, run: batch.run };
    const found = title
      ? batch.tests.filter((item) => item.title === title || item.titlePath.join(' ').endsWith(title))
      : batch.tests;
    if (found.length !== 1) {
      return { kind: 'error', message: `The Mocha run reported ${found.length} tests, but exactly one was expected.`, run: batch.run };
    }
    return { kind: 'ran', run: batch.run, report: {}, test: found[0]!, status: found[0]!.ok ? 'expected' : 'unexpected' };
  },

  async runBatch(root: string, request: SpecBatchRequest): Promise<SpecBatchResult> {
    if (request.selection) {
      const spec = request.selection.specRel ? path.join(root, request.selection.specRel) : request.selection.specPath;
      return execute(root, spec, [request.selection.title], request.selection.title, request.timeoutMs, request.observe);
    }
    const rel = request.specsRel[0] ?? request.oneFileRel ?? '';
    const title = request.op === 'isolate' ? (request.oneTitle ?? null) : null;
    return execute(root, path.join(root, rel), title ? [title] : [], title, request.timeoutMs, request.observe);
  },

  parseReport(output: string): NeutralTestResult[] {
    try { return testsFromMocha(JSON.parse(output) as never, '', ''); } catch { return []; }
  },

  classifyFailure(message: string) {
    return classifySeleniumFailure(message);
  },

  parseLocators(source: string, file: string): unknown[] {
    return parseSeleniumCalls(source, file);
  },

  emitLocator(identity, ladder): Emit | null {
    if (typeof ladder.arg !== 'string') return null;
    const quote = identity.root === 'this.page' ? '"' : "'";
    return { code: `By.css(${quote}${ladder.arg}${quote})` };
  },

  uniqueInTarget(probePage: unknown, query: ProbeQuery): Promise<number> {
    return countSeleniumQuery(probePage, query);
  },

  pageSource(input): string | null {
    if (!input.capturePath || !fs.existsSync(input.capturePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(input.capturePath, 'utf8')) as { url?: string };
      return typeof parsed.url === 'string' ? parsed.url : null;
    } catch {
      return null;
    }
  },

  async resolveProbeBase() {
    return { url: null, configStorageState: null };
  },

  probeLocator() { return null; },
  probeScope(probePage: unknown) { return probePage; },
  selectorSignature() { return null; },
  locatorSignature() { return ''; },
  blocksTypeScriptConfig() { return false; },
  typeStrippingMessage() { return ''; },

  noReportMessage(detail: string) {
    return `Could not run the Mocha tests. ${detail}`;
  },
  noTestsMessage(specs: string) {
    return `Mocha reported no tests for ${specs}. Check the spec path and the Mocha config.`;
  },
  unexpectedCountMessage(count: number) {
    return `--test expected exactly one test to run, but Mocha reported ${count}. Nothing was changed.`;
  },

  healSpec(opts: object) {
    return healSelenium(opts as Parameters<typeof healSelenium>[0]);
  },

  assertionGrammar: seleniumAssertionGrammar,
  routeCalls: seleniumRouteGrammar,
  cleanup: seleniumCleanup,
  navigationError: /ECONNREFUSED|ENOTFOUND|chrome not reachable|unknown error: net::/,
  capabilities: { frameworks: ['selenium-js'], features: {} },
};
