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

/**
 * One test the core asks an adapter to run.
 * The adapter turns this into its own CLI arguments or API call.
 */
export interface TestSelection {
  /** Absolute spec path in the project that was scanned. */
  specPath: string;
  /**
   * The same spec relative to the project root, with forward slashes.
   * A scratch copy runs with a different root, and this relative path
   * still names the copied file.
   */
  specRel: string;
  /** Describe titles, then the test title. */
  titlePath: string[];
  /** 1-based declaration line. 0 means the run is not pinned to a line. */
  line: number;
}

/**
 * One test from a runner report, in a form the core can use for every framework.
 * `title` is the test title the runner printed. `state` is passed or failed.
 */
export interface NeutralTestResult {
  titlePath: string[];
  file: string;
  line: number;
  state: 'passed' | 'failed';
  errorText: string;
  attempts: number;
  /** The test title, which is the last title path entry for Playwright. */
  title: string;
  ok: boolean;
  tracePath: string | null;
  locations: Array<{ file: string; line: number }>;
  /** The runner's own status word when the report has one. */
  status: string;
  /** Cypress writes the failing page here. Playwright leaves this unset. */
  capturePath?: string | null;
}

/**
 * A count question for the target framework's own matching rule.
 * The probe page is Playwright Chromium. The adapter decides what a match is.
 */
export type ProbeQuery =
  | { kind: 'css'; selector: string; frameChain?: string[] }
  | { kind: 'xpath'; expression: string; frameChain?: string[] }
  | { kind: 'testId'; value: string; frameChain?: string[] }
  | { kind: 'role'; role: string; name?: string; exact?: boolean; frameChain?: string[] }
  | { kind: 'text'; text: string; selector?: string; exact?: boolean; frameChain?: string[] }
  | { kind: 'label'; text: string; exact?: boolean; frameChain?: string[] }
  | { kind: 'placeholder'; text: string; exact?: boolean; frameChain?: string[] }
  | { kind: 'title'; text: string; exact?: boolean; frameChain?: string[] }
  | { kind: 'alt'; text: string; frameChain?: string[] };

/** How the probe finds the page the test was on when it failed. */
export interface PageSourceInput {
  tracePath?: string | null;
  capturePath?: string | null;
}

export interface ProbeBaseInput {
  files: Array<{ src: string }>;
  roots: string[];
  baseUrl?: string;
  project?: string;
  explicitConfig?: string;
}

export interface ProbeBase {
  url: string | null;
  configStorageState: string | null;
}

/** A parsed locator call the probe can rebuild. */
export interface ProbeCall {
  method: string;
  args: {
    role?: string;
    name?: string;
    exact?: boolean;
    label?: string;
    placeholder?: string;
    text?: string;
    alt?: string;
    title?: string;
    testid?: string;
    css?: string;
    xpath?: string;
    hasText?: string;
    roleOpts?: Record<string, boolean | number>;
  };
  frameChain: string[];
}

export type SpecBatchOp = 'first' | 'scan-verify' | 'rerun' | 'isolate';

/** The one-test filter spec mode and findings mode hand to the adapter. */
export interface SpecBatchSelection {
  specPath: string;
  /** Project-relative spec path. Used when the run root is a copy. */
  specRel?: string;
  /** The grep title. This is the test title, not a joined title path. */
  title: string;
  line: number;
  project?: string | null;
  config?: string | null;
}

export interface SpecBatchRequest {
  op: SpecBatchOp;
  /** Relative spec paths, not yet escaped for the runner. */
  specsRel: string[];
  selection?: SpecBatchSelection;
  /** Declaration line after a heal moved it. Used when `selection` is set. */
  shiftedLine?: number;
  grepTitles?: string[];
  grepFilesRel?: string[];
  oneTitle?: string;
  oneFileRel?: string;
  trace?: boolean;
  outputDir?: string;
  configRel?: string | null;
  timeoutMs?: number | (() => number | undefined);
  observe?: (run: ChildRun) => void;
  /**
   * A dry run must not create folders in the user project.
   * The adapter keeps its scratch copy in the system temp directory.
   */
  preview?: boolean;
}

export interface SpecBatchResult {
  kind: 'ran' | 'timeout' | 'no-report';
  run: ChildRun;
  tests: NeutralTestResult[];
  rootDir: string;
  failureDetail: string;
}

