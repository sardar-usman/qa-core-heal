import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Publish blockers 2 and 3: importing the user's playwright.config.ts must
 * not leak Node warnings into the CLI output, and the TypeScript-config
 * path must be gated on Node >= 22.6 with an actionable message — while
 * .js configs and explicit flags keep working on older Node.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const { supportsTypeStripping, needsStripFlag, typeStrippingGateMessage, resolvePlaywrightConfig } = await import(
  path.join(repoRoot, 'dist', 'playwright-config.js')
);

function tempProject(files) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('supportsTypeStripping follows the Node 22.6 line', () => {
  assert.equal(supportsTypeStripping('20.11.1'), false);
  assert.equal(supportsTypeStripping('22.5.0'), false);
  assert.equal(supportsTypeStripping('22.6.0'), true);
  assert.equal(supportsTypeStripping('22.18.0'), true);
  assert.equal(supportsTypeStripping('23.9.0'), true);
  assert.equal(supportsTypeStripping('24.0.0'), true);
});

test('the strip-types flag is only passed where it is experimental-but-flagged', () => {
  assert.equal(needsStripFlag('22.6.0'), true);   // flagged era
  assert.equal(needsStripFlag('22.17.0'), true);
  assert.equal(needsStripFlag('22.18.0'), false); // default-on backport
  assert.equal(needsStripFlag('23.5.0'), true);
  assert.equal(needsStripFlag('23.9.0'), false);  // default-on
  assert.equal(needsStripFlag('24.0.0'), false);
});

test('the gate message is exactly the published wording', () => {
  assert.equal(
    typeStrippingGateMessage('18.20.0'),
    'qa-core-heal requires Node 22.6+ to read TypeScript configs. Detected v18.20.0. '
    + 'Workaround: pass --base-url and --route flags.',
  );
});

