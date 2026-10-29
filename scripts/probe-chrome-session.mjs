/**
 * Temporary CI probe. Prints how ChromeDriver starts Chrome for Testing.
 * Does not print the process environment. Exits 0 either way.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function chromeBinary() {
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(root)) return '';
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name, 'chrome-linux64', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

const binary = chromeBinary();
const present = {
  CI: process.env.CI ?? null,
  FORCE_COLOR: process.env.FORCE_COLOR ?? null,
  NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
};
console.log(JSON.stringify({
  cwd: process.cwd(),
  execPath: process.execPath,
  binary,
  binaryExists: Boolean(binary) && fs.existsSync(binary),
  env: present,
  userns: fs.existsSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    ? fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim()
    : null,
}));

if (!binary) {
  console.log('PROBE_FAIL no playwright chrome binary');
  process.exit(0);
}

const version = spawnSync(binary, ['--version', '--no-sandbox'], { encoding: 'utf8', timeout: 20000 });
console.log('CHROME_VERSION', (version.stdout || version.stderr || version.error || '').toString().split('\n')[0]);

const seleniumRoot = path.join(process.cwd(), 'node_modules', 'selenium-webdriver');
const manager = path.join(seleniumRoot, 'bin', 'linux-x86_64', 'selenium-manager');
if (fs.existsSync(manager)) {
  const found = spawnSync(manager, ['--browser', 'chrome', '--browser-path', binary], { encoding: 'utf8', timeout: 120000 });
  console.log('SELENIUM_MANAGER', (found.stdout || '').trim().split('\n').slice(-6).join('\n'));
  if (found.stderr) console.log('SELENIUM_MANAGER_ERR', found.stderr.trim().split('\n').slice(-12).join('\n'));
}

const log = path.join(os.tmpdir(), 'qa-core-heal-chromedriver-probe.log');
try { fs.unlinkSync(log); } catch { /* none yet */ }

const script = `
const chrome = require(${JSON.stringify(path.join(seleniumRoot, 'chrome.js'))});
const fs = require('node:fs');
(async () => {
  const options = new chrome.Options();
  options.setChromeBinaryPath(${JSON.stringify(binary)});
  options.addArguments('--headless=new', '--no-sandbox', '--disable-dev-shm-usage');
  const service = new chrome.ServiceBuilder().loggingTo(${JSON.stringify(log)}).enableVerboseLogging().enableChromeLogging();
  const started = Date.now();
  try {
    const driver = await chrome.Driver.createSession(options, service.build());
    console.log('PROBE_OK', Date.now() - started);
    await driver.quit();
  } catch (error) {
    console.log('PROBE_FAIL', Date.now() - started);
    console.log(String(error && error.stack || error).slice(0, 2000));
  }
})();
`;
const run = spawnSync(process.execPath, ['--input-type=commonjs', '-e', script], { encoding: 'utf8', timeout: 60000 });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (fs.existsSync(log)) {
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter((line) => /DevToolsActivePort|exited normally|session not created|Chrome failed|FATAL|apparmor|user namespace/i.test(line));
  console.log('CHROMEDRIVER_LOG');
  console.log(lines.slice(0, 40).join('\n'));
}
const ldd = spawnSync('ldd', [binary], { encoding: 'utf8', timeout: 10000 });
const missing = (ldd.stdout || '').split('\n').filter((line) => /not found/.test(line));
if (missing.length) console.log('LDD_MISSING', missing.join('\n'));
