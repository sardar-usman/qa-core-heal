import { test, expect } from '@playwright/test';
import { RegisterPage } from '../pages/register-page';
import { HeaderNav } from '../pages/header-nav';

test.describe('register', () => {
  test('shows the register form', async ({ page }) => {
    const reg = new RegisterPage(page);
    await reg.goto();
    await expect(reg.firstNameInput).toBeVisible();
    await expect(reg.lastNameInput).toBeVisible();
    await expect(reg.emailInput).toBeVisible();
    // The register button is the submit input on /register, NOT the nav
    // link in the header. A heal that rewrites it to a link breaks this.
    await expect(reg.registerButton).toBeVisible();
    await expect(reg.registerButton).toHaveAttribute('type', 'submit');
  });

  test('shows the registration result', async ({ page }) => {
    // The .result notice exists only AFTER submitting the form; on the
    // statically probed page it is absent. This test documents the honest
    // refusal: it stays red, and heal must never "fix" it to something else.
    const reg = new RegisterPage(page);
    await reg.goto();
    await expect(reg.resultNotice).toBeVisible();
  });

  test('shows the cart link on the register page', async ({ page }) => {
    const reg = new RegisterPage(page);
    await reg.goto();
    const header = new HeaderNav(page);
    await expect(header.shoppingCartLink.first()).toBeVisible();
  });
});
