import type { Page } from '@playwright/test';

const OPTION_TAG = 'option';

export class SelectPage {
  constructor(private page: Page) {}

  // A CHAINED locator: a .locator() hanging off another locator. Only
  // literal top-level calls can be matched and healed.
  get chainedOptions() {
    return this.page.locator('#country').locator('optionx');
  }

  // A DYNAMIC locator: the selector is not a literal at the call site.
  get dynamicOptions() {
    return this.page.locator(OPTION_TAG + 'x');
  }
}
