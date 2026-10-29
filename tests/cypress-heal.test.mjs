import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');
const cypressPkg = [
  process.env.QA_CORE_HEAL_CYPRESS_PACKAGE,
  path.join(repoRoot, 'node_modules', 'cypress'),
].filter(Boolean).find((dir) => fs.existsSync(path.join(dir, 'package.json')));
const hasCypress = Boolean(cypressPkg);

const { classifyCypressFailure, cypressFrames } = await import(path.join(repoRoot, 'dist', 'adapters', 'cypress-js', 'classify.js'));
const { parseCypressCalls } = await import(path.join(repoRoot, 'dist', 'adapters', 'cypress-js', 'parse.js'));
const { listSpecTests } = await import(path.join(repoRoot, 'dist', 'adapters', 'cypress-js', 'list-tests.js'));
const { compareVersions } = await import(path.join(repoRoot, 'dist', 'adapters', 'cypress-js', 'version.js'));

test('version compare treats 15.10.0 as the minimum and 16.2.0 as the getByRole line', () => {
  assert.equal(compareVersions('15.10.0', '15.10.0'), 0);
  assert.equal(compareVersions('15.9.9', '15.10.0') < 0, true);
  assert.equal(compareVersions('16.2.1', '16.2.0') > 0, true);
});

test('classifier maps the confirmed Cypress error texts', () => {
  const missing = classifyCypressFailure('Timed out retrying after 2000ms: Expected to find element: `[data-test="usrname"]`, but never found it.');
  assert.equal(missing.kind, 'locator');
  assert.match(missing.selector, /data-test="usrname"/);
  const text = classifyCypressFailure("Expected to find content: 'Logn' within the selector: 'input' but never did.");
  assert.equal(text.kind, 'locator');
  assert.match(text.selector, /contains/);
  const role = classifyCypressFailure('Expected to find an accessible native element with the role "button" and name "Logn", but never did.');
  assert.equal(role.kind, 'locator');
  assert.match(role.selector, /getByRole/);
  const multi = classifyCypressFailure('CypressError: `cy.type()` can only be called on a single element. Your subject contained 3 elements.');
  assert.equal(multi.kind, 'locator');
  assert.equal(multi.strict, true);
  const assertion = classifyCypressFailure('expected true to equal false');
  assert.equal(assertion.kind, 'other');
});

test('webpack frames map to project files and other prefixes are unknown', () => {
  const frames = cypressFrames('at Context.eval (webpack://demo/./cypress/e2e/login.cy.js:3:40)');
  assert.equal(frames.unknownPrefix, false);
  assert.deepEqual(frames.frames, [{ file: 'cypress/e2e/login.cy.js', line: 3 }]);
  const other = cypressFrames('at foo (file:///tmp/login.cy.js:3:40)');
  assert.equal(other.unknownPrefix, true);
});

test('parser refuses within, custom commands, and skipped tests are not listed', () => {
  const source = [
    "cy.get('#login').within(() => { cy.get('#user').click(); });",
    "cy.getBySel('user');",
    "cy.login();",
    "it.skip('old', () => { cy.contains('Login'); });",
    "it('signs in', () => { cy.get('[data-test=\"usrname\"]').click(); });",
  ].join('\n');
  const calls = parseCypressCalls(source, 'cypress/e2e/login.cy.js');
  assert.ok(calls.some((call) => call.unsafe && /within/.test(call.unsafe)));
  assert.ok(calls.filter((call) => /within/.test(call.unsafe ?? '')).length >= 2);
  assert.ok(calls.some((call) => call.unsafe && /cy\.getBySel/.test(call.unsafe)));
  assert.ok(calls.some((call) => call.unsafe && /cy\.login/.test(call.unsafe)));
  const listed = listSpecTests(source);
  assert.equal(listed.find((item) => item.title === 'old')?.skip, true);
  assert.equal(listed.find((item) => item.title === 'signs in')?.skip, false);
});

test('a brace inside a string does not end the suite', () => {
  const source = "describe('login', () => {\n  it('a { b', () => {\n    const x = '{';\n  });\n  it('stays', () => {});\n});\n";
  const listed = listSpecTests(source);
  assert.deepEqual(listed.find((item) => item.title === 'stays')?.titlePath, ['login', 'stays']);
  assert.equal(listed.find((item) => item.title === 'a { b')?.titlePath[0], 'login');
});

test('a regexp that contains a quote does not hide the next test', () => {
  const source = "it('a', () => { /'/; });\nit('b', () => {});\n";
  const listed = listSpecTests(source);
  assert.deepEqual(listed.map((item) => item.title), ['a', 'b']);
});

