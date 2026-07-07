import { type Locator, type Page } from '@playwright/test';

/**
 * Page object for the newsletter signup page.
 *
 * Two locators here are deliberately stale, as if the app changed under the
 * suite: the email input's auto-generated id changed on the page, and the
 * subscribe button's CSS class was renamed. Run the heal CLI to repair them.
 */
export class NewsletterPage {
  readonly page: Page;
  readonly url = 'http://127.0.0.1:4173/';
  readonly emailInput: Locator;
  readonly weeklyDigest: Locator;
  readonly subscribeButton: Locator;
  readonly statusNote: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = this.page.locator('#email-4f9c21');
    this.weeklyDigest = this.page.getByRole('checkbox', { name: 'Weekly digest' });
    this.subscribeButton = this.page.locator('.subscribe-now');
    this.statusNote = this.page.getByTestId('status-note');
  }

  async goto(): Promise<void> {
    await this.page.goto(this.url);
  }
}
