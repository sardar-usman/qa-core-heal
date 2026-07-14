import { type Locator, type Page } from '@playwright/test';

/**
 * Second hop: the broken locator (an attribute selector mirroring the real
 * repo's [name="search_field_1"]) lives two imports away from the spec.
 */
export class SearchWidget {
  readonly page: Page;
  readonly quantityField: Locator;

  constructor(page: Page) {
    this.page = page;
    this.quantityField = this.page.locator('[name="quantity_field_1"]');
  }
}
