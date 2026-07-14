import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bug 2: per-locator page context. Locators must be probed on the route
 * their spec actually navigates to, not on the base URL homepage. POM files
 * inherit the routes of the specs that import them.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {
  parseGotos, routeForLine, stripAutoSuffixes, buildRoutePlan, routesForLocator, routeLabel,
} = await import(path.join(repoRoot, 'dist', 'routes.js'));

test('parseGotos finds literal goto routes with line numbers', () => {
  const src = [
    "import { test } from '@playwright/test';",
    "test('a', async ({ page }) => {",
    "  await page.goto('/login');",
    "  await page.locator('#x').click();",
    "});",
    "test('b', async ({ page }) => {",
    "  await page.goto('https://other.example/register');",
    "});",
  ].join('\n');
  const gotos = parseGotos(src);
  assert.deepEqual(gotos, [
    { line: 3, route: '/login' },
    { line: 7, route: 'https://other.example/register' },
  ]);
});

test('parseGotos resolves goto(this.url) from a same-file url property', () => {
  const src = [
    'export class P {',
    "  readonly url = 'http://127.0.0.1:4182/';",
    '  async goto() {',
    '    await this.page.goto(this.url);',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(parseGotos(src), [{ line: 4, route: 'http://127.0.0.1:4182/' }]);
});

test('routeForLine picks the nearest preceding goto, else the first in the file', () => {
  const gotos = [
    { line: 3, route: '/login' },
    { line: 8, route: '/register' },
  ];
  assert.equal(routeForLine(gotos, 5), '/login');
  assert.equal(routeForLine(gotos, 9), '/register');
  // A locator ABOVE every goto (POM constructor) falls back to the first goto.
  assert.equal(routeForLine(gotos, 1), '/login');
  assert.equal(routeForLine([], 5), null);
});

test('stripAutoSuffixes drops trailing generated id fragments only', () => {
  assert.equal(stripAutoSuffixes('Email 1'), 'Email');
  assert.equal(stripAutoSuffixes('email 9c31f7'), 'email');
  assert.equal(stripAutoSuffixes('submit button'), null);   // nothing generated
  assert.equal(stripAutoSuffixes('order list'), null);
  assert.equal(stripAutoSuffixes('42'), null);              // nothing would remain
  assert.equal(stripAutoSuffixes('Email'), null);           // single word, nothing stripped
});

test('stripAutoSuffixes also strips trailing digits glued to the word', () => {
  assert.equal(stripAutoSuffixes('search1'), 'search');
  assert.equal(stripAutoSuffixes('email2'), 'email');
  assert.equal(stripAutoSuffixes('login form 3'), 'login form'); // whole-word rule still first
  assert.equal(stripAutoSuffixes('v2'), null);              // alpha prefix too short to be identity
  assert.equal(stripAutoSuffixes('search'), null);          // no digits, nothing stripped
});

function planFor({ files, specFiles, overrides, baseUrl }) {
  return buildRoutePlan({
    files,
    specFiles: new Map(Object.entries(specFiles)),
    overrides,
    baseUrl,
  });
}

const BASE = 'https://shop.example';

test('spec locators use the route of their own goto, joined with the base URL', () => {
  const spec = {
    path: '/p/tests/login.spec.ts',
    src: "test('a', async ({ page }) => {\n  await page.goto('/login');\n  await page.locator('#x').click();\n});",
  };
  const plan = planFor({ files: [spec], specFiles: { [spec.path]: [spec.path] }, baseUrl: BASE });
  assert.deepEqual(routesForLocator(plan, spec.path, 3), ['https://shop.example/login']);
});

test('a POM with its own goto uses that route for all its locators', () => {
  const pom = {
    path: '/p/pages/login-page.ts',
    src: "export class P {\n  x = this.page.locator('#Email_1');\n  async goto() { await this.page.goto('/login'); }\n}",
  };
  const spec = { path: '/p/tests/login.spec.ts', src: 'import P from "../pages/login-page";' };
  const plan = planFor({
    files: [spec, pom],
    specFiles: { [spec.path]: [spec.path, pom.path] },
    baseUrl: BASE,
  });
  // The locator on line 2 sits ABOVE the goto; it still belongs to /login.
  assert.deepEqual(routesForLocator(plan, pom.path, 2), ['https://shop.example/login']);
});

test('a POM without a goto inherits the routes of every importing spec', () => {
  const pom = { path: '/p/pages/header.ts', src: "export class H { cart = this.page.locator('.ico-cart'); }" };
  const specA = { path: '/p/tests/login.spec.ts', src: "await page.goto('/login');" };
  const specB = { path: '/p/tests/register.spec.ts', src: "await page.goto('/register');" };
  const plan = planFor({
    files: [specA, specB, pom],
    specFiles: {
      [specA.path]: [specA.path, pom.path],
      [specB.path]: [specB.path, pom.path],
    },
    baseUrl: BASE,
  });
  assert.deepEqual(routesForLocator(plan, pom.path, 1), [
    'https://shop.example/login',
    'https://shop.example/register',
  ]);
});

test('a spec with no goto of its own inherits the first route of its POMs', () => {
  const pom = {
    path: '/p/pages/login-page.ts',
    src: 'export class P {\n  async goto() { await this.page.goto("/login"); }\n}',
  };
  const spec = { path: '/p/tests/login.spec.ts', src: "await expect(login.emailInput).toBeVisible();" };
  const plan = planFor({
    files: [spec, pom],
    specFiles: { [spec.path]: [spec.path, pom.path] },
    baseUrl: BASE,
  });
  assert.deepEqual(routesForLocator(plan, spec.path, 1), ['https://shop.example/login']);
});

test('--route override beats inference and applies per file', () => {
  const pom = {
    path: '/p/pages/login-page.ts',
    src: 'export class P {\n  async goto() { await this.page.goto("/login"); }\n}',
  };
  const spec = { path: '/p/tests/login.spec.ts', src: "await page.goto('/login');" };
  const plan = planFor({
    files: [spec, pom],
    specFiles: { [spec.path]: [spec.path, pom.path] },
    overrides: [{ file: 'pages/login-page.ts', route: '/login-v2' }],
    baseUrl: BASE,
  });
  assert.deepEqual(routesForLocator(plan, pom.path, 2), ['https://shop.example/login-v2']);
  assert.deepEqual(routesForLocator(plan, spec.path, 1), ['https://shop.example/login']);
});

test('a file with no goto anywhere falls back to the base URL', () => {
  const spec = { path: '/p/tests/plain.spec.ts', src: "await page.locator('#x').click();" };
  const plan = planFor({ files: [spec], specFiles: { [spec.path]: [spec.path] }, baseUrl: BASE });
  assert.deepEqual(routesForLocator(plan, spec.path, 1), ['https://shop.example/']);
});

test('routeLabel shows the path of a resolved route', () => {
  assert.equal(routeLabel('https://shop.example/login'), '/login');
  assert.equal(routeLabel('https://shop.example/'), '/');
  assert.equal(routeLabel('https://shop.example/search?q=x'), '/search?q=x');
});
