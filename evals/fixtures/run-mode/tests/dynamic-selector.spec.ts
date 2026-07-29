import { test } from '@playwright/test';
import { SelectPage } from '../pages/select-page';

test('picks via dynamic locator', async ({ page }) => {
  await page.goto('http://127.0.0.1:4188/select.html');
  // Built from a variable in the POM: the runtime selector matches no
  // literal call — teaching message, never "bug worth reporting".
  await new SelectPage(page).dynamicOptions.first().click();
});
