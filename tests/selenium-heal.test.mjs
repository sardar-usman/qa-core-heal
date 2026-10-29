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
const live = process.env.QA_CORE_HEAL_SELENIUM === '1';
function dependencyDir(name) {
  const roots = [process.env.QA_CORE_HEAL_NODE_MODULES, path.join(repoRoot, 'node_modules')].filter(Boolean);
  return roots.map((root) => path.join(root, name)).find((dir) => fs.existsSync(dir));
}
const seleniumRoot = dependencyDir('selenium-webdriver');
const mochaRoot = dependencyDir('mocha');
const canRun = live && Boolean(seleniumRoot) && Boolean(mochaRoot);

const { classifySeleniumFailure, byFromSentSelector } = await import(path.join(repoRoot, 'dist', 'adapters', 'selenium-js', 'classify.js'));
const { parseSeleniumCalls, hasRemoteSession } = await import(path.join(repoRoot, 'dist', 'adapters', 'selenium-js', 'parse.js'));
const { compareVersions } = await import(path.join(repoRoot, 'dist', 'adapters', 'selenium-js', 'version.js'));
const { seleniumMatchIds } = await import(path.join(repoRoot, 'dist', 'adapters', 'selenium-js', 'unique.js'));
const { grepPatternFor } = await import(path.join(repoRoot, 'dist', 'adapters', 'selenium-js', 'list-tests.js'));

test('Mocha fgrep is the full title', () => {
  const source = "describe('login', () => {\n  it('logs in', async () => {});\n  it('hangs', async () => {});\n});\n";
  assert.equal(grepPatternFor(source, 'logs in'), 'login logs in');
  assert.equal(grepPatternFor(source, 'hangs'), 'login hangs');
  assert.equal(grepPatternFor("it('logs in', () => {});", 'logs in'), 'logs in');
});

test('version compare treats 4.6.0 and 10.0.0 as the minimums', () => {
  assert.equal(compareVersions('4.6.0', '4.6.0'), 0);
  assert.equal(compareVersions('4.5.9', '4.6.0') < 0, true);
  assert.equal(compareVersions('10.0.0', '10.0.0'), 0);
  assert.equal(compareVersions('9.9.0', '10.0.0') < 0, true);
});

test('classifier maps NoSuchElementError and wait TimeoutError', () => {
  const missing = classifySeleniumFailure('NoSuchElementError: no such element: Unable to locate element: {"method":"css selector","selector":"*[id="user-nme"]"}');
  assert.equal(missing.kind, 'locator');
  assert.equal(missing.selector, "By.id('user-nme')");
  const name = byFromSentSelector('css selector', '*[name="user"]');
  assert.equal(name, "By.name('user')");
  const waited = classifySeleniumFailure('TimeoutError: Waiting for element to be located By(css selector, [data-test="usrname"])\nWait timed out after 1000ms');
  assert.equal(waited.kind, 'locator');
  assert.match(waited.selector, /data-test="usrname"/);
  const assertion = classifySeleniumFailure('AssertionError: expected true to equal false');
  assert.equal(assertion.kind, 'other');
});

test('parser accepts literal By calls and refuses js, objects, and variables', () => {
  const source = [
    "await driver.findElement(By.css('[data-test=\"usrname\"]'));",
    "await driver.findElement(By.id('login-button'));",
    "await driver.wait(until.elementLocated(By.name('user')), 1000);",
    "const LOGIN = By.linkText('Login');",
    "await driver.findElement(By.js('return document.body'));",
    "await driver.findElement(By.css(selector));",
    "await driver.findElement({ css: '#a' });",
  ].join('\n');
  const calls = parseSeleniumCalls(source, 'test/login.test.js');
  assert.equal(calls.filter((call) => call.strategy === 'css').length, 1);
  assert.ok(calls.some((call) => call.unsafe && /By\.js/.test(call.unsafe)));
  assert.ok(calls.some((call) => call.unsafe && /string literal/.test(call.unsafe)));
  assert.ok(calls.some((call) => call.unsafe && /Object locators/.test(call.unsafe)));
  assert.equal(hasRemoteSession("new Builder().usingServer(process.env.GRID).build()"), true);
});

