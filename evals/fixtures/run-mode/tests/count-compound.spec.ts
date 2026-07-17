import { test, expect } from '@playwright/test';

test('finds the primary button', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/');
  // The real-world 0.2.1 case (uitestingplayground.com): a compound CSS
  // selector whose tag token is a typo (buttons -> button), asserted via
  // toHaveCount(1). Actual count 0 classifies as a locator failure and the
  // css-tag-fix stage proposes the corrected compound selector itself.
  await expect(page.locator('buttons.btn.btn-primary')).toHaveCount(1);
});
