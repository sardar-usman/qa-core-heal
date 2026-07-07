import { test, expect } from '@playwright/test';

test.describe('promo and cart', () => {
  test('applies a promo code', async ({ page }) => {
    await page.goto('http://127.0.0.1:4181/');
    await page.getByPlaceholder('Promo code').fill('SAVE10');
    await page.locator('.apply-promo').click();
    await expect(page.getByTestId('promo-status')).toHaveText('Promo SAVE10 applied.');
  });

  test('opens the cart', async ({ page }) => {
    await page.goto('http://127.0.0.1:4181/');
    await page.locator('.view-cart').click();
    await expect(page).toHaveURL(/#cart/);
  });
});
