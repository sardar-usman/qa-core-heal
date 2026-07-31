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

  // The 0.3.2 field shape: an .and() combinator whose argument was
  // mutated (.btnprimary vs the page's .btn-primary). The base getByRole
  // alone is HEALTHY and matches a literal — probing only the base would
  // report a false "1 intact" while every test using this stays red.
  get primaryAction() {
    return this.page.getByRole('button', { name: 'Button', exact: true }).and(this.page.locator('.btnprimary'));
  }

  // The .or() twin: both arms broken; the first arm alone would be
  // probed (and "healed") as a chain fragment if the chain were missed.
  get anyAction() {
    return this.page.locator('.btnprimary').or(this.page.getByLabel('Nope'));
  }
}
