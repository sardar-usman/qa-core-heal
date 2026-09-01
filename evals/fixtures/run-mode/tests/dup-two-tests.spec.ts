import { test, expect } from '@playwright/test';

// Twin A: the same broken literal in TWO failing tests. Each test's own
// failure heals its own occurrence — scoped to its own body, never wider.

test('first pass', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/duplink.html');
  await page.getByText("Link Buton").click();
  await expect(page.locator('#note')).toHaveText('x');
});

test('second pass', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/duplink.html');
  await page.getByText("Link Buton").click();
  await expect(page.locator('#note')).toHaveText('x');
});
