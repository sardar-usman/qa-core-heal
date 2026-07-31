import { test } from '@playwright/test';

// 0.3.2 field shapes: literal calls that MUST match and probe normally —
// a const-assigned literal (the stack points at the action line, not the
// call line) and the same literal duplicated across tests.

test('generates a guid via assigned literal', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/select.html');
  const btn = page.getByRole('button', { name: 'Generate GUID' });
  await btn.click();
});

test('opens the primary link', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/select.html');
  await page.getByRole('link', { name: 'Primary Button' }).click();
});

test('opens the primary link again', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/select.html');
  await page.getByRole('link', { name: 'Primary Button' }).click();
});
