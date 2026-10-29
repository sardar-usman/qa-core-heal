/**
 * Re-export. The Playwright runner lives in the Playwright adapter.
 * Core code reaches it through the adapter registry, not through this file.
 */
export {
  toCliFileFilter,
  startRunBudget,
  runPlaywrightCli,
  describeFailedRun,
  setPlaywrightSpawnObserver,
  type PlaywrightRunResult,
  type PlaywrightSpawnNotice,
} from './adapters/playwright-js/cli.js';
