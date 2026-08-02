import { test, expect } from '@playwright/test';

test('enables prime mode', async ({ page }) => {
  await page.goto('http://127.0.0.1:4198/');
  // Field shape 1: attribute-equality XPath on an identity attribute.
  await page.locator("//a[@aria-label='Enable Prime mode']").click();
  await expect(page.locator('#note')).toHaveText('prime');
});

test('sees the prime account status', async ({ page }) => {
  await page.goto('http://127.0.0.1:4198/');
  // Field shape 2: role + contains(., text) — role and text intent.
  await expect(page.locator('//div[@role="status"][contains(., "Prime accounts")]')).toBeVisible();
});

test('starts the sync', async ({ page }) => {
  await page.goto('http://127.0.0.1:4198/');
  // H-XPATH-01: bare normalize-space() text identity.
  await page.locator("//*[normalize-space()='Start sync']").click();
  await expect(page.locator('#note')).toHaveText('sync');
});
