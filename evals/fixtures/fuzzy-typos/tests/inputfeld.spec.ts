import { test, expect } from '@playwright/test';

test('fills the amount', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/inputfeld.html');
  // Mid-word typo — the founding use case: Feld vs Field is one edit,
  // comfortably in the fuzzy band, and must heal end-to-end.
  await page.locator('#inputFeld').fill('42');
  await expect(page.locator('#inputField')).toHaveValue('42');
});
