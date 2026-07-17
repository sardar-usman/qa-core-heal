import { test, expect } from '@playwright/test';

test('triggers the ajax request', async ({ page }) => {
  await page.goto('http://127.0.0.1:4193/ajax.html');
  // The class is gone; the element keeps its camelCase id ajaxButton (the
  // most common real-world mutation: id/class swap). Confirmation must
  // treat "ajax Button" and "ajaxButton" as the same identity.
  await page.locator('.ajaxButton').click();
  await expect(page.locator('#status')).toHaveText('Data loaded');
});
