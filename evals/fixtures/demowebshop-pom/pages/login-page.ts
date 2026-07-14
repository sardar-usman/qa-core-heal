import { type Locator, type Page } from '@playwright/test';

/**
 * Page object for the demowebshop login page. Three locators are
 * deliberately stale: the email input id changed from Email_1 to Email on
 * the live page (auto-suffix case), a second reference carries an in-word
 * typo, Emai_l (fuzzy case), and a third addresses the field by a mutated
 * getByRole accessible name (fuzzy on a semantic identity). All navigation
 * is relative; the base URL comes from playwright.config.ts.
 */
export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly legacyEmailInput: Locator;
  readonly emailInputByRole: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = this.page.locator('#Email_1');
    this.legacyEmailInput = this.page.locator('#Emai_l');
    this.emailInputByRole = this.page.getByRole('textbox', { name: 'Ema_il_2' });
    this.passwordInput = this.page.locator('#Password');
    this.loginButton = this.page.locator('.login-button');
  }

  async goto(): Promise<void> {
    await this.page.goto('/login');
  }
}
