import { type Locator, type Page } from '@playwright/test';

/**
 * Page object for the demowebshop register page. Every locator here is
 * valid on the live /register page. #register-button in particular is a
 * submit <input> on /register; it must NEVER be "healed" to the Register
 * nav link that exists in the site header on every other page.
 */
export class RegisterPage {
  readonly page: Page;
  readonly firstNameInput: Locator;
  readonly lastNameInput: Locator;
  readonly emailInput: Locator;
  readonly registerButton: Locator;
  /**
   * Exists ONLY after the form is submitted (the confirmation page).
   * Static probing can never see it; the honest verdict is a refusal, and
   * heal must say so rather than loosen its matching to force a heal.
   */
  readonly resultNotice: Locator;

  constructor(page: Page) {
    this.page = page;
    this.firstNameInput = this.page.locator('#FirstName');
    this.lastNameInput = this.page.locator('#LastName');
    this.emailInput = this.page.locator('#Email');
    this.registerButton = this.page.locator('#register-button');
    this.resultNotice = this.page.locator('.result');
  }

  async goto(): Promise<void> {
    await this.page.goto('/register');
  }
}
