import type { RouteGrammar, WeakenGrammar } from '../types.js';

/**
 * Playwright's assertion grammar, unchanged from the patterns the weaken
 * engine used before the adapter existed.
 */
export const playwrightAssertionGrammar: WeakenGrammar = {
  assertionCallee: 'expect',
  forms: ['soft', 'poll'],
  skipCall: /^test(?:\s*\.\s*describe)?\s*\.\s*(?:skip|fixme)\b/,
  assertCallee: 'assert',
};

/** Playwright navigates with page.goto(). */
export const playwrightRouteGrammar: RouteGrammar = {
  method: 'goto',
};
