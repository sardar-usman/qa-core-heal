import { test, expect } from '@playwright/test';

test.describe('checkout', () => {
  test('fills the email address', async ({ page }) => {
    await page.goto('http://127.0.0.1:4181/');
    await page.locator('#email-7d21ac').fill('mara@example.com');
    await expect(page.getByLabel('Email')).toHaveValue('mara@example.com');
  });

  test('fills the phone number', async ({ page }) => {
    await page.goto('http://127.0.0.1:4181/');
    await page.locator('#phone-4b81de').fill('5550001234');
    await expect(page.getByLabel('Phone')).toHaveValue('5550001234');
  });

  test('places the order', async ({ page }) => {
    await page.goto('http://127.0.0.1:4181/');
    await page.locator('.place-order').click();
    await expect(page.getByTestId('order-status')).toHaveText('Order placed. Confirmation sent.');
  });
});
