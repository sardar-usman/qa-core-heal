import type { FrameLocator, Locator, Page } from 'playwright';
import type { Scope } from '../../selectors.js';
import type { LocatorCall } from './parse-locators.js';

export function scopeFor(page: Page, frameChain: string[]): Scope {
  let scope: Scope = page;
  for (const f of frameChain) scope = (scope as Page | FrameLocator).frameLocator(f);
  return scope;
}

/** Rebuild the actual Playwright locator so we can ask the live page if it still resolves. */
export function buildLocator(page: Page, call: LocatorCall) {
  const scope = scopeFor(page, call.frameChain);
  const a = call.args;
  const role = (a.role ?? '') as Parameters<Page['getByRole']>[0];
  switch (call.method) {
    case 'getByRole': {
      const opts: Record<string, unknown> = { ...(a.roleOpts ?? {}) };
      if (a.name) {
        opts.name = a.name;
        if (a.exact) opts.exact = a.exact;
      }
      return Object.keys(opts).length > 0
        ? scope.getByRole(role, opts as Parameters<Page['getByRole']>[1])
        : scope.getByRole(role);
    }
    case 'getByLabel': return scope.getByLabel(a.label ?? '');
    case 'getByPlaceholder': return scope.getByPlaceholder(a.placeholder ?? '');
    case 'getByText': return scope.getByText(a.text ?? '');
    case 'getByAltText': return scope.getByAltText(a.alt ?? '');
    case 'getByTitle': return scope.getByTitle(a.title ?? '');
    case 'getByTestId': return scope.getByTestId(a.testid ?? '');
    case 'locator': return scope.locator(a.xpath ? `xpath=${a.xpath}` : (a.css ?? ''));
  }
}
