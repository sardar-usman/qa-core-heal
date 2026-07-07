import { test, expect } from '@playwright/test';
import { NewsletterPage } from '../pages/newsletter-page';

test.describe('newsletter signup', () => {
  test('subscribes with an email and the weekly digest', async ({ page }) => {
    const newsletter = new NewsletterPage(page);
    await newsletter.goto();
    await newsletter.emailInput.fill('reader@example.com');
    await newsletter.weeklyDigest.check();
    await newsletter.subscribeButton.click();
    await expect(newsletter.statusNote).toHaveText('You are subscribed.');
  });

  test('starts unsubscribed', async ({ page }) => {
    const newsletter = new NewsletterPage(page);
    await newsletter.goto();
    await expect(newsletter.statusNote).toHaveText('You are not subscribed yet.');
  });
});
