import { test, expect } from '@playwright/test';

test('names the button', async ({ page }) => {
  await page.goto('http://127.0.0.1:4187/textinput.html');
  // Truncated id: one character short of #newButtonName. The heal must
  // emit the stable id (the old build emitted the broken token as a
  // role name: getByRole("textbox",{"name":"new Button Nam"})).
  await page.locator('#newButtonNam').fill('Renamed');
  await expect(page.locator('#newButtonName')).toHaveValue('Renamed');
});
