import { test, expect } from '@playwright/test';

test.describe('orders dashboard', () => {
  // The refresh button and status filter moved into wrapper divs, so the
  // direct-child selectors below no longer match. The revenue span moved
  // into a metric-body wrapper. The order list lost its fourth item and the
  // table gained a Status column, which shifts nth-child positions.

  test('refreshes the order feed', async ({ page }) => {
    await page.goto('http://127.0.0.1:4183/');
    await page.locator('#toolbar > [aria-label="Refresh orders"]').click();
    await expect(page.locator('.sync-note')).toHaveText('Orders refreshed just now.');
  });

  test('filters by status', async ({ page }) => {
    await page.goto('http://127.0.0.1:4183/');
    await page.locator('#filter-bar > [name="status-filter"]').selectOption('Paid');
    await expect(page.getByTestId('kpi-strip')).toHaveText('$8,900');
  });

  test('shows the revenue metric', async ({ page }) => {
    await page.goto('http://127.0.0.1:4183/');
    await expect(page.locator('#kpi-strip > [data-test="revenue-total"]')).toHaveText('$12,480');
  });

  test('reads the fourth order row', async ({ page }) => {
    await page.goto('http://127.0.0.1:4183/');
    await expect(page.locator('.order-list > li:nth-child(4)')).toContainText('Harbor Cafe');
  });

  test('reads the total column', async ({ page }) => {
    await page.goto('http://127.0.0.1:4183/');
    await expect(page.locator('#orders-table td:nth-child(3).col-total')).toHaveText('$310');
  });

  test('quick actions are available', async ({ page }) => {
    await page.goto('http://127.0.0.1:4183/');
    await expect(page.getByRole('button', { name: 'New order' })).toBeVisible();
    await expect(page.getByPlaceholder('Search orders')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Export CSV' })).toBeVisible();
  });
});
