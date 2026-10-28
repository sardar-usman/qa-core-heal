import type { Locator, Page } from 'playwright';
import type { ProbeQuery } from '../types.js';
import { scopeFor } from './build-locator.js';

/**
 * Playwright strict locator semantics: the number of matches (`locator.count()`).
 * A throw counts as zero, which the core treats as not unique.
 *
 * Other adapters must implement their own framework's matching rule
 * (Cypress `cy.contains` and `cy.get`, Selenium first-match and non-piercing
 * CSS and XPath). A Playwright count is not proof for them.
 */
export async function countQuery(probePage: unknown, query: ProbeQuery): Promise<number> {
  try {
    const page = probePage as Page;
    const scope = scopeFor(page, query.frameChain ?? []);
    return await locatorFor(scope, query).count();
  } catch {
    return 0;
  }
}

function locatorFor(scope: ReturnType<typeof scopeFor>, query: ProbeQuery): Locator {
  switch (query.kind) {
    case 'css':
      return scope.locator(query.selector);
    case 'xpath':
      return scope.locator(`xpath=${query.expression}`);
    case 'testId':
      return scope.getByTestId(query.value);
    case 'role': {
      const role = query.role as Parameters<Page['getByRole']>[0];
      const opts: { name?: string; exact?: boolean } = {};
      if (query.name !== undefined) opts.name = query.name;
      if (query.exact) opts.exact = true;
      return Object.keys(opts).length > 0
        ? scope.getByRole(role, opts)
        : scope.getByRole(role);
    }
    case 'text':
      return query.exact ? scope.getByText(query.text, { exact: true }) : scope.getByText(query.text);
    case 'label':
      return query.exact ? scope.getByLabel(query.text, { exact: true }) : scope.getByLabel(query.text);
    case 'placeholder':
      return query.exact
        ? scope.getByPlaceholder(query.text, { exact: true })
        : scope.getByPlaceholder(query.text);
    case 'title':
      return query.exact ? scope.getByTitle(query.text, { exact: true }) : scope.getByTitle(query.text);
    case 'alt':
      return scope.getByAltText(query.text);
    default: {
      const never: never = query;
      return never;
    }
  }
}
