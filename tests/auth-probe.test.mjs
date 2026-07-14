import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Authenticated probing: --storage-state / auto-detection, redirect
 * awareness (requested vs landed URL, auth hint, expired-session message),
 * and never probing a login page as if it were the target.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { heal } = await import(path.join(repoRoot, 'dist', 'heal.js'));

const APP_HTML = '<html><body><h1>App</h1><label for="quantity">Quantity</label><input id="quantity" type="text" /></body></html>';
const LOGIN_HTML = '<html><body><h1>Log in</h1><label for="email">Email</label><input id="email" type="text" /></body></html>';

/** /app 302-redirects to /login unless the session cookie is present. */
function startAuthServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = (req.url ?? '/').split('?')[0];
      if (p === '/app') {
        if (!/session=valid-token/.test(req.headers.cookie ?? '')) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(APP_HTML);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(p === '/login' ? LOGIN_HTML : '<html><body><h1>Home</h1></body></html>');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function storageStateFile(dir, name, token) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({
    cookies: [{
      name: 'session', value: token, domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
    }],
    origins: [],
  }));
  return p;
}

function writeSpec(dir) {
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/app');
  await page.locator('#quantiy').fill('3');
});
`);
  return path.join(dir, 'tests/a.spec.ts');
}

async function withCapturedStderr(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { result: await fn(), stderr: lines.join('\n') };
  } finally {
    console.error = orig;
  }
}

test('unauthenticated probe of a protected page refuses with redirect + auth hint', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const spec = writeSpec(dir);
  try {
    const { result, stderr } = await withCapturedStderr(() => heal({
      specPaths: [spec], baseUrl: base, write: false,
      targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
    }));
    const loc = result.locators[0];
    assert.equal(loc.status, 'refused');
    assert.match(loc.reason, /redirected to \/login/);
    assert.match(stderr, /requested \/app, landed on \/login \(redirected\)/);
    assert.match(stderr, /the page may require authentication; pass --storage-state <path>/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a valid storage state authenticates the probe and the locator heals', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const spec = writeSpec(dir);
  const state = storageStateFile(dir, 'state.json', 'valid-token');
  try {
    const { result, stderr } = await withCapturedStderr(() => heal({
      specPaths: [spec], baseUrl: base, write: false, storageState: state,
      targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
    }));
    const loc = result.locators[0];
    assert.equal(loc.status, 'healed');
    assert.match(loc.new, /getByRole\("textbox"/);
    assert.doesNotMatch(stderr, /redirected/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an expired storage state reports the expired-session message', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const spec = writeSpec(dir);
  const state = storageStateFile(dir, 'expired.json', 'expired-token');
  try {
    const { result, stderr } = await withCapturedStderr(() => heal({
      specPaths: [spec], baseUrl: base, write: false, storageState: state,
      targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
    }));
    const loc = result.locators[0];
    assert.equal(loc.status, 'refused');
    assert.match(stderr, /storage state was applied but \/app still redirected to \/login; the saved session may be expired\. Re-generate it and retry\./);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a conventional .auth/state.json is auto-detected and announced', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  const spec = writeSpec(dir);
  fs.mkdirSync(path.join(dir, '.auth'));
  storageStateFile(dir, '.auth/state.json', 'valid-token');
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const { result, stderr } = await withCapturedStderr(() => heal({
      specPaths: [spec], baseUrl: base, write: false,
      targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
    }));
    const loc = result.locators[0];
    assert.equal(loc.status, 'healed');
    assert.match(stderr, /using storage state from .*\.auth[\/\\]state\.json/);
  } finally {
    process.chdir(prevCwd);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ladder-ambiguous refusals name their candidates (capped at 5)', async () => {
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><input id="alpha" /><input id="beta" /><input id="gamma" /></body></html>');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await page.locator('#user-widget').fill('3');
});
`);
  try {
    const result = await heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base,
      write: false,
    });
    const loc = result.locators[0];
    assert.equal(loc.status, 'refused');
    assert.match(loc.reason, /candidates: #alpha, #beta, #gamma/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
