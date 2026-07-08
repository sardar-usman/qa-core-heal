import { test, expect } from '@playwright/test';

test.describe('order actions', () => {
  // Hostile case. A 1ms interval swaps the two buttons' id and title
  // attributes and rebinds their click handlers by id. The broken locator
  // below can never resolve, and the only attributes that carry its token
  // are the ones being rewritten, so heal must refuse deterministically
  // with the instability reason instead of flipping verdicts per run.

  test('submits the order', async ({ page }) => {
    await page.goto('http://127.0.0.1:4186/');
    await page.locator('#submit-button').click();
    await expect(page.getByTestId('order-status')).toHaveText('Order submitted.');
  });

  test('shows both actions', async ({ page }) => {
    await page.goto('http://127.0.0.1:4186/');
    await expect(page.getByRole('button', { name: 'Cancel Order' })).toBeVisible();
  });
});
