import { test, expect } from '@playwright/test';

test.describe('inventory', () => {
  // The quantity input id has an in-word typo (quantiy vs quantity): fuzzy
  // matching should heal it. The export "button" id is a typo of an id that
  // belongs to a LINK: healing it would change the element kind, so heal
  // must refuse. The email locator normalizes to an identifier two inputs
  // carry: heal must refuse as ambiguous rather than pick one.

  test('sets the quantity', async ({ page }) => {
    await page.goto('http://127.0.0.1:4187/');
    await page.locator('#quantiy-field').fill('3');
    await expect(page.getByLabel('Quantity')).toHaveValue('3');
  });

  test('downloads the export', async ({ page }) => {
    await page.goto('http://127.0.0.1:4187/');
    await page.locator('#export-button').click();
  });

  test('fills the contact email', async ({ page }) => {
    await page.goto('http://127.0.0.1:4187/');
    await page.locator('#emai_l').fill('rosa@example.com');
  });

  test('fills the contact email by role', async ({ page }) => {
    await page.goto('http://127.0.0.1:4187/');
    await page.getByRole('textbox', { name: 'emial' }).fill('rosa@example.com');
  });

  test('saves the inventory', async ({ page }) => {
    await page.goto('http://127.0.0.1:4187/');
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
