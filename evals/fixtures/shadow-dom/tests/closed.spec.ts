import { test } from '@playwright/test';

test('reveals the secret', async ({ page }) => {
  await page.goto('http://127.0.0.1:4194/closed.html');
  // The button lives in a CLOSED shadow root: unreachable for Playwright
  // and for the probe. The refusal must name the closed roots.
  await page.locator('.hiddenAction').click();
});
