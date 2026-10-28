import { playwrightJs } from './playwright-js/index.js';
import type { FrameworkAdapter, FrameworkId } from './types.js';

/**
 * Adapters this build can run. 0.5 registers playwright-js only.
 * The other ids are recognised by detection and refused until a later release.
 */
const registry = new Map<FrameworkId, FrameworkAdapter>([
  ['playwright-js', playwrightJs],
]);

export function registeredAdapters(): FrameworkAdapter[] {
  return [...registry.values()];
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
export { FRAMEWORK_IDS } from './types.js';
