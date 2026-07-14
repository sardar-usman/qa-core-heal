import { type Locator, type Page } from '@playwright/test';

/**
 * Shared header component, imported by BOTH the login and the register
 * specs. It has no goto of its own, so its locators must be probed on the
 * routes of every spec that imports it (/login and /register) and only
 * healed when the results agree.
 */
export class HeaderNav {
  readonly page: Page;
  readonly shoppingCartLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.shoppingCartLink = this.page.locator('.ico-cart');
  }
}
