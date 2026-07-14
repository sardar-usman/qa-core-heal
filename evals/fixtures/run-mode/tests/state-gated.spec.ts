import { test } from '@playwright/test';

test('confirms the order', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  // Navigate by clicking through: the confirm button lives on /details.html,
  // a page no goto() ever names. Static scan probes the goto route and must
  // refuse; run mode sees the real failure URL and can heal there.
  await page.click('#open-details');
  await page.locator('#confirm-orderr').click();
});
