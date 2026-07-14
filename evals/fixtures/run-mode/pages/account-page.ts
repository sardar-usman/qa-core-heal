import { type Page } from '@playwright/test';
import { SearchWidget } from './widgets/search-widget';

/**
 * First hop of a two-deep import chain: the spec imports this page object,
 * which imports the widget that actually owns the broken locator.
 */
export class AccountPage {
  readonly page: Page;
  readonly search: SearchWidget;

  constructor(page: Page) {
    this.page = page;
    this.search = new SearchWidget(page);
  }

  async goto(): Promise<void> {
    await this.page.goto('http://127.0.0.1:4188/');
  }
}
