import type { Page } from 'playwright';
import type { ProbeQuery } from '../types.js';

/**
 * Selenium `findElements` length. CSS uses `querySelectorAll` and does not
 * pierce shadow roots. XPath uses `document.evaluate` snapshot length.
 * Link text follows the W3C WebDriver link text strategy: an `a` element
 * whose visible text equals the string.
 * https://www.w3.org/TR/webdriver2/#locator-strategies
 * https://www.selenium.dev/documentation/webdriver/elements/locators/
 */
export async function seleniumMatchIds(probePage: unknown, query: ProbeQuery): Promise<string[]> {
  const page = probePage as Page;
  try {
    const ids = await page.evaluate((q) => {
      const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const idsOf = (els: Element[]): string[] => els.map((el) => el.id || '');
      if (q.kind === 'css' || q.kind === 'testId') {
        const selector = q.kind === 'css' ? q.selector : `[data-test="${q.value.replace(/"/g, '\\"')}"]`;
        return idsOf(Array.from(document.querySelectorAll(selector)));
      }
      if (q.kind === 'xpath') {
        const found = document.evaluate(q.expression, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const els: Element[] = [];
        for (let i = 0; i < found.snapshotLength; i++) {
          const node = found.snapshotItem(i);
          if (node instanceof Element) els.push(node);
        }
        return idsOf(els);
      }
      if (q.kind === 'text') {
        const want = collapse(q.text);
        const anchors = Array.from(document.querySelectorAll('a'));
        const matched = q.exact === false
          ? anchors.filter((el) => collapse(el.textContent ?? '').includes(want))
          : anchors.filter((el) => collapse(el.textContent ?? '') === want);
        return idsOf(matched);
      }
      return [];
    }, query);
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

export async function countSeleniumQuery(probePage: unknown, query: ProbeQuery): Promise<number> {
  return (await seleniumMatchIds(probePage, query)).length;
}
