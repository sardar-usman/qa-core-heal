import { test } from '@playwright/test';

test('picks the blue color', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/picker.html');
  // The picker is never opened: role "option" is state-gated — it only
  // exists while the widget is open. The locator is not broken; the test
  // is missing the opening click. The tool must refuse and teach.
  await page.getByRole('option', { name: 'Blue' }).click();
});
