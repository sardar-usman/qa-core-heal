import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * --auth-setup: probe after running the user's OWN login function against
 * a fresh page in the probing context. Loaded with the same TS machinery
 * as the config loader (require shim, ESM retry); failures and timeouts
 * are loud — never a silent unauthenticated probe.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { heal } = await import(path.join(repoRoot, 'dist', 'heal.js'));
const { loadAuthSetup } = await import(path.join(repoRoot, 'dist', 'auth-setup.js'));

const APP_HTML = '<html><body><h1>App</h1><label for="quantity">Quantity</label><input id="quantity" type="text" /></body></html>';
const LOGIN_HTML = '<html><body><h1>Log in</h1><label for="email">Email</label><input id="email" type="text" /></body></html>';

/** /app is cookie-gated; POST /api/login with the right body grants it. */
function startAuthServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = (req.url ?? '/').split('?')[0];
      if (p === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          if (body.includes('admin') && body.includes('secret')) {
            res.writeHead(200, {
              'set-cookie': 'session=valid-token; Path=/',
              'content-type': 'application/json',
            });
            res.end('{"ok":true}');
          } else {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end('{"ok":false}');
          }
        });
        return;
      }
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

function writeProject(base) {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'utils'));
  fs.writeFileSync(path.join(dir, 'tests/a.spec.ts'), `import { test } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/app');
  await page.locator('#quantiy').fill('3');
});
`);
  // RELATIVE navigation on purpose: login helpers written for Playwright
  // test contexts rely on use.baseURL; the probing context must carry the
  // resolved base URL too.
  fs.writeFileSync(path.join(dir, 'utils/login.ts'), `import { type Page } from '@playwright/test';
export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.request.post('/api/login', {
    data: { user: 'admin', pass: 'secret' },
  });
}
export default login;
`);
  return dir;
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

