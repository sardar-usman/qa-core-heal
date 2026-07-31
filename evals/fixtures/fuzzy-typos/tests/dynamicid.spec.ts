import { test, expect } from '@playwright/test';

test('opens the dynamic id section', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/dynamicid.html');
  // Mutated text: "Dynamic 1ID" vs the heading "Dynamic ID" is one edit.
  // The substring locator would be ambiguous (the button caption contains
  // the phrase); the heal must resolve exactly.
  await page.getByText("Dynamic 1ID").click();
  await expect(page.locator('#note')).toHaveText('section');
});

test('opens the scenario notes', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/dynamicid.html');
  // The companion heal from the same field page: substring-unique.
  await page.getByText("Scenarios").click();
  await expect(page.locator('#note')).toHaveText('scenario');
});
