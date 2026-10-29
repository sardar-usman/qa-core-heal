import fs from 'node:fs';
import path from 'node:path';

/**
 * An `afterEach` in the scratch support file writes the failing page.
 * The directory comes from `Cypress.expose()`, which needs Cypress 15.10.0.
 * https://docs.cypress.io/api/cypress-api/expose
 * https://docs.cypress.io/api/commands/writefile
 */
export const CAPTURE_HOOK = `
afterEach(function () {
  const dir = Cypress.expose('qaCoreHealCapture');
  if (!dir || this.currentTest?.state !== 'failed') return;
  const title = String(this.currentTest.fullTitle?.() || this.currentTest.title || 'test');
  const name = title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'test';
  cy.url({ log: false }).then((url) => {
    cy.document({ log: false }).then((doc) => {
      const html = doc.documentElement ? doc.documentElement.outerHTML : '';
      cy.writeFile(dir + '/' + name + '.json', { url: url, html: html, title: title }, { log: false });
    });
  });
});
`;

const SUPPORT_NAMES = [
  'cypress/support/e2e.js',
  'cypress/support/e2e.ts',
  'cypress/support/index.js',
  'cypress/support/index.ts',
];

/**
 * Append the capture hook to the project's support file.
 * A `supportFile: false` config gets a hook-only file.
 * A custom path is loaded as well: the hook is appended and Cypress is not
 * pointed at a replacement file.
 * https://docs.cypress.io/app/references/configuration#e2e
 */
export function attachCapture(scratchRoot: string, configSource: string | null): { supportFile?: string } {
  const disabled = configSource != null && /supportFile\s*:\s*false/.test(configSource);
  if (disabled) {
    const rel = 'cypress/support/qa-core-heal-capture.js';
    const file = path.join(scratchRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${CAPTURE_HOOK}\n`);
    return { supportFile: file };
  }
  const custom = configSource ? /supportFile\s*:\s*['"]([^'"]+)['"]/.exec(configSource) : null;
  const names = custom ? [custom[1]!] : SUPPORT_NAMES;
  for (const rel of names) {
    const file = path.join(scratchRoot, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('qaCoreHealCapture')) fs.appendFileSync(file, `\n${CAPTURE_HOOK}\n`);
    return {};
  }
  const rel = custom ? custom[1]! : 'cypress/support/e2e.js';
  const file = path.join(scratchRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${CAPTURE_HOOK}\n`);
  return custom ? {} : { supportFile: file };
}

/**
 * Cypress has no testIdAttribute setting. The best-practices page lists
 * data-cy, data-test, and data-testid. This heal reads `testIdAttribute`
 * when a project sets it, and otherwise uses data-test.
 * https://docs.cypress.io/app/core-concepts/best-practices#Selecting-Elements
 */
export function testIdAttributeFrom(configSource: string | null): string {
  const found = configSource ? /testIdAttribute\s*:\s*['"]([A-Za-z_][\w-]*)['"]/.exec(configSource) : null;
  return found?.[1] ?? 'data-test';
}
