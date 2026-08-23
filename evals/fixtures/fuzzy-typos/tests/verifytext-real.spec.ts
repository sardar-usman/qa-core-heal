import { test, expect } from '@playwright/test';

test('verifies the composed greeting', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/verifytext-real.html');
  // One edit from the COMPOSED greeting text. The heal must target the
  // real greeting span, never the "Welcome..." scenario badge and never
  // the selector strings displayed in the code samples.
  await expect(page.getByText("Welcome UserNam!")).toBeVisible();
});
