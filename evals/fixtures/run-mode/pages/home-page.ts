import { type Locator, type Page } from '@playwright/test';

/**
 * Page object for the orders home page. The quantity locator is broken
 * (the accessible name gained a suffix that no longer exists), and it lives
 * HERE, not in the spec — run mode must match the runtime failure back to
 * this file through the import graph.
 */
export class HomePage {
  readonly page: Page;
  readonly quantityInput: Locator;

  constructor(page: Page) {
    this.page = page;
    this.quantityInput = this.page.getByLabel('Quantity_7');
  }
}
