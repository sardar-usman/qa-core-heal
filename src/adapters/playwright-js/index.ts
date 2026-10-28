import path from 'node:path';
import { playwrightVersion } from '../../contract.js';
import { parseLocatorCalls } from '../../heal.js';
import { findPlaywrightConfig, resolvePlaywrightConfig } from '../../playwright-config.js';
import { classifyFailure, collectTests, parseJsonReport } from '../../run.js';
import { emitLocatorCall, type CascadeLevel } from '../../selectors.js';
import { listTests as listTestsImpl, runSelected } from '../../targeted.js';
import type {
  ChildRun,
  DetectHit,
  DiscoveredConfig,
  DiscoverOptions,
  Emit,
  FrameworkAdapter,
  ListTestsResult,
  ParsedOutcome,
  RunMode,
  RunRequest,
  RunResult,
} from '../types.js';
import { playwrightCleanup } from './cleanup.js';
import { playwrightAssertionGrammar, playwrightRouteGrammar } from './grammar.js';

/**
 * Playwright JS/TS. The only adapter in 0.5. The methods call the same
 * functions the core called before this folder existed.
 */
export const playwrightJs: FrameworkAdapter = {
  id: 'playwright-js',

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

  async listTests(root: string, selectArgs: string[], opts?: {
    timeoutMs?: number | (() => number | undefined);
    observe?: (run: ChildRun) => void;
    outputDir?: string;
  }): Promise<ListTestsResult> {
    return listTestsImpl(root, selectArgs, opts?.timeoutMs, opts?.observe, opts?.outputDir);
  },

  async runOne(root: string, test: RunRequest, mode: RunMode): Promise<RunResult> {
    const extra = [...(test.extraArgs ?? [])];
    if (mode === 'first' && !test.noTrace) extra.push('--trace', 'retain-on-failure');
    return runSelected(root, test.selectArgs, extra, test.timeoutMs, test.observe) as Promise<RunResult>;
  },

  parseReport(output: string): ParsedOutcome[] {
    const report = parseJsonReport(output);
    if (!report) return [];
    return collectTests(report as Parameters<typeof collectTests>[0]) as ParsedOutcome[];
  },

  classifyFailure(message: string, stack?: string) {
    const raw = stack && !message.includes(stack) ? `${message}\n${stack}` : message;
    return classifyFailure(raw);
  },

  parseLocators(source: string, file: string): unknown[] {
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

  /**
   * Playwright strict locator semantics: exactly one match.
   * Other adapters must implement their own framework's matching rule
   * (Cypress cy.contains and cy.get, Selenium first-match and non-piercing
   * CSS and XPath). A Playwright count is not proof for them.
   */
  async uniqueInTarget(_probePage: unknown, target: { count(): Promise<number> }): Promise<boolean> {
    try { return (await target.count()) === 1; } catch { return false; }
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
