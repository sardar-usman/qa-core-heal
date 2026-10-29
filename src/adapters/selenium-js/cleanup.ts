import type { CleanupRules } from '../types.js';

/** Mocha does not create a report folder of its own. The JSON report is a heal temp file. */
export const seleniumCleanup: CleanupRules = {
  outputDirs: [],
};
