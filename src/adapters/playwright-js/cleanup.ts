import type { CleanupRules } from '../types.js';

/**
 * Folders a Playwright run creates. Together with the shared base set
 * (node_modules, .git, .qa-core) this is the skip list scratch copies used
 * before the adapter existed.
 */
export const playwrightCleanup: CleanupRules = {
  outputDirs: ['test-results', 'playwright-report', 'blob-report'],
};
