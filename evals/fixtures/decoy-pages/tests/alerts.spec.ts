import { test, expect } from '@playwright/test';

test('opens the alert', async ({ page }) => {
  await page.goto('http://127.0.0.1:4202/alerts.html');
  // The heading "Alerts" is an exact-text decoy of the wrong kind; the
  // real control is the button "Alert", one edit away.
  await page.getByRole('button', { name: 'Alerts' }).click();
  await expect(page.locator('#note')).toHaveText('alerted');
});
