import { test, expect } from '@playwright/test';
import { SignupPage } from '../pages/signup-page';

test.describe('signup', () => {
  test('creates an account with plan and consent', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.fullNameInput.fill('Rosa Vane');
    await signup.usernameInput.fill('rosav');
    await signup.emailInput.fill('rosa@example.com');
    await signup.passwordInput.fill('Str0ng-Pass-2026');
    await signup.planSelect.selectOption('pro');
    await signup.marketingConsent.check();
    await signup.createAccountButton.click();
    await expect(signup.statusNote).toHaveText('Account created. Check your email.');
  });

  test('shows the sign in option', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await expect(signup.heading).toBeVisible();
    await expect(signup.alreadyNote).toBeVisible();
    await expect(signup.signInLink).toBeVisible();
  });

  test('opens the terms', async ({ page }) => {
    const signup = new SignupPage(page);
    await signup.goto();
    await signup.termsLink.click();
    await expect(page).toHaveURL(/#terms/);
  });
});
