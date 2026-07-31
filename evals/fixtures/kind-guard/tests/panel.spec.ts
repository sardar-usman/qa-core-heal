import { test, expect } from '@playwright/test';

test('uploads from the panel', async ({ page }) => {
  await page.goto('http://127.0.0.1:4195/panel.html');
  // Declares a button; the matching aria-label sits on a div whose kind
  // cannot be verified — refuse, never guess.
  await page.locator('#uploadButton').click();
});

test('saves the invoice', async ({ page }) => {
  await page.goto('http://127.0.0.1:4195/panel.html');
  // Declares a button; the matching aria-label IS a button. The guard
  // must let this heal through (control against overblocking).
  await page.locator('#saveInvoiceButton').click();
  await expect(page.locator('#note')).toHaveText('saved');
});

test('keeps the intact locator', async ({ page }) => {
  await page.goto('http://127.0.0.1:4195/panel.html');
  await page.locator('#keep-me').click();
});
