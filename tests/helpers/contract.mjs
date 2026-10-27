import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * Shared helpers for the contract tests (0.4.0). Each test builds a small
 * temporary Playwright project inside the repo (so @playwright/test is found
 * by the normal folder walk), serves a local page, and runs the built CLI.
 */

export const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
// HEAL_CLI_JS points the tests at another build, to show that a test fails on the old code.
export const cliJs = process.env.HEAL_CLI_JS || path.join(repoRoot, 'dist', 'cli.js');
export const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

export function startServer(html) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = typeof html === 'function' ? html(req) : html;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;

export const runCli = (args, cwd, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cliJs, ...args], { cwd, env: env ? { ...process.env, ...env } : undefined });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

/**
 * A temp project. `files` maps a relative path to its source. The config
 * uses one project named "chromium" unless `projects` is given.
 */
export function makeProject(base, files, { projects = [{ name: 'chromium' }], timeout = 8000 } = {}) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, retries: 0, timeout: ${timeout},
  expect: { timeout: 1500 },
  use: { baseURL: '${base}', actionTimeout: 1500 },
  ${projects ? `projects: ${JSON.stringify(projects)},` : ''}
  reporter: [['line']],
});
`);
  for (const [rel, src] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, src);
  }
  return dir;
}

export const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** A findings document with the given findings, valid against contract v1. */
export function findingsDoc(findings, baseUrl = null, configPath = 'playwright.config.ts') {
  return {
    schema: 'qa-core.heal-findings',
    schemaVersion: 1,
    tool: { name: 'qa-core-flaky', version: '0.4.0' },
    project: {
      configPath,
      baseUrl,
      testIdAttribute: 'data-test',
      playwrightVersion: '1.60.0',
    },
    source: { triageSchemaVersion: 1, reports: ['reports/results.json'], commit: null },
    redaction: { applied: true, rules: ['home-user', 'absolute-path', 'url-query'] },
    findings,
  };
}

let counter = 0;
const hex12 = () => (++counter).toString(16).padStart(12, '0');

const PASSED_GATES = ['verdict-not-likely-real-bug', 'verdict-not-environment-issue', 'no-slow-load-signal', 'rule-has-fix-strategy', 'evidence-present']
  .map((name) => ({ name, passed: true }));

/** One finding. Defaults to a locator handoff on the test "fills mail" in tests/a.spec.ts. */
export function finding(over = {}) {
  const mode = over.mode ?? 'locator';
  const { mode: _m, ...rest } = over;
  const file = rest.file ?? 'tests/a.spec.ts';
  const project = rest.project ?? 'chromium';
  const titlePath = rest.titlePath ?? ['fills mail'];
  return {
    findingId: hex12(),
    testId: `${file}::${project}::${titlePath.join(' > ')}`,
    file,
    line: 3,
    project,
    titlePath,
    verdict: 'broken-test',
    verdictConfidence: 'high',
    primaryRuleId: 'SEL-NOTFOUND',
    causes: [{ cause: 'selectors', ruleIds: ['SEL-NOTFOUND'], confidence: 'high', evidence: ['element(s) not found'] }],
    attempts: { total: 3, failed: 3, passed: 0, sameCommit: true },
    errorSignature: `sha256:${'0'.repeat(63)}1`,
    failingSelector: '#email-7d21ac',
    errorLocation: { file, line: 4, column: 40 },
    handoff: {
      mode,
      reason: mode === 'none' ? 'The failure is not a test problem.' : 'Selector rule matched on every failed attempt.',
      gates: mode === 'none' ? PASSED_GATES.map((g, i) => (i === 0 ? { ...g, passed: false } : g)) : PASSED_GATES,
    },
    review: { status: 'Needs Review' },
    ...rest,
  };
}

/** The schemas, loaded once. strict mode on, as in the frozen contract. */
const schemaDir = path.join(repoRoot, 'schemas');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(schemaDir, f), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const resultsSchema = readJson('heal-results.v1.schema.json');
ajv.addSchema(resultsSchema);
export const validateFindings = ajv.compile(readJson('heal-findings.v1.schema.json'));
export const validateResults = ajv.getSchema(resultsSchema.$id);

/** Throw with readable errors when a document does not match its schema. */
export function assertValid(validate, doc, label = 'document') {
  if (!validate(doc)) {
    throw new Error(`${label} does not match the schema: ${JSON.stringify(validate.errors.map((e) => `${e.instancePath} ${e.message}`))}`);
  }
}

export const readJsonFile = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export const writeFindings = (dir, findings, baseUrl = null, name = 'heal-findings.json', configPath = 'playwright.config.ts') => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(findingsDoc(findings, baseUrl, configPath), null, 2));
  return p;
};

/**
 * A project like the SauceDemo kit of qa-core-flaky: package.json at the
 * root, the Playwright config in a folder below it (no config at the root),
 * the specs under that folder's tests/, and a login helper that opens the
 * page through a template literal origin.
 */
export function makeNestedProject(base, { configDir = 'demo/saucedemo', timeout = 8000 } = {}) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "t", "private": true, "type": "module" }');
  const put = (rel, text) => {
    const abs = path.join(dir, configDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  put('playwright.config.ts', `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, retries: 0, timeout: ${timeout},
  expect: { timeout: 1500 },
  use: { baseURL: '${base}', testIdAttribute: 'data-test', actionTimeout: 1500 },
  projects: [{ name: 'chromium' }],
  reporter: [['line']],
});
`);
  put('support/login.ts', `import type { Page } from '@playwright/test';
export const DEMO_ORIGIN = '${base}';
export async function login(page: Page): Promise<void> {
  await page.goto(\`\${DEMO_ORIGIN}/inventory\`);
}
`);
  put('tests/broken.spec.ts', `import { expect, test } from '@playwright/test';
import { login } from '../support/login';

test('typo locator never finds the backpack button', async ({ page }) => {
  await login(page);
  await expect(page.locator('#add-to-cart-sauce-labs-bakpack')).toBeVisible({ timeout: 1000 });
});
`);
  const rel = (f) => path.posix.normalize(`${configDir}/${f}`);
  return { dir, configPath: rel('playwright.config.ts'), specFile: rel('tests/broken.spec.ts') };
}

/** The page of the nested project: the inventory page has the button, every other path does not. */
export const inventoryServer = () => startServer((req) => (req.url.startsWith('/inventory')
  ? '<html><body><button id="add-to-cart-sauce-labs-backpack" data-test="add-to-cart-sauce-labs-backpack">Add to cart</button></body></html>'
  : '<html><body><h1>Login</h1></body></html>'));
