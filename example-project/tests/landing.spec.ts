import { test, expect } from '@playwright/test';

test.describe('landing page', () => {
  // The headline copy changed on the page, so this text locator is stale.
  // Heal refuses it on purpose: when the identity WAS the text and the text
  // is gone, any replacement would be a guess. A human updates the copy.
  test('shows the newsletter headline', async ({ page }) => {
    await page.goto('http://127.0.0.1:4173/');
    await expect(page.getByText('Join the Weekly Reader newsletter')).toBeVisible();
  });

  test('shows the tagline and the archive link', async ({ page }) => {
    await page.goto('http://127.0.0.1:4173/');
    await expect(page.getByTestId('tagline')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse past issues' })).toBeVisible();
  });
});