export interface ListQuery {
  specPath?: string;
  line?: number | null;
  title?: string | null;
  project?: string | null;
  config?: string | null;
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
  selection: TestSelection;
  /**
   * Title for the runner's grep. Null means no grep.
   * Omitted means the last title path entry.
   */
  grepTitle?: string | null;
  project?: string | null;
  config?: string | null;
  extraArgs?: string[];
  outputDir?: string;
  timeoutMs?: number | (() => number | undefined);
  observe?: (run: ChildRun) => void;
  /** First runs record a trace unless this is set. */
  noTrace?: boolean;
  /** A dry run must not create folders in the user project. */
  preview?: boolean;
}

export type RunResult =
  | { kind: 'ran'; run: ChildRun; report: { config?: { rootDir?: string } }; test: NeutralTestResult; status: string }
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
  /**
   * Cypress counts `.should()` and `.and()` as assertions.
   * Unset for Playwright, so the expect() rules stay as they are.
   */
  shouldChain?: boolean;
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
  /**
   * False while the adapter is registered but not turned on.
   * Detection still names it, and the answer stays "planned".
   */
  enabled: boolean;
  /** Config files and package manifests that mean this framework. Null when it is absent. */
  detect(root: string): DetectHit | null;
  /** Framework version for capabilities and the audit. Null when it is not installed. */
  version(root: string): string | null;
  discoverConfig(root: string, opts?: DiscoverOptions): Promise<DiscoveredConfig>;
  /** List tests so the core can require exactly one match by title path. */
  listTests(
    root: string,
    query: ListQuery,
    opts?: {
      timeoutMs?: number | (() => number | undefined);
      observe?: (run: ChildRun) => void;
      outputDir?: string;
    },
  ): Promise<ListTestsResult>;
  /** First run, shadow run, or the re-run after apply. */
  runOne(root: string, test: RunRequest, mode: RunMode): Promise<RunResult>;
  /**
   * A spec-mode run of one file, one test, or a grep of several titles.
   * The adapter builds the runner arguments and reads the report.
   */
  runBatch(root: string, request: SpecBatchRequest): Promise<SpecBatchResult>;
  /** Status, error text, file, line, and the failure URL when the report has one. */
  parseReport(output: string): NeutralTestResult[];
  classifyFailure(message: string, stack?: string): FailureClass;
  /** Positions of the exact literal the core may edit. */
  parseLocators(source: string, file: string): unknown[];
  emitLocator(
    identity: { root: string; frameChain?: string[] },
    ladder: { level: string; arg: unknown; ambiguous?: boolean },
  ): Emit | null;
  /**
   * How many elements `query` matches under this framework's own rule.
   * The core heals only when the count is exactly 1.
   *
   * Playwright JS uses strict locator semantics (`locator.count()`).
   * Cypress and Selenium must use their own rules. A Playwright count is
   * not proof for them.
   */
  uniqueInTarget(probePage: unknown, query: ProbeQuery): Promise<number>;
  /** The page URL at failure time. Playwright reads it from the trace. */
  pageSource(input: PageSourceInput): string | null;
  /** Base URL and storage state for the probe. */
  resolveProbeBase(input: ProbeBaseInput): Promise<ProbeBase>;
  /** Rebuild a parsed call as a probe locator. The core reads the element from it. */
  probeLocator(probePage: unknown, call: ProbeCall): unknown;
  /** The frame scope a count or a tag fix uses. */
  probeScope(probePage: unknown, frameChain: string[]): unknown;
  /** Structural identity of a locator call printed in an error. */
  selectorSignature(text: string): string | null;
  /** Structural identity of a parsed locator call. */
  locatorSignature(call: ProbeCall): string;
  /** True when this project has a TypeScript config this Node cannot load. */
  blocksTypeScriptConfig(root: string): boolean;
  typeStrippingMessage(): string;
  /** Spec-mode wording. Playwright keeps the sentences it already prints. */
  noReportMessage?(detail: string): string;
  noTestsMessage?(specs: string): string;
  unexpectedCountMessage?(count: number): string;
  assertionGrammar: WeakenGrammar;
  routeCalls: RouteGrammar;
  cleanup: CleanupRules;
  /** A navigation or network failure in this framework's error text. */
  navigationError: RegExp;
  capabilities: AdapterCapabilities;
  /**
   * When set, this adapter heals the spec. The core calls it instead of the
   * Playwright healer. Playwright leaves it unset.
   */
  healSpec?(opts: object): Promise<object>;
}
