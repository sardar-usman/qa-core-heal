import { type Locator, type Page } from '@playwright/test';

/**
 * Page object for the signup page. Six locators are deliberately stale:
 * two auto-generated ids changed, three CSS classes were renamed, and the
 * data-test attribute was removed from the marketing checkbox.
 */
export class SignupPage {
  readonly page: Page;
  readonly url = 'http://127.0.0.1:4182/';
  readonly heading: Locator;
  readonly fullNameInput: Locator;
  readonly usernameInput: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly planSelect: Locator;
  readonly marketingConsent: Locator;
  readonly createAccountButton: Locator;
  readonly statusNote: Locator;
  readonly alreadyNote: Locator;
  readonly signInLink: Locator;
  readonly termsLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = this.page.getByRole('heading', { name: 'Create your account' });
    this.fullNameInput = this.page.getByLabel('Full name');
    this.usernameInput = this.page.getByPlaceholder('Choose a username');
    this.emailInput = this.page.locator('#email-9c31f7');
    this.passwordInput = this.page.locator('#password-33d1ab');
    this.planSelect = this.page.locator('.plan-selector');
    this.marketingConsent = this.page.locator('[data-test="marketing-consent"]');
    this.createAccountButton = this.page.locator('.create-account');
    this.statusNote = this.page.getByTestId('signup-status');
    this.alreadyNote = this.page.getByText('Already have an account?');
    this.signInLink = this.page.getByRole('link', { name: 'Sign in instead' });
    this.termsLink = this.page.locator('.terms-link');
  }

  async goto(): Promise<void> {
    await this.page.goto(this.url);
  }
}