test('loadAuthSetup parses file#export, defaults to the default export', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(base);
  try {
    const named = await loadAuthSetup('utils/login.ts#login', dir);
    assert.equal(typeof named.fn, 'function');
    assert.equal(named.label, 'utils/login.ts#login');
    const dflt = await loadAuthSetup('utils/login.ts', dir);
    assert.equal(typeof dflt.fn, 'function');
    await assert.rejects(() => loadAuthSetup('utils/login.ts#nope', dir), /"nope" is not a function/);
    await assert.rejects(() => loadAuthSetup('utils/missing.ts', dir), /not found/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAuthSetup survives a CommonJS package context via the ESM retry', async () => {
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "cjs-auth", "private": true, "type": "commonjs" }');
  fs.writeFileSync(path.join(dir, 'login.ts'), `import { type Page } from '@playwright/test';
export async function login(page: Page): Promise<void> { /* no-op */ }
`);
  try {
    const loaded = await loadAuthSetup('login.ts#login', dir);
    assert.equal(typeof loaded.fn, 'function');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a working auth setup (RELATIVE navigation) logs in and the locator heals, warning-free', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(base);
  // Capture the REAL stderr stream too: Node warnings (Type Stripping,
  // module-type reparse) bypass console.error.
  let rawStderr = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    rawStderr += String(chunk);
    return origWrite(chunk, ...rest);
  };
  try {
    const { result, stderr } = await withCapturedStderr(() => heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base, write: false,
      authSetup: path.join(dir, 'utils/login.ts') + '#login',
      targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
    }));
    const loc = result.locators[0];
    assert.equal(loc.status, 'healed');
    assert.match(loc.new, /getByRole\("textbox"/);
    assert.match(stderr, /auth setup .*login\.ts#login succeeded/);
    // Security: no cookie values or credentials in output.
    assert.doesNotMatch(stderr, /valid-token|secret/);
    // The in-process module load must not leak Node warnings.
    for (const noise of ['ExperimentalWarning', 'Type Stripping', 'stripTypeScriptTypes', 'To load an ES module', 'MODULE_TYPELESS_PACKAGE_JSON']) {
      assert.ok(!rawStderr.includes(noise), `stderr must not contain "${noise}", got:\n${rawStderr}`);
    }
  } finally {
    process.stderr.write = origWrite;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing auth setup fails LOUDLY and nothing is probed', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(base);
  fs.writeFileSync(path.join(dir, 'utils/broken.ts'), `export async function login(): Promise<void> {
  throw new Error('bad credentials');
}
`);
  try {
    await assert.rejects(
      () => heal({
        specPaths: [path.join(dir, 'tests/a.spec.ts')],
        baseUrl: base, write: false,
        authSetup: path.join(dir, 'utils/broken.ts') + '#login',
        targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
      }),
      /auth setup .*broken\.ts#login failed: bad credentials/,
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hanging auth setup times out with a loud failure', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(base);
  fs.writeFileSync(path.join(dir, 'utils/hang.ts'), `export async function login(): Promise<void> {
  await new Promise(() => undefined);
}
`);
  try {
    await assert.rejects(
      () => heal({
        specPaths: [path.join(dir, 'tests/a.spec.ts')],
        baseUrl: base, write: false,
        authSetup: path.join(dir, 'utils/hang.ts') + '#login',
        authSetupTimeout: 500,
        targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
      }),
      /auth setup .*hang\.ts#login failed: timed out after 500ms/,
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an auth setup that never authenticates gets the redirect-after-auth message', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(base);
  fs.writeFileSync(path.join(dir, 'utils/noop.ts'), `export async function login(): Promise<void> { /* visits nothing */ }
`);
  try {
    const { result, stderr } = await withCapturedStderr(() => heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base, write: false,
      authSetup: path.join(dir, 'utils/noop.ts') + '#login',
      targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
    }));
    assert.equal(result.locators[0].status, 'refused');
    assert.match(stderr, /auth setup ran but \/app still redirected to \/login; the login function may have failed silently or the session did not persist/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 0.2.1 ITEM 4: a saved session is used FIRST (fast, side-effect free);
// when it turns out expired (redirect to a login-looking route) and an
// auth setup is configured, the probe retries via the login function.
// Never the reverse: a failing auth setup never falls back to a session.
test('an expired storage state falls back to the configured auth setup and heals', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(base);
  const statePath = path.join(dir, 'expired.json');
  fs.writeFileSync(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'expired-token', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [],
  }));
  try {
    const { result, stderr } = await withCapturedStderr(() => heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base, write: false,
      storageState: statePath,
      authSetup: path.join(dir, 'utils/login.ts') + '#login',
      targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
    }));
    assert.equal(result.locators[0].status, 'healed');
    assert.match(stderr, /saved session expired; falling back to auth setup/);
    assert.match(stderr, /auth setup .*login\.ts#login succeeded/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a VALID storage state wins: the auth setup never runs', async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(base);
  const statePath = path.join(dir, 'valid.json');
  fs.writeFileSync(statePath, JSON.stringify({
    cookies: [{ name: 'session', value: 'valid-token', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [],
  }));
  // A login that would fail loudly if it ever ran: proves it did not.
  fs.writeFileSync(path.join(dir, 'utils/tripwire.ts'), `export async function login(): Promise<void> {
  throw new Error('tripwire: auth setup ran despite a valid session');
}
`);
  try {
    const { result, stderr } = await withCapturedStderr(() => heal({
      specPaths: [path.join(dir, 'tests/a.spec.ts')],
      baseUrl: base, write: false,
      storageState: statePath,
      authSetup: path.join(dir, 'utils/tripwire.ts') + '#login',
      targets: [{ selector: "locator('#quantiy')", url: `${base}/app`, test: 'x' }],
    }));
    assert.equal(result.locators[0].status, 'healed');
    assert.doesNotMatch(stderr, /tripwire|falling back/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 0.2.1 ITEM 6a: the warning filter's coverage window. The earlier fixture
// inherited this repo's "type": "module" and hid the real-repo leak: in a
// repo-shaped package the .ts auth module goes through the ESM-retry
// hook, whose warnings (stripTypeScriptTypes, the ES-module hint) surface
// off the main thread and bypassed the emitWarning filter. Each shape runs
// in a FRESH child process — module.register persists per process and
// Node de-dupes warnings, so an in-process assertion would pass vacuously.
test('repo-shaped packages (typeless and commonjs) leak no Node warnings', () => {
  for (const pkg of [
    '{ "name": "repo-shaped", "private": true }',
    '{ "name": "repo-shaped", "private": true, "type": "commonjs" }',
  ]) {
    const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), pkg);
      fs.writeFileSync(path.join(dir, 'login.ts'), `import { type Page } from '@playwright/test';
export async function login(page: Page): Promise<void> { /* no-op */ }
`);
      fs.writeFileSync(path.join(dir, 'runner.mjs'), `
import path from 'node:path';
const { loadAuthSetup } = await import(${JSON.stringify(path.join(repoRoot, 'dist', 'auth-setup.js'))});
const loaded = await loadAuthSetup('login.ts#login', ${JSON.stringify(dir)});
await loaded.fn(null);
await new Promise((r) => setTimeout(r, 300));
`);
      const run = spawnSync(process.execPath, [path.join(dir, 'runner.mjs')], { encoding: 'utf8' });
      assert.equal(run.status, 0, `runner failed for ${pkg}: ${run.stderr}`);
      for (const noise of ['ExperimentalWarning', 'Type Stripping', 'stripTypeScriptTypes', 'To load an ES module', 'MODULE_TYPELESS_PACKAGE_JSON']) {
        assert.ok(!run.stderr.includes(noise), `stderr must not contain "${noise}" for ${pkg}, got:\n${run.stderr}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// 0.2.1 ITEM 6b: ':' as an alternative export separator (zsh-friendly),
// and a quoting hint when a '#' value points at a missing file.
test("':' works as the export separator; '#' misses suggest quoting", async () => {
  const server = await startAuthServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = writeProject(base);
  try {
    const viaColon = await loadAuthSetup('utils/login.ts:login', dir);
    assert.equal(typeof viaColon.fn, 'function');
    assert.equal(viaColon.label, 'utils/login.ts#login');
    // A bare path with no separator still means the default export.
    const bare = await loadAuthSetup('utils/login.ts', dir);
    assert.equal(typeof bare.fn, 'function');
    await assert.rejects(
      () => loadAuthSetup('utils/missing.ts#login', dir),
      /not found[\s\S]*quote/i,
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
