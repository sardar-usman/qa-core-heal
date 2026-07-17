import { test } from '@playwright/test';

test('clicks the dashed primary action', async ({ page }) => {
  await page.goto('http://127.0.0.1:4192/none.html');
  // Dashed tag: spec-legal custom-element name OR a typo — undecidable
  // from the page, so never healed; the refusal hints at the closest
  // valid tag ('button', two edits away).
  await page.locator('button-1.btn.btn-primary').click();
});
