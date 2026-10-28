/**
 * Playwright strict locator semantics: exactly one match (`count() === 1`).
 *
 * Other adapters must implement their own framework's matching rule
 * (Cypress `cy.contains` and `cy.get`, Selenium first-match and non-piercing
 * CSS and XPath). A Playwright count is not proof for them.
 */
export async function uniqueInTarget(
  _probePage: unknown,
  target: { count(): Promise<number> },
): Promise<boolean> {
  try { return (await target.count()) === 1; } catch { return false; }
}