test('link text and xpath counts follow the DOM rules', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<a id="login" href="/">Login</a><a id="other" href="/x">Logout</a><div id="box"></div>');
    const links = await seleniumMatchIds(page, { kind: 'text', text: 'Login', exact: true });
    assert.deepEqual(links, ['login']);
    const xpath = await seleniumMatchIds(page, { kind: 'xpath', expression: '//*[@id="box"]' });
    assert.deepEqual(xpath, ['box']);
    const css = await seleniumMatchIds(page, { kind: 'css', selector: 'a' });
    assert.equal(css.length, 2);
  } finally {
    await browser.close();
  }
});

test('a Selenium test id typo heals from the captured page', { skip: canRun ? false : 'set QA_CORE_HEAL_SELENIUM=1 with selenium-webdriver and mocha installed', timeout: 180000 }, async () => {
  const html = '<!doctype html><html><body><input id="user-name" data-test="username" /></body></html>';
  const result = await healHtml(html, loginSpec('await driver.findElement(By.css(\'[data-test="usrname"]\')).click();'));
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  const row = payload.locators.find((entry) => entry.old);
  assert.ok(row, JSON.stringify(payload));
  assert.equal(row.status, 'healed', JSON.stringify(row));
  assert.match(row.new, /username/);
  assert.equal(result.specAfter, result.specBefore);
  assert.equal(result.qaCoreLeft, false);
});

test('selenium eval cases heal or refuse as specified', { skip: canRun ? false : 'set QA_CORE_HEAL_SELENIUM=1 with selenium-webdriver and mocha installed', timeout: 300000 }, async () => {
  const { runSeleniumFixture } = await import(path.join(repoRoot, 'evals', 'run-selenium-evals.mjs'));
  const failures = await runSeleniumFixture({
    repoRoot,
    cli,
    seleniumPkg: seleniumRoot,
    mochaPkg: mochaRoot,
    chrome: chromeBinary(),
  });
  assert.deepEqual(failures, []);
});

test('findElements length matches the DOM count', { skip: canRun ? false : 'set QA_CORE_HEAL_SELENIUM=1 with selenium-webdriver and mocha installed', timeout: 180000 }, async () => {
  const html = '<!doctype html><html><body><a id="login" href="/">Login</a><input id="user" data-test="username" /></body></html>';
  const server = await listen(html);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-se-eq-'));
  const outFile = path.join(dir, 'eq.json');
  const body = `const found = { css: (await driver.findElements(By.css('[data-test="username"]'))).length, link: (await driver.findElements(By.linkText('Login'))).length };\n    require('node:fs').writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(found));`;
  try {
    writeProject(dir, server.base, loginSpec(body, true));
    const run = await runMocha(dir);
    assert.equal(run.status, 0, run.stderr);
    const found = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html);
      const css = await seleniumMatchIds(page, { kind: 'css', selector: '[data-test="username"]' });
      const link = await seleniumMatchIds(page, { kind: 'text', text: 'Login', exact: true });
      assert.equal(css.length, found.css);
      assert.equal(link.length, found.link);
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Selenium run timeout leaves no chromedriver or Chrome', { skip: canRun ? false : 'set QA_CORE_HEAL_SELENIUM=1 with selenium-webdriver and mocha installed', timeout: 180000 }, async () => {
  const outcome = await signalCase(null, ['--test', 'hangs', '--run-timeout', '25']);
  assert.equal(outcome.status, 1, outcome.stderr);
  assert.match(outcome.stderr, /timed out after 25 seconds/);
  assert.deepEqual(outcome.left, []);
});

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`Selenium ${sig} leaves no chromedriver or Chrome`, { skip: canRun ? false : 'set QA_CORE_HEAL_SELENIUM=1 with selenium-webdriver and mocha installed', timeout: 180000 }, async () => {
    const outcome = await signalCase(sig, []);
    assert.equal(outcome.status, code, `${outcome.stderr}\n${outcome.stdout}`);
    assert.deepEqual(outcome.left, []);
  });
}