test('an ESM config calling require("dotenv").config() loads and self-loads its env', async () => {
  // Byte-for-byte the second-repo pattern: ESM imports, CJS require for
  // dotenv, conditional reporters, top-level use.baseURL from env.
  const dir = tempProject({
    '.env': 'BASE_URL=https://from-dotenv.example\n',
    'playwright.config.ts': `import { defineConfig, devices } from '@playwright/test';
require('dotenv').config();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://staging.example.com',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.loadError, undefined);
    assert.equal(res.baseUrl, 'https://from-dotenv.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the exact real-repo config loads in a package with NO "type" field', async () => {
  // The regression: with no "type" in package.json, Node treats a .ts file
  // as CommonJS after type stripping, and its import statements throw
  // "Cannot use import statement outside a module". The earlier fixture
  // missed this because it had no package.json at all and inherited
  // "type": "module" from this repo's root.
  const dir = tempProject({
    'package.json': '{ "name": "nextjs-admin", "private": true }',
    '.env': 'BASE_URL=https://typeless-repo.example\n',
    'playwright.config.ts': `import { defineConfig, devices } from '@playwright/test';
require('dotenv').config();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html'], ['github']] : [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://staging.example.com',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.loadError, undefined);
    assert.equal(res.baseUrl, 'https://typeless-repo.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ESM-syntax .ts config loads even when the package context is CommonJS', async () => {
  // Deterministic form of the same regression: with "type": "commonjs"
  // (or a typeless package on Nodes whose syntax detection skips .ts),
  // import() evaluates the stripped file as CJS and throws "Cannot use
  // import statement outside a module". The loader must retry as ESM.
  const dir = tempProject({
    'package.json': '{ "name": "cjs-context", "private": true, "type": "commonjs" }',
    '.env': 'BASE_URL=https://cjs-context.example\n',
    'playwright.config.ts': `import { defineConfig, devices } from '@playwright/test';
require('dotenv').config();

export default defineConfig({
  reporter: process.env.CI ? [['html'], ['github']] : [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'https://staging.example.com',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.loadError, undefined);
    assert.equal(res.baseUrl, 'https://cjs-context.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a type-only NAMED import (no `import type`) survives the ESM retry', async () => {
  // ReporterDescription is a TypeScript type imported as a plain named
  // import. Type stripping keeps the specifier, so the stripped module
  // requests an export that does not exist at runtime. The retry must
  // rewrite named imports to namespace + destructuring, where a missing
  // export is undefined instead of a crash.
  const dir = tempProject({
    'package.json': '{ "name": "reporter-desc", "private": true, "type": "commonjs" }',
    '.env': 'BASE_URL=https://reporter-desc.example\n',
    'playwright.config.ts': `import { defineConfig, devices, ReporterDescription } from '@playwright/test';
require('dotenv').config();

const reporters: ReporterDescription[] = process.env.CI ? [['html'], ['github']] : [['list']];

export default defineConfig({
  testDir: './tests',
  reporter: reporters,
  use: {
    baseURL: process.env.BASE_URL || 'https://staging.example.com',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.loadError, undefined);
    assert.equal(res.baseUrl, 'https://reporter-desc.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('when both load attempts fail, the diagnostic reports both errors', async () => {
  const dir = tempProject({
    'package.json': '{ "name": "broken-config", "private": true }',
    // ESM syntax present, so the CJS fallback is not allowed — and the
    // import itself throws at evaluation time.
    'playwright.config.ts': `import { defineConfig } from '@playwright/test';
throw new Error('boom in typeless package');
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.baseUrl, null);
    assert.match(res.loadError, /boom in typeless package/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pure-CJS config (module.exports) loads via require, not import', async () => {
  const dir = tempProject({
    // No "type": "module": a plain .js config here is genuine CommonJS.
    'package.json': '{ "name": "cjs-config", "private": true }',
    'playwright.config.js': `const base = 'https://cjs.example';
module.exports = { use: { baseURL: base } };
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.loadError, undefined);
    assert.equal(res.baseUrl, 'https://cjs.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing config reports a load FAILURE, never absence', async () => {
  const dir = tempProject({
    'playwright.config.ts': `throw new Error('boom at config load');
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.baseUrl, null);
    assert.match(res.loadError, /boom at config load/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI prints the load-failure warning and still falls back to the goto scan', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Inventory</h1></body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = tempProject({
    'playwright.config.ts': 'throw new Error(\'boom at config load\');\n',
  });
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto(${JSON.stringify(base + '/')});
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
});
`);
  try {
    const { status, stderr } = await new Promise((resolve) => {
      const child = spawn('node', [cliJs, 'tests/a.spec.ts', '--scan', '--dry-run'], { cwd: dir });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stderr: err }));
    });
    // The absolute goto() rescues the run; the warning names the real cause.
    assert.equal(status, 0);
    assert.match(stderr, /playwright\.config\.ts failed to load \(.*boom at config load.*\); falling back to goto\(\) scan \/ --base-url/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('use.storageState is extracted from the config and resolved to an absolute path', async () => {
  const dir = tempProject({
    'playwright.config.ts': `import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: { baseURL: 'https://state.example', storageState: '.auth/user.json' },
});
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.baseUrl, 'https://state.example');
    assert.equal(res.storageState, path.join(dir, '.auth/user.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('disagreeing project baseURLs resolve only through --project', async () => {
  const dir = tempProject({
    'playwright.config.ts': `import { defineConfig } from '@playwright/test';
export default defineConfig({
  projects: [
    { name: 'alpha', use: { baseURL: 'https://alpha.example' } },
    { name: 'beta', use: { baseURL: 'https://beta.example' } },
  ],
});
`,
  });
  try {
    const bare = await resolvePlaywrightConfig(dir);
    assert.equal(bare.baseUrl, null);
    assert.equal(bare.disagreement.length, 2);
    const beta = await resolvePlaywrightConfig(dir, 'beta');
    assert.equal(beta.baseUrl, 'https://beta.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.env values never override env vars that are already set', async () => {
  process.env.QA_HEAL_ENV_PRECEDENCE = 'https://from-parent.example';
  const dir = tempProject({
    '.env': 'QA_HEAL_ENV_PRECEDENCE=https://from-dotenv.example\n',
    'playwright.config.ts': `import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: { baseURL: process.env.QA_HEAL_ENV_PRECEDENCE },
});
`,
  });
  try {
    const res = await resolvePlaywrightConfig(dir);
    assert.equal(res.baseUrl, 'https://from-parent.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.QA_HEAL_ENV_PRECEDENCE;
  }
});

test('CLI output is clean of Node warnings when reading a TypeScript config', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><h1>Inventory</h1></body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  // package.json WITHOUT "type" on purpose: the typeless-package warning
  // (MODULE_TYPELESS_PACKAGE_JSON) must not surface either.
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "warning-repro", "private": true }');
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({ use: { baseURL: ${JSON.stringify(base)} } });
`);
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
});
`);
  try {
    const { status, stdout, stderr } = await new Promise((resolve) => {
      const child = spawn('node', [cliJs, 'tests/a.spec.ts', '--scan', '--dry-run'], { cwd: dir });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ status: code, stdout: out, stderr: err }));
    });
    assert.equal(status, 0);
    // The base URL really came from the TS config (no --base-url passed).
    assert.match(stdout, /1 intact/);
    for (const noise of ['ExperimentalWarning', 'Type Stripping', 'MODULE_TYPELESS_PACKAGE_JSON', 'Reparsing as ES module']) {
      assert.ok(!stderr.includes(noise), `stderr must not contain "${noise}", got:\n${stderr}`);
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
