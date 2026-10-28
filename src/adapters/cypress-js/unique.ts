import type { Page } from 'playwright';
import type { ProbeQuery } from '../types.js';

/**
 * Cypress `cy.get` uses `document.querySelectorAll` and does not pierce
 * shadow roots unless `includeShadowDom` is on. This probe keeps JavaScript
 * disabled and never pierces.
 * `cy.contains(selector, /^\\s*text\\s*$/)` collapses whitespace and anchors.
 * `cy.getByRole` counts only the native element for that role, with an exact name.
 * https://docs.cypress.io/api/commands/get
 * https://docs.cypress.io/api/commands/contains
 * https://docs.cypress.io/api/commands/getbyrole
 */
export async function countCypressQuery(probePage: unknown, query: ProbeQuery): Promise<number> {
  const page = probePage as Page;
  try {
    const count = await page.evaluate((q) => {
      const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const all = (selector: string): Element[] => Array.from(document.querySelectorAll(selector));
      if (q.kind === 'css' || q.kind === 'testId') {
        const selector = q.kind === 'css' ? q.selector : `[data-cy="${q.value.replace(/"/g, '\\"')}"]`;
        return all(selector).length;
      }
      if (q.kind === 'text') {
        const selector = q.selector && q.selector.length > 0 ? q.selector : '*';
        const want = collapse(q.text);
        return all(selector).filter((el) => collapse(el.textContent ?? '') === want).length;
      }
      if (q.kind === 'role') {
        const want = collapse(q.name ?? '');
        return all(nativeSelector(q.role)).filter((el) => exactName(el) === want).length;
      }
      return 0;

      function nativeSelector(role: string): string {
        switch (role) {
          case 'button': return 'button, input[type="button"], input[type="submit"], input[type="reset"]';
          case 'link': return 'a[href]';
          case 'textbox': return 'input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], textarea';
          case 'checkbox': return 'input[type="checkbox"]';
          case 'radio': return 'input[type="radio"]';
          case 'combobox': return 'select, input[role="combobox"]';
          default: return `[role="${role.replace(/"/g, '')}"]`;
        }
      }
      function exactName(el: Element): string {
        const labelled = el.getAttribute('aria-label');
        if (labelled) return collapse(labelled);
        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (type === 'submit' || type === 'button' || type === 'reset') return collapse((el as HTMLInputElement).value || '');
        }
        return collapse(el.textContent ?? '');
      }
    }, query);
    return typeof count === 'number' ? count : 0;
  } catch {
    return 0;
  }
}
