import type { Page } from '@playwright/test';

export class NavPage {
  constructor(private page: Page) {}

  // Prettier-wrapped on purpose: the locator call spans several lines, the
  // way long getByRole calls look in real POMs. Source matching must still
  // find it. The role is mutated (the live element is a button).
  trigger() {
    return this.page.getByRole('link', {
      name: 'Primary action',
      exact: true,
    });
  }
}
