import { cypressJs } from './cypress-js/index.js';
import { playwrightJs } from './playwright-js/index.js';
import type { FrameworkAdapter, FrameworkId } from './types.js';

/**
 * Adapters this build can run. 0.5 registers playwright-js only.
 * The other ids are recognised by detection and refused until a later release.
 */
const registry = new Map<FrameworkId, FrameworkAdapter>([
  ['playwright-js', playwrightJs],
  ['cypress-js', cypressJs],
]);

/** Capabilities and detection list frameworks in this order. Python ids stay planned. */
const REGISTERED_ORDER: readonly FrameworkId[] = [
  'playwright-js',
  'cypress-js',
  'selenium-js',
  'playwright-py',
  'selenium-py',
];

/** Capabilities list only these ids, and only when the adapter is enabled. */
const CAPABILITY_ORDER: readonly FrameworkId[] = ['playwright-js', 'cypress-js', 'selenium-js'];

export function registeredAdapters(): FrameworkAdapter[] {
  const out: FrameworkAdapter[] = [];
  for (const id of REGISTERED_ORDER) {
    const adapter = registry.get(id);
    if (adapter) out.push(adapter);
  }
  return out;
}

/** Enabled adapters, in the fixed capabilities order. */
export function enabledAdapters(): FrameworkAdapter[] {
  const out: FrameworkAdapter[] = [];
  for (const id of CAPABILITY_ORDER) {
    const adapter = registry.get(id);
    if (adapter?.enabled) out.push(adapter);
  }
  return out;
}

export function getAdapter(id: FrameworkId): FrameworkAdapter | null {
  return registry.get(id) ?? null;
}

let current: FrameworkAdapter = playwrightJs;

/** The adapter for this command. Playwright JS until detection selects it. */
export function activeAdapter(): FrameworkAdapter {
  return current;
}

export function useAdapter(id: FrameworkId): FrameworkAdapter {
  const found = registry.get(id);
  if (!found) throw new Error(`No adapter is registered for ${id}.`);
  current = found;
  return found;
}

export type { FrameworkAdapter, FrameworkId } from './types.js';
export type { LocatorArgs, LocatorCall, LocatorMethod } from './playwright-js/parse-locators.js';
export { FRAMEWORK_IDS } from './types.js';
