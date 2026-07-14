import { type Page } from '@playwright/test';

/**
 * A login helper that runs without error but never actually authenticates
 * (visits the login page, posts nothing) — the silent-failure case.
 */
export async function login(page: Page): Promise<void> {
  await page.goto('http://127.0.0.1:4188/login');
}
