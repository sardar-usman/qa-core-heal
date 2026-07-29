import { test } from '@playwright/test';
import { SelectPage } from '../pages/select-page';

test('picks via chained locator', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/select.html');
  // Built by chaining in the POM: the tool must say so — never match the
  // chain's base and report a false intact.
  await new SelectPage(page).chainedOptions.first().click();
});
