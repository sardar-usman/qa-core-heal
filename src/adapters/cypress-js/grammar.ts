import type { RouteGrammar, WeakenGrammar } from '../types.js';

/**
 * Cypress assertions are `.should()` and `.and()`, plus Chai `expect`.
 * `.only` is counted so a proposal cannot add one. The user's own `.only`
 * is left where it is.
 */
export const cypressAssertionGrammar: WeakenGrammar = {
  assertionCallee: 'expect',
  forms: [],
  skipCall: /\b(?:it|test|describe|context)\s*\.\s*skip\s*\(|\bthis\s*\.\s*skip\s*\(/,
  assertCallee: 'assert',
  shouldChain: true,
};

/** Cypress navigates with cy.visit(). The route engine stays in the core. */
export const cypressRouteGrammar: RouteGrammar = {
  method: 'visit',
};