function chromeBinary() {
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(root)) return '';
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name, 'chrome-linux64', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function loginSpec(body, pass = false) {
  return `const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
describe('login', () => {
  let driver;
  beforeEach(async () => {
    const options = new chrome.Options();
    const binary = process.env.QA_CORE_HEAL_CHROME;
    if (binary) options.setChromeBinaryPath(binary);
    options.addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage');
    driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  });
  afterEach(async () => { if (driver) await driver.quit(); });
  it('${pass ? 'counts' : 'logs in'}', async () => {
    await driver.get(process.env.QA_CORE_HEAL_PAGE);
    ${body}
  });
  it('hangs', async () => {
    await driver.get(process.env.QA_CORE_HEAL_PAGE);
    await driver.sleep(120000);
  });
});
`;
}

async function healHtml(html, spec) {
  const server = await listen(html);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-se-'));
  try {
    writeProject(dir, server.base, spec);
    const specPath = path.join(dir, 'test', 'login.test.js');
    const specBefore = fs.readFileSync(specPath, 'utf8');
    const run = await runCli(['test/login.test.js', '--test', 'logs in', '--dry-run', '--json'], dir);
    return {
      ...run,
      specBefore,
      specAfter: fs.readFileSync(specPath, 'utf8'),
      otherRan: fs.existsSync(path.join(dir, 'other-ran')),
      qaCoreLeft: fs.existsSync(path.join(dir, '.qa-core')),
    };
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeProject(dir, base, spec) {
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.symlinkSync(seleniumRoot, path.join(dir, 'node_modules', 'selenium-webdriver'));
  fs.symlinkSync(mochaRoot, path.join(dir, 'node_modules', 'mocha'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'se-fixture',
    private: true,
    type: 'commonjs',
    devDependencies: { 'selenium-webdriver': '4.51.0', mocha: '12.0.3' },
  }));
  fs.writeFileSync(path.join(dir, '.mocharc.json'), JSON.stringify({ spec: ['test/other.test.js', 'test/login.test.js'], timeout: 20000 }));
  const mark = path.join(dir, 'other-ran');
  fs.writeFileSync(path.join(dir, 'test', 'other.test.js'), "const fs = require('node:fs');\ndescribe('other', () => { it('other test', () => { fs.writeFileSync(process.env.QA_CORE_HEAL_MARK, 'yes'); }); });\n");
  fs.writeFileSync(path.join(dir, 'test', 'login.test.js'), spec);
  process.env.QA_CORE_HEAL_PAGE = base;
  process.env.QA_CORE_HEAL_CHROME = chromeBinary();
  process.env.QA_CORE_HEAL_MARK = mark;
}

function listen(html) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function runMocha(dir) {
  return runCli(['test/login.test.js', '--test', 'counts', '--dry-run'], dir);
}

async function signalCase(sig, extra) {
  const server = await listen('<!doctype html><html><body><input id="user" /></body></html>');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-se-sig-'));
  writeProject(dir, server.base, loginSpec('await driver.findElement(By.id("missing")).click();'));
  const before = new Set(browserPids());
  const child = spawn(process.execPath, [cli, 'test/login.test.js', ...extra], { cwd: dir, env: process.env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.on('close', (status) => resolve(status)));
  try {
    if (sig) {
      await waitFor(() => browserPids().some((pid) => !before.has(pid)), 'Chrome to start');
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

function browserPids() {
  return fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((name) => {
    if (Number(name) === process.pid) return false;
    const cmd = readCmd(name);
    return /chromedriver|(?:^|[/\\])chrome(?:\s|$)/i.test(cmd);
  });
}

function projectPids(dir) {
  const real = fs.realpathSync(dir);
  return browserPids().filter((pid) => {
    const cmd = readCmd(pid);
    if (cmd.includes(real) || cmd.includes('qa-core-heal')) return true;
    try { return fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(real); } catch { return false; }
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
