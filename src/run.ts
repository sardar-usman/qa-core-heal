/**
 * Report parsing lives in the Playwright adapter. This module re-exports it
 * so existing imports keep working, and it keeps the apply-prompt answer.
 */
export {
  stripAnsi,
  classifyFailure,
  extractSelectorInfo,
  extractSelector,
  traceFailureUrl,
  parseJsonReport,
  collectTests,
  type FailureClass,
  type TestOutcome,
} from './adapters/playwright-js/report.js';

/** y/Y/yes apply; n/no/empty decline; anything else re-prompts. */
export function parseConsent(answer: string): 'yes' | 'no' | 'retry' {
  const a = answer.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return 'yes';
  if (a === 'n' || a === 'no' || a === '') return 'no';
  return 'retry';
}
