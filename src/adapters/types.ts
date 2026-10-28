/**
 * The framework adapter. Version 0.5 ships the Playwright JS/TS adapter only.
 * Cypress, Selenium JS/TS, Playwright Python and Selenium Python will plug
 * into this interface later. They are not implemented in this release.
 *
 * The core decision rules are not overridable: exactly one candidate or
 * refuse, same-element confirmation, the kind guard, the weaken guard,
 * scratch shadow runs before any patch, consent before apply, and revert
 * when the re-run fails.
 */

export type FrameworkId =
  | 'playwright-js'
  | 'cypress-js'
  | 'selenium-js'
  | 'playwright-py'
  | 'selenium-py';

export const FRAMEWORK_IDS: readonly FrameworkId[] = [
  'playwright-js',
  'cypress-js',
  'selenium-js',
  'playwright-py',
  'selenium-py',
];

/** One framework that detection found, and why. */
export interface DetectHit {
  id: FrameworkId;
  reason: string;
}

export interface DiscoverOptions {
  project?: string;
  /** Load this config file instead of the one in the project root. */
  explicitConfig?: string;
}

export interface DiscoveredConfig {
  baseUrl: string | null;
  testDir: string | null;
  /** Null means the framework default. Playwright's default is data-testid. */
  testIdAttribute: string | null;
}

export interface TestRef {
  file: string;
  line: number;
  titlePath: string[];
  project: string | null;
}

export interface ListTestsResult {
  ok: boolean;
  tests: TestRef[];
  error?: string;
  timedOut?: boolean;
}

/** A child process result. The fields match the Playwright runner's result. */
export interface ChildRun {
  status: number | null;
  stdout: string;
  stderr: string;
  command: string;
  error?: Error;
  timedOut?: boolean;
}

export interface ParsedOutcome {
  file: string;
  title: string;
  line: number;
  ok: boolean;
  message: string;
  tracePath: string | null;
  locations: Array<{ file: string; line: number }>;
}

export type RunMode = 'first' | 'shadow' | 'rerun';

export interface RunRequest {
  selectArgs: string[];
  extraArgs?: string[];
  timeoutMs?: number | (() => number | undefined);
  observe?: (run: ChildRun) => void;
  /** First runs record a trace unless this is set. */
  noTrace?: boolean;
}

export type RunResult =
  | { kind: 'ran'; run: ChildRun; report: { config?: { rootDir?: string } }; test: ParsedOutcome; status: string }
  | { kind: 'timeout'; run: ChildRun }
  | { kind: 'error'; message: string; run: ChildRun };

export type FailureClass =
  | { kind: 'locator'; selector: string | null; strict?: boolean; chained?: boolean }
  | { kind: 'other'; summary: string };

/** Code this framework would write for one locator. */
export interface Emit {
  code: string;
}

/**
 * Data the shared weaken engine reads. The engine stays in the core.
 * Playwright's grammar is expect, expect.soft, expect.poll, and test.skip.
 */
export interface WeakenGrammar {
  assertionCallee: string;
  forms: readonly string[];
  /** Not global. Matches test.skip and test.fixme, including test.describe.skip. */
  skipCall: RegExp;
  assertCallee: string;
}

/**
 * Data the shared route engine reads. The engine stays in the core.
 * Playwright navigates with page.goto().
 */
export interface RouteGrammar {
  method: string;
}

export interface CleanupRules {
  /** Output folders this framework creates, added to the shared scratch skip set. */
  outputDirs: readonly string[];
}

export interface AdapterCapabilities {
  frameworks: FrameworkId[];
  features: { playwrightConfig?: boolean };
}

export interface FrameworkAdapter {
  id: FrameworkId;
  /** Config files and package manifests that mean this framework. Null when it is absent. */
  detect(root: string): DetectHit | null;
  /** Framework version for capabilities and the audit. Null when it is not installed. */
  version(root: string): string | null;
  discoverConfig(root: string, opts?: DiscoverOptions): Promise<DiscoveredConfig>;
  /** List tests so the core can require exactly one match by title path. */
  listTests(
    root: string,
    selectArgs: string[],
    opts?: {
      timeoutMs?: number | (() => number | undefined);
      observe?: (run: ChildRun) => void;
      outputDir?: string;
    },
  ): Promise<ListTestsResult>;
  /** First run, shadow run, or the re-run after apply. */
  runOne(root: string, test: RunRequest, mode: RunMode): Promise<RunResult>;
  /** Status, error text, file, line, and the failure URL when the report has one. */
  parseReport(output: string): ParsedOutcome[];
  classifyFailure(message: string, stack?: string): FailureClass;
  /** Positions of the exact literal the core may edit. */
  parseLocators(source: string, file: string): unknown[];
  emitLocator(
    identity: { root: string; frameChain?: string[] },
    ladder: { level: string; arg: unknown; ambiguous?: boolean },
  ): Emit | null;
  /**
   * True when `target` is unique under this framework's own matching rule.
   *
   * Playwright JS uses strict locator semantics: exactly one match
   * (`count() === 1`). Other adapters must implement their own framework's
   * rule (Cypress `cy.contains` and `cy.get`, Selenium first-match and
   * non-piercing CSS and XPath). A Playwright count is not proof for them.
   */
  uniqueInTarget(probePage: unknown, target: { count(): Promise<number> }): Promise<boolean>;
  assertionGrammar: WeakenGrammar;
  routeCalls: RouteGrammar;
  cleanup: CleanupRules;
  /** A navigation or network failure in this framework's error text. */
  navigationError: RegExp;
  capabilities: AdapterCapabilities;
}
