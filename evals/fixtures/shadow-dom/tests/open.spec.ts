import { test, expect } from '@playwright/test';

test('generates the guid', async ({ page }) => {
  await page.goto('http://127.0.0.1:4194/open.html');
  // Mutated from #buttonGenerate; the button lives in an OPEN shadow root.
  // Playwright pierces open roots natively, so the healer's candidate scan
  // must see the shadow id too.
  await page.locator('.buttonGenerate').click();
  await expect(page.locator('#status')).toHaveText('generated');
});
