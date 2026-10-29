import fs from 'node:fs';
import path from 'node:path';
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
import { classifyCypressFailure } from './classify.js';
import { cypressCleanup } from './cleanup.js';
import { cypressAssertionGrammar, cypressRouteGrammar } from './grammar.js';
import { setCaptureDir } from './heal-run.js';
import { parseCypressCalls } from './parse.js';
import { readCypressResult, startFailure, testsFromCypress } from './report.js';
import { runCypressInScratch } from './spawn.js';
import { countCypressQuery } from './unique.js';
import { CYPRESS_MIN, cypressVersion, versionAtLeast } from './version.js';
import { healCypress } from './heal-run.js';
import { listSpecTests } from './list-tests.js';
import { testIdAttributeFrom } from './capture.js';

const CONFIGS = ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs', 'cypress.config.cjs'];

function tooOld(version: string): string {
  return `Cypress ${version} is older than ${CYPRESS_MIN}, which this heal needs. Nothing was run.`;
}

function missing(): string {
  return 'Cypress is not installed in this project. Install cypress and run npx cypress install. Nothing was run.';
}

async function execute(root: string, specPath: string, title: string | null, line: number, timeoutMs?: RunRequest['timeoutMs'], observe?: (run: ChildRun) => void, preview?: boolean): Promise<SpecBatchResult> {
  const version = cypressVersion(root);
  if (!version) {
    const run: ChildRun = { status: 1, stdout: '', stderr: missing(), command: 'cypress.run' };
    return { kind: 'no-report', run, tests: [], rootDir: root, failureDetail: missing() };
  }
  if (!versionAtLeast(version, CYPRESS_MIN)) {
    const text = tooOld(version);
    const run: ChildRun = { status: 1, stdout: '', stderr: text, command: 'cypress.run' };
    return { kind: 'no-report', run, tests: [], rootDir: root, failureDetail: text };
  }
  const absolute = path.isAbsolute(specPath) ? specPath : path.join(root, specPath);
  const spawned = await runCypressInScratch({
    projectRoot: root,
    specPath: absolute,
    title,
    line,
    timeoutMs,
    observe,
    preview,
  });
  setCaptureDir(spawned.captureDir);
  if (spawned.timedOut) {
    return { kind: 'timeout', run: spawned.run, tests: [], rootDir: root, failureDetail: 'The Cypress run timed out.' };
  }
  const parsed = readCypressResult(spawned.result);
  if (!parsed) {
    return { kind: 'no-report', run: spawned.run, tests: [], rootDir: root, failureDetail: spawned.run.stderr || 'Cypress did not write a result.' };
  }
  const started = startFailure(parsed);
  if (started) {
    return { kind: 'no-report', run: spawned.run, tests: [], rootDir: root, failureDetail: started.text };
  }
  const tests = testsFromCypress(parsed, absolute, spawned.captureDir);
  return { kind: 'ran', run: spawned.run, tests, rootDir: root, failureDetail: '' };
}

