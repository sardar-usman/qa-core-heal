import { test, expect } from '@playwright/test';

test('archives the order', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/rot.html');
  // Typo'd id: heals on page v1. The eval then adds a DUPLICATE
  // aria-label to the page and re-runs: the healed locator must refuse
  // with both candidates named, never silently re-heal to either.
  await page.locator('#archive-ordr').click();
  await expect(page.locator('#rot-note')).toHaveText('archived');
});
