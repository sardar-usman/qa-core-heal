import { test, expect } from '@playwright/test';

test.describe('search console', () => {
  // The search field's name lost its suffix; the page re-renders (node
  // replacement) on a 30ms interval. The heal must survive the churn.
  test('searches the catalog', async ({ page }) => {
    await page.goto('http://127.0.0.1:4191/');
    await page.locator('[name="search_field_1"]').fill('widgets', { timeout: 2500 });
    await expect(page.locator('[name="search_field"]')).toHaveValue('widgets');
  });

  // Counter-case: re-resolution lands on a genuinely DIFFERENT control
  // (the type="search" lookup box), which must refuse — with the diff named.
  test('opens the search panel', async ({ page }) => {
    await page.goto('http://127.0.0.1:4191/panel.html');
    await page.locator('#search-panel-42').fill('x', { timeout: 2500 });
  });
});
