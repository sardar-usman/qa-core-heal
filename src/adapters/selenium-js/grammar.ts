import type { RouteGrammar, WeakenGrammar } from '../types.js';

/**
 * Node `assert`, Chai `expect` and `should`, and Mocha skips.
 * `.only` must not be added by a proposal. The user's own `.only` stays.
 * https://mochajs.org/#exclusive-tests
 */
export const seleniumAssertionGrammar: WeakenGrammar = {
  assertionCallee: 'expect',
  forms: [],
  skipCall: /\b(?:it|test|describe|context)\s*\.\s*skip\s*\(|\bthis\s*\.\s*skip\s*\(/,
  assertCallee: 'assert',
  shouldChain: true,
};

/** Selenium tests open the page with driver.get(). */
export const seleniumRouteGrammar: RouteGrammar = {
  method: 'get',
};
