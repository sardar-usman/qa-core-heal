import { test, expect } from '@playwright/test';

test('shows the quarterly report entry', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/listing.html');
  // Mangled name, below the fuzzy heal threshold: the refusal must be the
  // normal scored near-miss, because listitem is not widget-gated.
  await expect(page.getByRole('listitem', { name: 'Quartrly rev reprt' })).toBeVisible();
});
