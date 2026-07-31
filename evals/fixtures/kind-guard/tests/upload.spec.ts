import { test } from '@playwright/test';

test('starts the upload', async ({ page }) => {
  await page.goto('http://127.0.0.1:4195/upload.html');
  // The declared role is button; the only 'Upload' text on the page is the
  // heading. A heading is not a button — this must refuse, never propose.
  await page.getByRole("button", { name: "Upload" }).click();
});
