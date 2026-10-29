import { createRequire } from 'node:module';
import path from 'node:path';

/** Cypress 15.10.0 added the Module API `expose` option and `Cypress.expose()`. */
export const CYPRESS_MIN = '15.10.0';
/** `cy.getByRole` shipped in Cypress 16.2.0. */
export const CYPRESS_GET_BY_ROLE_MIN = '16.2.0';

/**
 * The installed Cypress version, from the project's own `cypress` package.
 * https://docs.cypress.io/app/references/module-api
 */
export function cypressVersion(root: string): string | null {
  try {
    const req = createRequire(path.join(root, 'package.json'));
    const pkg = req('cypress/package.json') as { version?: string };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Compare numeric major.minor.patch. Pre-release suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split('.').slice(0, 3).map((part) => {
    const match = /^(\d+)/.exec(part);
    return match ? Number(match[1]) : 0;
  });
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}
