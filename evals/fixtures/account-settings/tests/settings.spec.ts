import { test, expect } from '@playwright/test';

test.describe('account settings', () => {
  // The update-card button moved inside the billing iframe. The connected
  // apps section renders 400ms after load and its auto-generated ids
  // changed. The save button class and the help link class were renamed.

  test('accepts the cookie notice', async ({ page }) => {
    await page.goto('http://127.0.0.1:4184/');
    await page.getByRole('button', { name: 'Accept cookies' }).click();
    await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible();
  });

  test('saves the display name', async ({ page }) => {
    await page.goto('http://127.0.0.1:4184/');
    await page.getByLabel('Display name').fill('Rosa Vane');
    await page.locator('.save-preferences').click();
    await expect(page.getByTestId('settings-status')).toHaveText('Preferences saved.');
  });

  test('searches the connected apps', async ({ page }) => {
    await page.goto('http://127.0.0.1:4184/');
    await page.locator('#app-search-77aa21').fill('slack');
    await expect(page).toHaveTitle('Account settings');
  });

  test('toggles the weekly digest', async ({ page }) => {
    await page.goto('http://127.0.0.1:4184/');
    await page.locator('#digest-checkbox-52ba17').check();
    await expect(page).toHaveTitle('Account settings');
  });

  test('requests a card update', async ({ page }) => {
    await page.goto('http://127.0.0.1:4184/');
    await page.locator('[data-test="update-card"]').click();
    await expect(page).toHaveTitle('Account settings');
  });

  test('shows the card on file', async ({ page }) => {
    await page.goto('http://127.0.0.1:4184/');
    await expect(page.frameLocator('#billing-frame').getByText('Card on file: Visa ending 4242.')).toBeVisible();
  });

  test('opens the help center', async ({ page }) => {
    await page.goto('http://127.0.0.1:4184/');
    await page.locator('.help-center').click();
    await expect(page).toHaveURL(/#help/);
  });
});
