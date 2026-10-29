/**
 * Temporary CI probe. Prints the Mocha argv, cwd, a few env vars, the
 * parsed config, the files Mocha loads, and the JSON report.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = process.cwd();
const mochaBin = createRequire(path.join(repo, 'package.json')).resolve('mocha/bin/mocha.js');
const { loadOptions } = createRequire(mochaBin)(
  path.join(path.dirname(mochaBin), '..', 'lib', 'cli', 'options.cjs'),
);

console.log('ENV', JSON.stringify({
  CI: process.env.CI ?? null,
  FORCE_COLOR: process.env.FORCE_COLOR ?? null,
  NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
  MOCHA_OPTIONS: process.env.MOCHA_OPTIONS ?? null,
}));
console.log('MOCHA_BIN', mochaBin);
console.log('EXEC', process.execPath);

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'mocha-debug-'));
fs.mkdirSync(path.join(proj, 'test'), { recursive: true });
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({
  name: 'mocha-debug', private: true, type: 'commonjs',
}));
fs.writeFileSync(path.join(proj, '.mocharc.json'), JSON.stringify({
  spec: ['test/other.test.js', 'test/login.test.js'], timeout: 20000,
}));
fs.writeFileSync(path.join(proj, 'test', 'other.test.js'), "describe('other', () => { it('other test', () => {}); });\n");
fs.writeFileSync(path.join(proj, 'test', 'login.test.js'), [
  "describe('login', () => {",
  "  it.only('logs in', () => {});",
  "  it('hangs', () => {});",
  '});',
  '',
].join('\n'));

const spec = path.join(proj, 'test', 'login.test.js');
const out = path.join(proj, 'mocha.json');
const args = [spec, '--no-config', '--timeout', '20000', '--reporter', 'json', '--reporter-option', `output=${out}`, '--retries', '0'];
const parsed = loadOptions(args);
console.log('CWD', proj);
console.log('ARGV', JSON.stringify([process.execPath, mochaBin, ...args]));
console.log('LOADOPTIONS', JSON.stringify({
  grep: parsed.grep ?? null,
  fgrep: parsed.fgrep ?? null,
  forbidOnly: parsed['forbid-only'] ?? null,
  forbidPending: parsed['forbid-pending'] ?? null,
  parallel: parsed.parallel ?? null,
  ui: parsed.ui ?? null,
  timeout: parsed.timeout ?? null,
  config: parsed.config ?? null,
  spec: parsed.spec ?? null,
  _: parsed._ ?? null,
  require: parsed.require ?? null,
}, null, 2));
console.log('SPEC_HAS_ONLY', fs.readFileSync(spec, 'utf8').includes("it.only('logs in'"));

function run(label, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  const result = spawnSync(process.execPath, [mochaBin, ...args], { cwd: proj, env, encoding: 'utf8' });
  console.log(`\n== ${label} status ${result.status}`);
  console.log('STDERR', JSON.stringify(result.stderr));
  console.log('STDOUT', JSON.stringify((result.stdout || '').slice(0, 500)));
  if (fs.existsSync(out)) {
    console.log('REPORT', fs.readFileSync(out, 'utf8').slice(0, 1500));
    fs.rmSync(out);
  } else {
    console.log('REPORT missing');
  }
}

run('with-process-env');
run('without-CI', { CI: '' });
args.push('--dry-run');
run('dry-run');