export const cypressJs: FrameworkAdapter = {
  id: 'cypress-js',
  enabled: true,

  detect(root: string): DetectHit | null {
    for (const name of CONFIGS) {
      if (fs.existsSync(path.join(root, name))) return { id: 'cypress-js', reason: name };
    }
    return null;
  },

  version: cypressVersion,

  async discoverConfig(root: string, _opts?: DiscoverOptions): Promise<DiscoveredConfig> {
    let config: string | null = null;
    for (const name of CONFIGS) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) { config = fs.readFileSync(file, 'utf8'); break; }
    }
    return {
      baseUrl: null,
      testDir: fs.existsSync(path.join(root, 'cypress/e2e')) ? 'cypress/e2e' : null,
      testIdAttribute: testIdAttributeFrom(config),
    };
  },

  async listTests(root: string, query: ListQuery): Promise<ListTestsResult> {
    const spec = query.specPath ? (path.isAbsolute(query.specPath) ? query.specPath : path.join(root, query.specPath)) : '';
    if (!spec || !fs.existsSync(spec)) return { ok: true, tests: [] };
    let tests = listSpecTests(fs.readFileSync(spec, 'utf8')).filter((item) => !item.skip);
    if (query.title) {
      tests = tests.filter((item) => item.title === query.title || item.titlePath.join(' › ') === query.title || item.titlePath.join(' > ') === query.title);
    }
    if (query.line && query.line > 0) tests = tests.filter((item) => item.line === query.line);
    return {
      ok: true,
      tests: tests.map((item) => ({ file: spec, line: item.line, titlePath: item.titlePath, project: null })),
    };
  },

  async runOne(root: string, test: RunRequest, _mode: RunMode): Promise<RunResult> {
    const title = test.grepTitle === undefined ? (test.selection.titlePath[test.selection.titlePath.length - 1] ?? null) : test.grepTitle;
    const spec = test.selection.specRel ? path.join(root, test.selection.specRel) : test.selection.specPath;
    const batch = await execute(root, spec, title, test.selection.line, test.timeoutMs, test.observe, test.preview);
    if (batch.kind === 'timeout') return { kind: 'timeout', run: batch.run };
    if (batch.kind !== 'ran') return { kind: 'error', message: batch.failureDetail, run: batch.run };
    const found = title ? batch.tests.filter((item) => item.title === title || item.titlePath.join(' ').endsWith(title)) : batch.tests;
    if (found.length !== 1) {
      return { kind: 'error', message: `The Cypress run reported ${found.length} tests, but exactly one was expected.`, run: batch.run };
    }
    return { kind: 'ran', run: batch.run, report: {}, test: found[0]!, status: found[0]!.ok ? 'expected' : 'unexpected' };
  },

  async runBatch(root: string, request: SpecBatchRequest): Promise<SpecBatchResult> {
    if (request.selection) {
      const spec = request.selection.specRel
        ? path.join(root, request.selection.specRel)
        : request.selection.specPath;
      const line = request.shiftedLine ?? request.selection.line;
      return execute(root, spec, request.selection.title, line, request.timeoutMs, request.observe, request.preview);
    }
    const rel = request.specsRel[0] ?? request.oneFileRel ?? '';
    const title = request.op === 'isolate' ? (request.oneTitle ?? null) : null;
    return execute(root, path.join(root, rel), title, 0, request.timeoutMs, request.observe, request.preview);
  },

  healSpec(opts: object) {
    return healCypress(opts as Parameters<typeof healCypress>[0]);
  },

  parseReport(output: string): NeutralTestResult[] {
    try {
      return testsFromCypress(JSON.parse(output) as never, '', '');
    } catch {
      return [];
    }
  },

  classifyFailure(message: string) {
    return classifyCypressFailure(message);
  },

  parseLocators(source: string, file: string): unknown[] {
    return parseCypressCalls(source, file);
  },

  emitLocator(identity, ladder): Emit | null {
    if (typeof ladder.arg !== 'string') return null;
    const quote = identity.root === 'this.page' ? '"' : "'";
    return { code: `cy.get(${quote}${ladder.arg}${quote})` };
  },

  uniqueInTarget(probePage: unknown, query: ProbeQuery): Promise<number> {
    return countCypressQuery(probePage, query);
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
    return `Could not run the Cypress tests. ${detail}`;
  },
  noTestsMessage(specs: string) {
    return `Cypress reported no tests for ${specs}. Check the spec path and the Cypress config.`;
  },
  unexpectedCountMessage(count: number) {
    return `--test expected exactly one test to run, but Cypress reported ${count}. Nothing was changed.`;
  },

  assertionGrammar: cypressAssertionGrammar,
  routeCalls: cypressRouteGrammar,
  cleanup: cypressCleanup,
  navigationError: /ECONNREFUSED|ENOTFOUND|Timed out waiting|failed to connect/,
  capabilities: { frameworks: ['cypress-js'], features: {} },
};
