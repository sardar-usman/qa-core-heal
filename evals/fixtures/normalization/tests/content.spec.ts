import { test, expect } from '@playwright/test';

test('shows the article body', async ({ page }) => {
  await page.goto('http://127.0.0.1:4193/content.html');
  // The page also has #footer-content; exact equality of "content" with
  // the id #content breaks what containment scoring alone would call a tie.
  await expect(page.locator('.content')).toBeVisible();
});
