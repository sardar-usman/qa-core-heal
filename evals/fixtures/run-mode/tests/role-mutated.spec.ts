import { test } from '@playwright/test';
import { NavPage } from '../pages/nav-page';

test('follows the primary action', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  // The POM locator says link; the page has a button with that exact
  // accessible name. Must match to source (multi-line call) and heal the
  // role back to button.
  const nav = new NavPage(page);
  await nav.trigger().click();
});
