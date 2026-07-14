import { type Page } from '@playwright/test';

/**
 * The project's own login helper: navigates RELATIVELY (like login helpers
 * written for Playwright test contexts, which carry use.baseURL), then
 * posts credentials; the server sets the session cookie in the context.
 * Exactly what --auth-setup points at — and a pin that the probing context
 * carries the resolved base URL.
 */
export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  const res = await page.request.post('/api/login', {
    data: { user: 'admin', pass: 'secret' },
  });
  if (!res.ok()) throw new Error(`login failed with status ${res.status()}`);
}
