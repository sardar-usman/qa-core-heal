# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: landing.spec.ts >> landing page >> shows the newsletter headline
- Location: tests/landing.spec.ts:7:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Join the Weekly Reader newsletter')
Expected: visible
Timeout: 3000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 3000ms
  - waiting for getByText('Join the Weekly Reader newsletter')

```

```yaml
- heading "Join the Bulldog Books newsletter" [level=1]
- paragraph: One email a week, no spam.
- text: Email
- textbox "Email":
  - /placeholder: you@example.com
- checkbox "Weekly digest"
- text: Weekly digest
- button "Subscribe now"
- paragraph: You are not subscribed yet.
- link "Browse past issues":
  - /url: "#archive"
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test.describe('landing page', () => {
  4  |   // The headline copy changed on the page, so this text locator is stale.
  5  |   // Heal refuses it on purpose: when the identity WAS the text and the text
  6  |   // is gone, any replacement would be a guess. A human updates the copy.
  7  |   test('shows the newsletter headline', async ({ page }) => {
  8  |     await page.goto('http://127.0.0.1:4173/');
> 9  |     await expect(page.getByText('Join the Weekly Reader newsletter')).toBeVisible();
     |                                                                       ^ Error: expect(locator).toBeVisible() failed
  10 |   });
  11 | 
  12 |   test('shows the tagline and the archive link', async ({ page }) => {
  13 |     await page.goto('http://127.0.0.1:4173/');
  14 |     await expect(page.getByTestId('tagline')).toBeVisible();
  15 |     await expect(page.getByRole('link', { name: 'Browse past issues' })).toBeVisible();
  16 |   });
  17 | });
  18 | 
```