/**
 * Run the local Selenium fixture pages through Mocha and check expected-results.json.
 * The pages are served on localhost. No SauceDemo credentials are used.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'selenium-saucedemo-style');

/**
 * A ChromeDriver already on PATH is started before Selenium Manager. Pass the
 * driver Selenium Manager resolves for this browser so the versions match.
 * https://www.selenium.dev/documentation/selenium_manager/
 */
function chromedriverFor(seleniumPkg, browserPath) {
  if (!browserPath) return '';
  const folder = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x86_64');
  const name = process.platform === 'win32' ? 'selenium-manager.exe' : 'selenium-manager';
  const manager = path.join(seleniumPkg, 'bin', folder, name);
  if (!fs.existsSync(manager)) return '';
  const run = spawnSync(manager, ['--browser', 'chrome', '--browser-path', browserPath, '--skip-driver-in-path', '--output', 'json'], { encoding: 'utf8', timeout: 120000 });
  try {
    const parsed = JSON.parse(run.stdout || '');
    const driver = parsed?.result?.driver_path;
    return driver && fs.existsSync(driver) ? driver : '';
  } catch {
    return '';
  }
}

export async function runSeleniumFixture({ cli, seleniumPkg, mochaPkg, chrome }) {
  const expected = JSON.parse(fs.readFileSync(path.join(fixture, 'expected-results.json'), 'utf8'));
  const failures = [];
  for (const item of expected.cases) {
    const htmlPath = path.join(fixture, 'pages', `${item.slug}.html`);
    const specPath = path.join(fixture, 'specs', `${item.slug}.js`);
    if (!fs.existsSync(htmlPath) || !fs.existsSync(specPath)) {
      failures.push(`${item.name}: missing page or spec`);
      continue;
    }
    const html = fs.readFileSync(htmlPath, 'utf8');
    const body = fs.readFileSync(specPath, 'utf8').trim();
    const result = await healOne({ cli, seleniumPkg, mochaPkg, chrome, html, body });
    if (result.status !== 0) {
      failures.push(`${item.name}: exit ${result.status}\n${result.stderr}\n${result.stdout}`);
      continue;
    }
    let payload;
    try { payload = JSON.parse(result.stdout); } catch { failures.push(`${item.name}: stdout was not JSON`); continue; }
    const row = payload.locators?.find((entry) => entry.old) ?? payload.locators?.[0];
    if (!row) {
      failures.push(`${item.name}: no locator\n${result.stdout}`);
      continue;
    }
    if (row.status !== item.expect) failures.push(`${item.name}: ${row.status} ${JSON.stringify(row)}`);
    if (item.match && !(row.new ?? '').includes(item.match)) failures.push(`${item.name}: ${row.new}`);
    if (item.ambiguous && row.ambiguous !== true) failures.push(`${item.name}: not ambiguous`);
    if (item.code) {
      const { refusalFromReason } = await import(path.join(here, '..', 'dist', 'findings-flow.js'));
      const code = refusalFromReason(row.reason ?? '', row.ambiguous === true);
      if (code !== item.code) failures.push(`${item.name}: refusal ${code}, expected ${item.code}`);
    }
    if (item.expect === 'refused' && row.new != null) failures.push(`${item.name}: wrote ${row.new}`);
    if (result.specAfter !== result.specBefore) failures.push(`${item.name}: dry run changed the spec`);
    if (result.qaCoreLeft) failures.push(`${item.name}: left .qa-core`);
    if (result.otherRan) failures.push(`${item.name}: ran the other spec`);
  }
  return {
    failures,
    cases: expected.cases.map((item) => ({
      name: item.name,
      expect: item.expect,
      code: item.code ?? null,
      ok: !failures.some((failure) => String(failure).startsWith(`${item.name}:`)),
    })),
  };
}

function specText(body) {
  return `const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
describe('login', () => {
  let driver;
  beforeEach(async () => {
    const options = new chrome.Options();
    const binary = process.env.QA_CORE_HEAL_CHROME;
    if (binary) options.setChromeBinaryPath(binary);
    options.addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage');
    let builder = new Builder().forBrowser('chrome').setChromeOptions(options);
    const driverBin = process.env.QA_CORE_HEAL_CHROMEDRIVER;
    if (driverBin) builder = builder.setChromeService(new chrome.ServiceBuilder(driverBin));
    driver = await builder.build();
  });
  afterEach(async () => { if (driver) await driver.quit(); });
  it('logs in', async () => {
    await driver.get(process.env.QA_CORE_HEAL_PAGE);
    ${body}
  });
});
`;
}

async function healOne({ cli, seleniumPkg, mochaPkg, chrome, html, body }) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-se-eval-'));
  const specPath = path.join(dir, 'test', 'login.test.js');
  const mark = path.join(dir, 'other-ran');
  try {
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(seleniumPkg, path.join(dir, 'node_modules', 'selenium-webdriver'));
    fs.symlinkSync(mochaPkg, path.join(dir, 'node_modules', 'mocha'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'se-eval', private: true, type: 'commonjs',
      devDependencies: { 'selenium-webdriver': '4.51.0', mocha: '12.0.3' },
    }));
    fs.writeFileSync(path.join(dir, '.mocharc.json'), JSON.stringify({ spec: ['test/other.test.js', 'test/login.test.js'], timeout: 20000 }));
    fs.writeFileSync(path.join(dir, 'test', 'other.test.js'), "const fs = require('node:fs');\ndescribe('other', () => { it('other test', () => { fs.writeFileSync(process.env.QA_CORE_HEAL_MARK, 'yes'); }); });\n");
    const spec = specText(body);
    fs.writeFileSync(specPath, spec);
    const env = {
      ...process.env,
      QA_CORE_HEAL_PAGE: base,
      QA_CORE_HEAL_CHROME: chrome || '',
      QA_CORE_HEAL_CHROMEDRIVER: chromedriverFor(seleniumPkg, chrome || ''),
      QA_CORE_HEAL_MARK: mark,
    };
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, 'test/login.test.js', '--test', 'logs in', '--dry-run', '--json'], { cwd: dir, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    return {
      ...run,
      specBefore: spec,
      specAfter: fs.readFileSync(specPath, 'utf8'),
      qaCoreLeft: fs.existsSync(path.join(dir, '.qa-core')),
      otherRan: fs.existsSync(mark),
    };
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
