import { test, expect } from '@playwright/test';

test.describe('pricing page', () => {
  // Hostile cases. The headline and the guarantee line were both reworded,
  // so their text locators have no identity left to heal from and must be
  // refused. The launch banner was removed from the page entirely. The
  // trial button class, the email id, and the cycle select class are
  // healable breaks.

  test('shows the pricing headline', async ({ page }) => {
    await page.goto('http://127.0.0.1:4185/');
    await expect(page.getByText('Simple pricing for growing teams')).toBeVisible();
  });

  test('lists the plan guarantee', async ({ page }) => {
    await page.goto('http://127.0.0.1:4185/');
    await expect(page.getByText('All plans include unlimited projects')).toBeVisible();
  });

  test('shows the launch banner', async ({ page }) => {
    await page.goto('http://127.0.0.1:4185/');
    await expect(page.locator('.launch-banner')).toBeVisible();
  });

  test('starts a trial', async ({ page }) => {
    await page.goto('http://127.0.0.1:4185/');
    await page.locator('#contact-email-9d13aa').fill('rosa@example.com');
    await page.locator('.start-trial').click();
    await expect(page.getByTestId('trial-status')).toHaveText('Trial started. Check your inbox.');
  });

  test('switches to yearly billing', async ({ page }) => {
    await page.goto('http://127.0.0.1:4185/');
    await page.locator('.billing-cycle').selectOption('yearly');
    await expect(page.getByTestId('plan-grid')).toContainText('per year');
  });

  test('offers a sales contact', async ({ page }) => {
    await page.goto('http://127.0.0.1:4185/');
    await expect(page.getByRole('heading', { name: 'Pricing that scales with you' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Talk to sales' })).toBeVisible();
  });
});
