import { test } from '@playwright/test';

test('chooses the basic plan', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/plans.html');
  // .first() was deleted: the locator now matches all three identical
  // buttons and Playwright fails with a strict mode violation. Healing
  // must refuse — the positional intent is deleted information.
  await page.getByRole('button', { name: 'Choose plan', exact: true }).click();
});
