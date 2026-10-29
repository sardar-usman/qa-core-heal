/**
 * Compare heal output from 0.5.0 and from this build.
 *
 * Both builds run, one after the other, on the same absolute path.
 * The script exits non-zero when a difference is not in the list below.
 *
 * Normalisations against 0.5.0:
 *   - results generatedAt and audit timestamp values
 *   - the temporary output folder id
 *   - the version string 0.6.0 versus 0.5.0
 *   - features.frameworks, frameworkVersions, and the frameworks text line
 *   - the --framework values in --help
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureGoldenBaseline, headCli, repoRoot } from '../tests/helpers/baseline.mjs';

const baselineCli = ensureGoldenBaseline();

const NORMALISATIONS = [
  'results generatedAt and audit timestamp values',
  'temporary output folder id (qa-core-heal-out-*)',
  'version string 0.6.0 versus 0.5.0',
  'features.frameworks, frameworkVersions, and the frameworks text line',
  'the --framework values in --help',
];

const SUITES = [
  { name: 'checkout-basic', port: 4181 },
  { name: 'signup-pom', port: 4182 },
  { name: 'orders-dashboard', port: 4183 },
  { name: 'account-settings', port: 4184 },
  { name: 'pricing-hostile', port: 4185 },
  { name: 'hostile-mutation', port: 4186 },
  { name: 'fuzzy-typos', port: 4187 },
  { name: 'react-churn', port: 4191 },
  { name: 'tag-typos', port: 4192 },
  { name: 'normalization', port: 4193 },
  { name: 'shadow-dom', port: 4194 },
  { name: 'kind-guard', port: 4195 },
  { name: 'xpath-identity', port: 4198 },
  { name: 'decoy-pages', port: 4202 },
  { name: 'run-mode', port: 4188, mode: 'run' },
  { name: 'demowebshop-pom', remote: true },
];

const RUN_MODE_COMMANDS = [
  ['tests/passing.spec.ts'],
  ['tests/assert-fail.spec.ts'],
  ['tests/locator-fail.spec.ts', '-y'],
  ['tests/pom.spec.ts', '-y'],
  ['tests/timeout-shape.spec.ts', '-y'],
  ['tests/manual-browser.spec.ts', '--no-trace', '-y'],
  ['tests/deep-pom.spec.ts', '-y'],
  ['tests/auth-app.spec.ts'],
  ['tests/auth-app.spec.ts', '--storage-state', 'auth-states/expired.json'],
  ['tests/auth-app.spec.ts', '--storage-state', 'auth-states/valid.json', '-y'],
  ['tests/auth-app.spec.ts', '--auth-setup', 'utils/login-broken.ts#login'],
  ['tests/auth-app.spec.ts', '--auth-setup', 'utils/login-noop.ts#login'],
  ['tests/auth-app.spec.ts', '--auth-setup', 'utils/login.ts#login', '-y'],
  ['tests/auth-app.spec.ts', '--storage-state', 'auth-states/expired.json', '--auth-setup', 'utils/login.ts#login', '-y'],
  ['tests/count-zero.spec.ts', '-y'],
  ['tests/count-two.spec.ts'],
  ['tests/count-compound.spec.ts', '-y'],
  ['tests/role-mutated.spec.ts', '-y'],
  ['tests/strict-first.spec.ts', '-y'],
  ['tests/rot.spec.ts', '-y'],
  ['tests/dynamic-id.spec.ts', '-y'],
  ['tests/overlay.spec.ts', '-y'],
  ['tests/overlay-clears.spec.ts'],
  ['tests/option-role.spec.ts', '-y'],
  ['tests/listitem.spec.ts', '-y'],
  ['tests/revert.spec.ts', '-y'],
  ['tests/revert.spec.ts', '-y', '--json'],
  ['tests/chained.spec.ts', '-y'],
  ['tests/dynamic-selector.spec.ts', '-y'],
  ['tests/and-chain.spec.ts', '-y'],
  ['tests/or-chain.spec.ts', '-y'],
  ['tests/literal-shapes.spec.ts', '-y'],
  ['tests/wrongassert.spec.ts', '-y'],
  ['tests/wrongassert.spec.ts', '-y', '--json'],
  ['tests/dup-inline.spec.ts', '-y'],
  ['tests/dup-inline.spec.ts', '-y', '--json'],
  ['tests/dup-two-tests.spec.ts', '-y'],
  ['tests/state-gated.spec.ts', '--scan', '--dry-run', '--json'],
  ['tests/state-gated.spec.ts', '-y'],
];

const diffs = [];

function snapshotSources(dir) {
  const snap = new Map();
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      if (name === 'node_modules' || name === '.qa-core' || name === 'test-results' || name === 'playwright-report' || name === 'blob-report') continue;
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else snap.set(p, fs.readFileSync(p));
    }
  };
  walk(dir);
  return snap;
}

function restoreSources(snap) {
  for (const [file, buf] of snap) fs.writeFileSync(file, buf);
}

function cleanArtifacts(dir) {
  for (const name of ['.qa-core', 'test-results', 'playwright-report', 'blob-report']) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function scrubText(text) {
  return text
    .replaceAll('0.6.0', '0.5.0')
    .replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt": "TIME"')
    .replace(/"timestamp":\s*"[^"]*"/g, '"timestamp": "TIME"')
    .replace(/qa-core-heal-out-[A-Za-z0-9_-]+/g, 'qa-core-heal-out-ID')
    .replaceAll('Supported now: playwright-js, cypress-js.', 'Supported now: playwright-js.')
    .replaceAll('Planned: selenium-js, playwright-py, selenium-py', 'Planned: cypress-js, selenium-js, playwright-py, selenium-py')
    .replace(/^ {2}frameworks:.*\n/gm, '  frameworks: playwright-js\n');
}

function scrubJsonKeys(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return text;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && obj.features && Array.isArray(obj.features.frameworks)) {
      obj.features.frameworks = ['playwright-js'];
    }
    if (obj && typeof obj === 'object' && obj.frameworkVersions && typeof obj.frameworkVersions === 'object') {
      obj.frameworkVersions = { 'playwright-js': obj.frameworkVersions['playwright-js'] ?? null };
    }
    const newline = text.endsWith('\n') ? '\n' : '';
    return `${JSON.stringify(obj, null, 2)}${newline}`;
  } catch {
    return text;
  }
}

function normalize(text) {
  return scrubJsonKeys(scrubText(text));
}

function runCli(cli, args, cwd) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000,
  });
  return {
    status: run.status,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    error: run.error ? String(run.error.message) : '',
  };
}

function namedOutputs(dir, args) {
  const out = new Map();
  const take = (rel) => {
    if (!rel || rel.startsWith('-')) return;
    const abs = path.resolve(dir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      out.set(rel.split(path.sep).join('/'), fs.readFileSync(abs));
    }
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results' || args[i] === '--output') take(args[i + 1]);
  }
  take('heal-results.json');
  return out;
}

function removeNamed(dir, args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--results' || args[i] === '--output') {
      fs.rmSync(path.resolve(dir, args[i + 1] ?? ''), { force: true });
    }
  }
  fs.rmSync(path.join(dir, 'heal-results.json'), { force: true });
}

function healFiles(dir, args) {
  const out = namedOutputs(dir, args);
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join('/'), fs.readFileSync(p));
    }
  };
  walk(path.join(dir, '.qa-core'));
  return out;
}

function changedSources(dir, snap) {
  const out = new Map();
  for (const [file, before] of snap) {
    let now;
    try { now = fs.readFileSync(file); } catch { now = Buffer.from('MISSING'); }
    if (!now.equals(before)) out.set(path.relative(dir, file).split(path.sep).join('/'), now);
  }
  return out;
}

function mapDiff(label, left, right) {
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of [...keys].sort()) {
    const a = normalize((left.get(key) ?? Buffer.from('')).toString('utf8'));
    const b = normalize((right.get(key) ?? Buffer.from('')).toString('utf8'));
    if (a !== b) diffs.push({ label: `${label} file ${key}`, a, b });
  }
}

function compareRun(label, cwd, args, snap) {
  cleanArtifacts(cwd);
  removeNamed(cwd, args);
  const oldRun = runCli(baselineCli, args, cwd);
  const oldFiles = healFiles(cwd, args);
  const oldSources = changedSources(cwd, snap);
  restoreSources(snap);
  cleanArtifacts(cwd);
  removeNamed(cwd, args);
  const newRun = runCli(headCli, args, cwd);
  const newFiles = healFiles(cwd, args);
  const newSources = changedSources(cwd, snap);
  restoreSources(snap);
  cleanArtifacts(cwd);
  removeNamed(cwd, args);
  const shown = args.join(' ');
  if (oldRun.status !== newRun.status) {
    diffs.push({ label: `${label} [${shown}] exit`, a: String(oldRun.status), b: String(newRun.status) });
  }
  if (normalize(oldRun.stdout) !== normalize(newRun.stdout)) {
    diffs.push({ label: `${label} [${shown}] stdout`, a: normalize(oldRun.stdout), b: normalize(newRun.stdout) });
  }
  if (normalize(oldRun.stderr) !== normalize(newRun.stderr)) {
    diffs.push({ label: `${label} [${shown}] stderr`, a: normalize(oldRun.stderr), b: normalize(newRun.stderr) });
  }
  mapDiff(`${label} [${shown}]`, oldFiles, newFiles);
  mapDiff(`${label} [${shown}] source`, oldSources, newSources);
  process.stdout.write(diffs.length === 0 ? '.' : 'x');
}

function waitFor(url) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      fetch(url).then((r) => { if (r.ok) resolve(); else retry(); }).catch(retry);
    };
    const retry = () => {
      if (++n > 50) reject(new Error(`server did not start: ${url}`));
      else setTimeout(tick, 200);
    };
    tick();
  });
}

function startServer(file) {
  const child = spawn(process.execPath, [file], { stdio: 'ignore' });
  return child;
}

async function withServer(suite, fn) {
  const dir = path.join(repoRoot, 'evals', 'fixtures', suite.name);
  const snap = snapshotSources(dir);
  let server = null;
  try {
    if (!suite.remote) {
      server = startServer(path.join(dir, 'serve.mjs'));
      await waitFor(`http://127.0.0.1:${suite.port}/`);
    }
    await fn(dir, snap);
  } finally {
    server?.kill();
    restoreSources(snap);
    cleanArtifacts(dir);
  }
}

function staticCommands() {
  return [
    ['--scan', '--dry-run', '--json'],
    ['--scan', '--dry-run'],
    ['--scan', '--apply', '--yes', '--audit-log', '.qa-core/golden-audit.jsonl'],
  ];
}

async function compareSuites() {
  for (const suite of SUITES) {
    process.stdout.write(`\n${suite.name} `);
    await withServer(suite, async (dir, snap) => {
      const commands = suite.mode === 'run'
        ? RUN_MODE_COMMANDS
        : suite.remote
          ? [['--scan', '--dry-run', '--json'], ['--scan', '--dry-run']]
          : staticCommands();
      for (const args of commands) compareRun(suite.name, dir, args, snap);
    });
  }
}

function compareCliSurface() {
  process.stdout.write('\nsurface ');
  const cwd = repoRoot;
  for (const args of [['--help'], ['--version'], ['capabilities'], ['capabilities', '--json']]) {
    const oldRun = runCli(baselineCli, args, cwd);
    const newRun = runCli(headCli, args, cwd);
    const shown = args.join(' ') || '(none)';
    if (oldRun.status !== newRun.status) diffs.push({ label: `surface [${shown}] exit`, a: String(oldRun.status), b: String(newRun.status) });
    if (normalize(oldRun.stdout) !== normalize(newRun.stdout)) diffs.push({ label: `surface [${shown}] stdout`, a: normalize(oldRun.stdout), b: normalize(newRun.stdout) });
    if (normalize(oldRun.stderr) !== normalize(newRun.stderr)) diffs.push({ label: `surface [${shown}] stderr`, a: normalize(oldRun.stderr), b: normalize(newRun.stderr) });
    process.stdout.write(diffs.length === 0 ? '.' : 'x');
  }
}

async function compareExample() {
  process.stdout.write('\nexample-project ');
  const dir = path.join(repoRoot, 'example-project');
  const snap = snapshotSources(dir);
  const server = startServer(path.join(dir, 'serve.mjs'));
  try {
    await waitFor('http://127.0.0.1:4173/');
    // The heal half of npm run demo. The Playwright reporter in step 1 is
    // not heal output and is not compared.
    compareRun('example-project demo', dir, ['--scan', '--dry-run'], snap);
    compareRun('example-project demo json', dir, ['--scan', '--dry-run', '--json'], snap);
  } finally {
    server.kill();
    restoreSources(snap);
    cleanArtifacts(dir);
  }
}

function findingDoc(base) {
  return {
    schema: 'qa-core.heal-findings',
    schemaVersion: 1,
    project: { configPath: 'playwright.config.ts', baseUrl: base },
    findings: [{
      findingId: 'a1b2c3d4e5f6',
      testId: 'tests/a.spec.ts::chromium::fills mail',
      file: 'tests/a.spec.ts',
      line: 4,
      project: 'chromium',
      titlePath: ['fills mail'],
      verdict: 'broken-test',
      primaryRuleId: 'SEL-NOTFOUND',
      handoff: {
        mode: 'locator',
        reason: 'Selector rule matched.',
        gates: [
          { name: 'verdict-not-likely-real-bug', passed: true },
          { name: 'verdict-not-environment-issue', passed: true },
          { name: 'no-slow-load-signal', passed: true },
          { name: 'rule-has-fix-strategy', passed: true },
          { name: 'evidence-present', passed: true },
        ],
      },
    }],
  };
}

async function compareFlags() {
  process.stdout.write('\nflags ');
  const dir = fs.mkdtempSync(path.join(repoRoot, '.tmp-test-golden-'));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><label>Mail <input id="mail" name="email" /></label></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "golden", "private": true }\n');
  fs.writeFileSync(path.join(dir, 'playwright.config.ts'), `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, retries: 0, timeout: 8000,
  use: { baseURL: '${base}' },
  projects: [{ name: 'chromium' }],
});
`);
  const spec = `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-missing').fill('a@b.dev');
});
test('passes', async ({ page }) => {
  await page.goto('/');
});
`;
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'a.spec.ts'), spec);
  fs.writeFileSync(path.join(dir, 'findings.json'), `${JSON.stringify(findingDoc(base), null, 2)}\n`);
  const snap = snapshotSources(dir);
  try {
    const commands = [
      ['tests/a.spec.ts', '--dry-run', '--json'],
      ['tests/a.spec.ts', '--dry-run'],
      ['tests/a.spec.ts', '--scan', '--apply', '--yes', '--no-verify', '--audit-log', '.qa-core/golden-audit.jsonl'],
      ['tests/a.spec.ts', '--test', 'passes', '--run-timeout', '60'],
      ['tests/a.spec.ts', '--test', 'passes', '--dry-run', '--json', '--run-timeout', '60'],
      ['--findings', 'findings.json', '--results', 'heal-results.json', '--dry-run', '--shadow-runs', '1', '--audit-log', '.qa-core/golden-audit.jsonl'],
    ];
    for (const args of commands) compareRun('flags', dir, args, snap);
    const results = path.join(dir, 'heal-results.json');
    if (fs.existsSync(results)) fs.rmSync(results);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function showDiff(d) {
  const clip = (s) => s.length > 2000 ? `${s.slice(0, 2000)}\n... (${s.length} chars)` : s;
  console.log(`\n--- ${d.label}`);
  console.log('<<<<<<< 0.5.0');
  console.log(clip(d.a));
  console.log('>>>>>>> head');
  console.log(clip(d.b));
}

async function main() {
  if (!fs.existsSync(headCli)) {
    console.error('dist/cli.js is missing. Run npm run build first.');
    process.exit(1);
  }
  console.log('Normalisations:');
  for (const line of NORMALISATIONS) console.log(`  - ${line}`);
  const only = process.env.GOLDEN_ONLY ?? '';
  if (!only || only === 'surface') compareCliSurface();
  if (!only || only === 'example') await compareExample();
  if (!only || only === 'flags') await compareFlags();
  if (!only || only === 'suites' || SUITES.some((s) => s.name === only)) {
    if (SUITES.some((s) => s.name === only)) {
      const suite = SUITES.find((s) => s.name === only);
      process.stdout.write(`\n${suite.name} `);
      await withServer(suite, async (dir, snap) => {
        const commands = suite.mode === 'run' ? RUN_MODE_COMMANDS : suite.remote
          ? [['--scan', '--dry-run', '--json'], ['--scan', '--dry-run']]
          : staticCommands();
        for (const args of commands) compareRun(suite.name, dir, args, snap);
      });
    } else {
      await compareSuites();
    }
  }
  console.log('\n');
  if (diffs.length === 0) {
    console.log('golden diff: clean');
    return;
  }
  console.log(`golden diff: ${diffs.length} unexplained difference(s)`);
  for (const d of diffs.slice(0, 12)) showDiff(d);
  if (diffs.length > 12) console.log(`... and ${diffs.length - 12} more`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (path.resolve(process.argv[1] ?? '') === path.join(here, 'golden-diff.mjs') || process.argv[1]?.endsWith('golden-diff.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
