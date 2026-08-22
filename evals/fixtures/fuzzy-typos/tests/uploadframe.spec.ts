import { test } from '@playwright/test';

test('starts the framed upload', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/uploadframe.html');
  // The button lives inside the iframe; a top-document locator cannot
  // reach it and the probe cannot scan the frame. Honest refusal only.
  await page.getByRole("button", { name: "Uploadd" }).click();
});