test('a backslash and a newline inside a string still count the next line', () => {
  const source = "it('a\\\nb', () => {});\nit('c', () => {});\n";
  const listed = listSpecTests(source);
  assert.equal(listed.find((item) => item.title === 'ab')?.line, 1);
  assert.equal(listed.find((item) => item.title === 'c')?.line, 3);
});

test('documented Cypress commands are not treated as custom commands', () => {
  const src = ["cy.press('Enter')", "cy.now('get', '#a')", "cy.on('fail', () => {})", "cy.once('fail', () => {})", "cy.clearAllCookies()", "cy.getAllCookies()"].join('\n');
  const calls = parseCypressCalls(src, 'login.cy.js');
  assert.equal(calls.some((call) => /Custom command/.test(call.unsafe ?? '')), false);
});

test('confirmSameElement finishes when the page has JavaScript disabled', async () => {
  const { getAdapter } = await import(path.join(repoRoot, 'dist', 'adapters', 'index.js'));
  const cypressJs = getAdapter('cypress-js');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.setContent('<button id="login" data-test="login-button">Login</button><button id="cancel">Cancel</button>');
    const started = Date.now();
    const match = await cypressJs.confirmSameElement(page.locator('#login'), 'login');
    const miss = await cypressJs.confirmSameElement(page.locator('#cancel'), 'login-button');
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started}ms`);
    assert.equal(match.confirmed, true);
    assert.equal(miss.confirmed, false);
  } finally {
    await browser.close();
  }
});

test('confirmSameElement accepts the element that carries the token', async () => {
  const { getAdapter } = await import(path.join(repoRoot, 'dist', 'adapters', 'index.js'));
  const cypressJs = getAdapter('cypress-js');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="save">Save</button><button id="cancel">Cancel</button>');
    const same = await cypressJs.confirmSameElement(page.locator('#save'), 'Save');
    const other = await cypressJs.confirmSameElement(page.locator('#cancel'), 'Save');
    assert.equal(same.confirmed, true);
    assert.equal(other.confirmed, false);
  } finally {
    await browser.close();
  }
});

test('parser accepts literal cy.get and refuses templates, shadow, and custom commands', () => {
  const src = [
    "cy.get('[data-test=\"usrname\"]')",
    'cy.contains("input", "Logn")',
    "cy.getByRole('button', { name: 'Logn' })",
    'cy.get(`${name}`)',
    'cy.get(".box").shadow()',
    'cy.getBySel("user")',
  ].join('\n');
  const calls = parseCypressCalls(src, 'login.cy.js');
  assert.equal(calls[0].css, '[data-test="usrname"]');
  assert.equal(calls[0].unsafe, undefined);
  assert.equal(calls[1].kind, 'contains');
  assert.equal(calls[2].kind, 'getByRole');
  assert.match(calls[3].unsafe, /template/);
  assert.match(calls[4].unsafe, /shadow/);
  assert.match(calls[5].unsafe, /Custom command/);
});

test('a real Cypress run heals a test id typo and does not touch the project outside the spec', { skip: hasCypress ? false : 'Cypress is not installed in the test cache', timeout: 180000 }, async () => {
  const html = '<!doctype html><html><body><input data-test="username" /></body></html>';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-cy-'));
  const specRel = 'cypress/e2e/login.cy.js';
  const spec = `describe('login', () => {\n  it('signs in', () => {\n    cy.visit('/');\n    cy.get('[data-test="usrname"]').type('a');\n  });\n});\n`;
  try {
    fs.mkdirSync(path.join(dir, 'cypress/e2e'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'cypress/support'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(cypressPkg, path.join(dir, 'node_modules', 'cypress'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cy-fixture', private: true }));
    fs.writeFileSync(path.join(dir, 'cypress.config.js'), `const { defineConfig } = require('cypress');\nmodule.exports = defineConfig({\n  e2e: { baseUrl: '${base}', supportFile: 'cypress/support/e2e.js', specPattern: 'cypress/e2e/**/*.cy.js' },\n  video: false,\n});\n`);
    fs.writeFileSync(path.join(dir, 'cypress/support/e2e.js'), '');
    fs.writeFileSync(path.join(dir, specRel), spec);
    const before = new Set(walk(dir));
    const run = await runCli([specRel, '--dry-run', '--json'], dir);
    const after = new Set(walk(dir));
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    assert.equal(fs.existsSync(path.join(dir, '.qa-core')), false);
    assert.deepEqual([...after].sort(), [...before].sort());
    const payload = JSON.parse(run.stdout);
    const healed = payload.locators.find((item) => item.status === 'healed');
    assert.ok(healed, `${JSON.stringify(payload.locators)}\n${run.stderr}`);
    assert.match(healed.new, /data-test="username"/);
    assert.equal(fs.readFileSync(path.join(dir, specRel), 'utf8'), spec);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Cypress eval runner checks the fixture pages', { skip: hasCypress ? false : 'Cypress is not installed in the test cache', timeout: 300000 }, async () => {
  const { runCypressFixture } = await import(path.join(repoRoot, 'evals', 'run-cypress-evals.mjs'));
  const report = await runCypressFixture({ repoRoot, cli, cypressPkg });
  assert.deepEqual(report.failures, [], report.failures.join('\n'));
});

test('a skipped Cypress test is not a heal target, and an unknown title is refused', { skip: hasCypress ? false : 'Cypress is not installed in the test cache', timeout: 180000 }, async () => {
  const html = '<!doctype html><html><body><button id="login">Login</button><input data-test="username" /></body></html>';
  const spec = "describe('login', () => {\n  it.skip('old name', () => {\n    cy.contains('button', 'Login').click();\n  });\n  it('signs in', () => {\n    cy.visit('/');\n    cy.get('[data-test=\"usrname\"]').type('a');\n  });\n});\n";
  const result = await healHtml(html, spec);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const rows = payload.locators.filter((entry) => entry.old);
  assert.ok(rows.every((entry) => !/contains/.test(entry.old)), JSON.stringify(rows));
  assert.ok(rows.some((entry) => entry.status === 'healed' && /username/.test(entry.new ?? '')), JSON.stringify(rows));
  const missing = await healHtml(html, spec, ['--test', 'no such test']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /No test titled "no such test"/);
});

test('cy.contains and cy.getByRole pick the same element as the DOM rules', { skip: hasCypress ? false : 'Cypress is not installed in the test cache', timeout: 180000 }, async () => {
  const html = '<!doctype html><html><body><input id="user" data-test="username" /><button id="login">Login</button><button id="other">Logout</button></body></html>';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-cy-eq-'));
  const outFile = path.join(dir, 'eq.json');
  const spec = `describe('eq', () => {\n  it('counts', () => {\n    const found = {};\n    cy.visit('/');\n    cy.get('[data-test="username"]').its('length').then((n) => { found.get = n; });\n    cy.contains('button', /^\\s*Login\\s*$/).invoke('attr', 'id').then((id) => { found.contains = id; });\n    cy.getByRole('button', { name: 'Login' }).invoke('attr', 'id').then((id) => { found.role = id; });\n    cy.then(() => { cy.writeFile(${JSON.stringify(outFile)}, found); });\n  });\n});\n`;
  try {
    writeProject(dir, base, spec);
    const run = spawn(process.execPath, [
      path.join(cypressPkg, 'bin', 'cypress'), 'run', '--project', dir, '--spec', path.join(dir, 'cypress/e2e/login.cy.js'),
    ], { cwd: dir });
    let stderr = '';
    run.stderr.on('data', (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve) => run.on('close', resolve));
    assert.equal(status, 0, stderr);
    const found = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const { chromium } = await import('playwright');
    const { cypressMatchIds } = await import(path.join(repoRoot, 'dist', 'adapters', 'cypress-js', 'unique.js'));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      const css = await cypressMatchIds(page, { kind: 'css', selector: '[data-test="username"]' });
      const text = await cypressMatchIds(page, { kind: 'text', text: 'Login', selector: 'button' });
      const role = await cypressMatchIds(page, { kind: 'role', role: 'button', name: 'Login', exact: true });
      assert.equal(css.length, found.get);
      assert.deepEqual(text, [found.contains]);
      assert.deepEqual(role, [found.role]);
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hoisted Cypress install is found on dry-run and on a normal run', { skip: hasCypress ? false : 'Cypress is not installed in the test cache', timeout: 180000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-cy-hoist-'));
  const app = path.join(root, 'packages', 'app');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><input id="user" /></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.symlinkSync(cypressPkg, path.join(root, 'node_modules', 'cypress'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mono', private: true }));
    fs.mkdirSync(path.join(app, 'cypress/e2e'), { recursive: true });
    fs.mkdirSync(path.join(app, 'cypress/support'), { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', private: true }));
    fs.writeFileSync(path.join(app, 'cypress.config.js'), `const { defineConfig } = require('cypress');\nmodule.exports = defineConfig({ e2e: { baseUrl: '${base}', supportFile: 'cypress/support/e2e.js' }, video: false });\n`);
    fs.writeFileSync(path.join(app, 'cypress/support/e2e.js'), '');
    fs.writeFileSync(path.join(app, 'cypress/e2e/login.cy.js'), "describe('login', () => { it('shows the field', () => { cy.visit('/'); cy.get('#user').should('exist'); }); });\n");
    for (const args of [['--dry-run', '--json'], ['--yes', '--json']]) {
      const run = await new Promise((resolve) => {
        const child = spawn(process.execPath, [cli, 'cypress/e2e/login.cy.js', ...args], { cwd: app, env: process.env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
      assert.equal(run.status, 0, `${args.join(' ')}\n${run.stderr}\n${run.stdout}`);
      assert.doesNotMatch(`${run.stderr}\n${run.stdout}`, /no tests/i);
      assert.equal(fs.existsSync(path.join(app, '.qa-core')), false, args.join(' '));
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Cypress run timeout leaves no Cypress, browser, or Xvfb', { skip: hasCypress ? false : 'Cypress is not installed in the test cache', timeout: 180000 }, async () => {
  const outcome = await signalCase(null, ['--test', 'hangs', '--run-timeout', '25']);
  assert.equal(outcome.status, 1, outcome.stderr);
  assert.match(outcome.stderr, /timed out after 25 seconds/);
  assert.deepEqual(outcome.left, []);
});

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`Cypress ${sig} leaves no Cypress, browser, or Xvfb`, { skip: hasCypress ? false : 'Cypress is not installed in the test cache', timeout: 180000 }, async () => {
    const outcome = await signalCase(sig, []);
    assert.equal(outcome.status, code, `${outcome.stderr}\n${outcome.stdout}`);
    assert.equal(outcome.treeSame, true, (outcome.after ?? []).join('\n'));
    assert.deepEqual(outcome.left, []);
  });
}

async function healHtml(html, spec, extra = []) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-cy-'));
  try {
    writeProject(dir, base, spec);
    const specPath = path.join(dir, 'cypress/e2e/login.cy.js');
    const specBefore = fs.readFileSync(specPath, 'utf8');
    const run = await runCli(['cypress/e2e/login.cy.js', ...extra, '--dry-run', '--json'], dir);
    return { ...run, specBefore, specAfter: fs.readFileSync(specPath, 'utf8') };
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeProject(dir, base, spec) {
  fs.mkdirSync(path.join(dir, 'cypress/e2e'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cypress/support'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.symlinkSync(cypressPkg, path.join(dir, 'node_modules', 'cypress'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cy-fixture', private: true }));
  fs.writeFileSync(path.join(dir, 'cypress.config.js'), `const { defineConfig } = require('cypress');\nmodule.exports = defineConfig({\n  e2e: { baseUrl: '${base}', supportFile: 'cypress/support/e2e.js', specPattern: 'cypress/e2e/**/*.cy.js' },\n  video: false,\n});\n`);
  fs.writeFileSync(path.join(dir, 'cypress/support/e2e.js'), '');
  fs.writeFileSync(path.join(dir, 'cypress/e2e/login.cy.js'), spec);
}

async function signalCase(sig, extra) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><input id="user" /></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-cy-sig-'));
  const spec = "describe('login', () => {\n  it('hangs', () => {\n    cy.visit('/');\n    cy.wait(120000);\n  });\n});\n";
  writeProject(dir, base, spec);
  const before = projectTree(dir);
  const child = spawn(process.execPath, [cli, 'cypress/e2e/login.cy.js', ...extra], { cwd: dir });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.on('close', (status) => resolve(status)));
  try {
    if (sig) {
      await waitFor(() => projectPids(dir).some((pid) => Number(pid) !== child.pid), 'Cypress to start');
      process.kill(child.pid, sig);
    }
    const status = await closed;
    await new Promise((resolve) => setTimeout(resolve, 800));
    const after = projectTree(dir);
    return { status, stdout, stderr, left: projectPids(dir), treeSame: before.join('\n') === after.join('\n'), after };
  } finally {
    if (child.exitCode === null && !child.killed) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function projectTree(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const rel = path.relative(dir, full);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || st.isFile()) out.push(rel);
      else if (st.isDirectory()) { out.push(`${rel}/`); walk(full); }
    }
  };
  walk(dir);
  return out.sort();
}

function projectPids(dir) {
  if (!fs.existsSync('/proc')) return [];
  const real = fs.realpathSync(dir);
  return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((name) => {
    if (Number(name) === process.pid) return false;
    const cmd = readCmd(name);
    if (!/Cypress|chrome|Xvfb/i.test(cmd) || cmd.includes(`${path.sep}dist${path.sep}cli.js`)) return false;
    if (cmd.includes(real)) return true;
    try { return fs.readlinkSync(`/proc/${name}/cwd`).startsWith(real); } catch { return false; }
  });
}

function readCmd(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { return ''; }
}

async function waitFor(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 90000) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file, out);
    else out.push(path.relative(dir, file));
  }
  return out;
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
