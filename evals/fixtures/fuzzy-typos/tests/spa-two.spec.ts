import { test } from '@playwright/test';

// Counter-case to spa.spec.ts: TWO fields carry "search" as a whole word
// of their accessible names — refusing with both named is the only honest
// verdict for the same mutated locator.
test('searches amounts', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/spa-two.html');
  await page.getByRole('textbox', { name: 'search1' }).fill('9', { timeout: 2500 });
});
