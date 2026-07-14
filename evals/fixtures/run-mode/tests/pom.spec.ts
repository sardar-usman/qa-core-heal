import { test, expect } from '@playwright/test';
import { HomePage } from '../pages/home-page';

// Three locator-failure shapes run mode must match back to source:
// (a) the broken locator lives in the imported page object, not this spec;
// (b) a getByRole written in source AST style (double quotes, quoted keys)
//     while Playwright's error renders it with single quotes and spacing;
// (c) a plain CSS locator().

test('sets the quantity through the page object', async ({ page }) => {
  const home = new HomePage(page);
  await page.goto('http://127.0.0.1:4188/');
  await home.quantityInput.fill('5');
  await expect(page.getByLabel('Quantity')).toHaveValue('5');
});

test('sets the quantity by role', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  await page.getByRole("textbox", {"name":"Quantity_9"}).fill('7');
  await expect(page.getByLabel('Quantity')).toHaveValue('7');
});

test('reads the status', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  await expect(page.locator('#stauts')).toHaveText('Ready');
});
