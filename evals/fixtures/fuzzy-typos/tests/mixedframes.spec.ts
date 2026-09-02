import { test } from '@playwright/test';

test('starts the mixed upload', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/mixedframes.html');
  await page.getByRole("button", { name: "Uploadd" }).click();
});
