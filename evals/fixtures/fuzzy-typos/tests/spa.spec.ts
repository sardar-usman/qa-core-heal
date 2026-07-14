import { test, expect } from '@playwright/test';

// The real-repo mutation: name "search1" against a field whose FULL
// accessible name is "Search by account or login" (label-for, React
// useId id). The stripped identifier is a whole word of the name.
test('searches accounts', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/spa-form.html');
  await page.getByRole('textbox', { name: 'search1' }).fill('acme', { timeout: 2500 });
  await expect(page.getByLabel('Search by account or login')).toHaveValue('acme');
});
