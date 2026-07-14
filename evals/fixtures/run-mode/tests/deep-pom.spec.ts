import { test, expect } from '@playwright/test';
import { AccountPage } from '../pages/account-page';

test('searches the quantity two imports deep', async ({ page }) => {
  const account = new AccountPage(page);
  await account.goto();
  await account.search.quantityField.fill('4', { timeout: 3000 });
  await expect(page.getByLabel('Quantity')).toHaveValue('4');
});
