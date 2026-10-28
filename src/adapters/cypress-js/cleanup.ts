import type { CleanupRules } from '../types.js';

/**
 * Folders Cypress clears when `trashAssetsBeforeRuns` is true.
 * Heal points runs at its own temp folders and sets that flag to false.
 * https://docs.cypress.io/app/references/configuration
 */
export const cypressCleanup: CleanupRules = {
  outputDirs: ['cypress/screenshots', 'cypress/videos', 'cypress/downloads'],
};
