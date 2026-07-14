import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/login-page';
import { HeaderNav } from '../pages/header-nav';

test.describe('login', () => {
  test('fills the login email', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.emailInput.fill('qa-core-heal@example.com');
    await expect(login.emailInput).toHaveValue('qa-core-heal@example.com');
  });

  test('fills the login email via legacy id', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.legacyEmailInput.fill('qa-core-heal@example.com');
    await expect(login.legacyEmailInput).toHaveValue('qa-core-heal@example.com');
  });

  test('fills the login email via mutated role name', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.emailInputByRole.fill('qa-core-heal@example.com');
    await expect(login.emailInputByRole).toHaveValue('qa-core-heal@example.com');
  });

  test('shows the password field and login button', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await expect(login.passwordInput).toBeVisible();
    await expect(login.loginButton).toBeVisible();
  });

  test('shows the cart link on the login page', async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    const header = new HeaderNav(page);
    await expect(header.shoppingCartLink.first()).toBeVisible();
  });
});
