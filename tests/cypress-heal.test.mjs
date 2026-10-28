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
  path.join(repoRoot, 'node_modules', 'cypress'),
  '/tmp/cypress-cache/node_modules/cypress',
].find((dir) => fs.existsSync(dir));
const hasCypress = Boolean(cypressPkg);

const { classifyCypressFailure, cypressFrames } = await import(path.join(repoRoot, 'dist', 'adapters', 'cypress-js', 'classify.js'));
const { parseCypressCalls } = await import(path.join(repoRoot, 'dist', 'adapters', 'cypress-js', 'parse.js'));
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
  assert.match(calls[5].unsafe, /Custom commands/);
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

test('cypress eval cases heal or refuse as specified', { skip: hasCypress ? false : 'Cypress is not installed in the test cache', timeout: 300000 }, async () => {
  const cases = [
    {
      name: 'renamed text',
      html: '<!doctype html><html><body><button id="login">Login</button></body></html>',
      spec: "describe('login', () => {\n  it('renamed text', () => {\n    cy.visit('/');\n    cy.contains('button', 'Logn').click();\n  });\n});\n",
      expect: 'healed',
      match: /login/i,
    },
    {
      name: 'ambiguous match',
      html: '<!doctype html><html><body><button data-test="user-1">A</button><button data-test="user-2">B</button></body></html>',
      spec: "describe('login', () => {\n  it('ambiguous match', () => {\n    cy.visit('/');\n    cy.get('[data-test=\"user\"]').click();\n  });\n});\n",
      expect: 'refused',
      ambiguous: true,
    },
    {
      name: 'moved element',
      html: '<!doctype html><html><body><main><input id="username" data-test="username" /></main></body></html>',
      spec: "describe('login', () => {\n  it('moved element', () => {\n    cy.visit('/');\n    cy.get('#user-name').type('a');\n  });\n});\n",
      expect: 'healed',
      match: /username/,
    },
    {
      name: 'real defect',
      html: '<!doctype html><html><body><button id="stop">Stop</button></body></html>',
      spec: "describe('login', () => {\n  it('real defect', () => {\n    cy.visit('/');\n    cy.get('[data-test=\"checkout\"]').click();\n  });\n});\n",
      expect: 'refused',
    },
    {
      name: 'iframe',
      html: '<!doctype html><html><body><p>Login</p></body></html>',
      spec: "describe('login', () => {\n  it('iframe', () => {\n    cy.visit('/');\n    cy.get('iframe#login').should('exist');\n  });\n});\n",
      expect: 'refused',
      reason: /iframe/,
    },
  ];
  for (const item of cases) {
    const result = await healHtml(item.html, item.spec);
    assert.equal(result.status, 0, `${item.name}\n${result.stderr}\n${result.stdout}`);
    const payload = JSON.parse(result.stdout);
    const row = payload.locators.find((entry) => entry.old) ?? payload.locators[0];
    assert.ok(row, `${item.name} ${JSON.stringify(payload.locators)}`);
    assert.equal(row.status, item.expect, `${item.name} ${JSON.stringify(row)}`);
    if (item.match) assert.match(row.new ?? '', item.match, item.name);
    if (item.ambiguous) assert.equal(row.ambiguous, true, item.name);
    if (item.expect === 'refused') assert.equal(row.new, null, `${item.name} must not heal`);
    if (item.reason) assert.match(row.reason ?? '', item.reason, item.name);
    assert.equal(result.specAfter, result.specBefore, `${item.name} dry run changed the spec`);
  }
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
    assert.deepEqual(outcome.left, []);
  });
}

async function healHtml(html, spec) {
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
    const run = await runCli(['cypress/e2e/login.cy.js', '--dry-run', '--json'], dir);
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
    return { status, stdout, stderr, left: projectPids(dir) };
  } finally {
    if (child.exitCode === null && !child.killed) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function projectPids(dir) {
  const real = fs.realpathSync(dir);
  return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((name) => {
    if (Number(name) === process.pid) return false;
    const cmd = readCmd(name);
    if (/cypress|chrome|Xvfb|chromedriver/i.test(cmd) && cmd.includes(real)) return true;
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
    if (name === 'node_modules' || name === '.qa-core') continue;
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
