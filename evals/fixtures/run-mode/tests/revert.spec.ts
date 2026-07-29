import { test, expect } from '@playwright/test';

test('submits the order', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/revert.html');
  // Heals to the page's #submit-order button — plausibly, by identity —
  // but that button never sets the note, so the test STILL fails after
  // the heal. Contract: revert, say so loudly, keep the audit history.
  await page.locator('#submit-ordr').click();
  await expect(page.locator('#submit-note')).toHaveText('submitted');
});
