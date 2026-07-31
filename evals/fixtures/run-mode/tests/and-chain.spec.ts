import { test } from '@playwright/test';
import { SelectPage } from '../pages/select-page';

test('clicks the primary action via .and() combinator', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/select.html');
  // The .and() argument is mutated in the POM: the chain matches nothing,
  // but the base getByRole alone still matches a literal — the tool must
  // treat the combinator as a chain, never probe the base and claim intact.
  await new SelectPage(page).primaryAction.click();
});
