import { test, expect } from '@playwright/test';

test('clicks the link twice', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/duplink.html');
  // The SAME broken literal twice: one heal, two occurrences.
  await page.getByText("Link Buton").click();
  await page.getByText("Link Buton").click();
  // Twin B: near-identical but DIFFERENT literal, valid — untouched.
  await page.getByRole('link', { name: 'Link Button Two' }).click();
  await expect(page.locator('#note')).toHaveText('xxy');
});
