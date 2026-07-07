# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: newsletter.spec.ts >> newsletter signup >> subscribes with an email and the weekly digest
- Location: tests/newsletter.spec.ts:5:3

# Error details

```
TimeoutError: locator.fill: Timeout 3000ms exceeded.
Call log:
  - waiting for locator('#email-4f9c21')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - heading "Join the Bulldog Books newsletter" [level=1] [ref=e2]
  - paragraph [ref=e3]: One email a week, no spam.
  - generic [ref=e4]:
    - text: Email
    - textbox "Email" [ref=e5]:
      - /placeholder: you@example.com
    - generic [ref=e6]:
      - checkbox "Weekly digest" [ref=e7]
      - text: Weekly digest
    - button "Subscribe now" [ref=e8]
  - paragraph [ref=e9]: You are not subscribed yet.
  - link "Browse past issues" [ref=e10] [cursor=pointer]:
    - /url: "#archive"
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | import { NewsletterPage } from '../pages/newsletter-page';
  3  | 
  4  | test.describe('newsletter signup', () => {
  5  |   test('subscribes with an email and the weekly digest', async ({ page }) => {
  6  |     const newsletter = new NewsletterPage(page);
  7  |     await newsletter.goto();
> 8  |     await newsletter.emailInput.fill('reader@example.com');
     |                                 ^ TimeoutError: locator.fill: Timeout 3000ms exceeded.
  9  |     await newsletter.weeklyDigest.check();
  10 |     await newsletter.subscribeButton.click();
  11 |     await expect(newsletter.statusNote).toHaveText('You are subscribed.');
  12 |   });
  13 | 
  14 |   test('starts unsubscribed', async ({ page }) => {
  15 |     const newsletter = new NewsletterPage(page);
  16 |     await newsletter.goto();
  17 |     await expect(newsletter.statusNote).toHaveText('You are not subscribed yet.');
  18 |   });
  19 | });
  20 | 
```