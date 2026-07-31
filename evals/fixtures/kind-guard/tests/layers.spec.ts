import { test } from '@playwright/test';

test('clicks the blue layer button', async ({ page }) => {
  await page.goto('http://127.0.0.1:4195/hiddenlayers.html');
  // The broken id names its target; a bare getByRole("button") names
  // nothing. An anonymous replacement must refuse, never propose.
  await page.locator('#blueButton').click();
});
