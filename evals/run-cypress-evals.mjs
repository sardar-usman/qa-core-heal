/**
 * Run the local Cypress fixture pages and check expected-results.json.
 * The pages are served on localhost. No SauceDemo credentials are used.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'cypress-saucedemo-style');

const SLUG = {
  'test id typo': 'test-id-typo',
  'renamed text': 'renamed-text',
  'ambiguous match': 'ambiguous',
  'moved element': 'moved',
  'real defect': 'real-defect',
  iframe: 'iframe',
};

export async function runCypressFixture({ repoRoot, cli, cypressPkg }) {
  const expected = JSON.parse(fs.readFileSync(path.join(fixture, 'expected-results.json'), 'utf8'));
  const failures = [];
  for (const item of expected.cases) {
    const slug = SLUG[item.name];
    if (!slug) {
      failures.push(`${item.name}: no fixture slug`);
      continue;
    }
    const html = fs.readFileSync(path.join(fixture, 'pages', `${slug}.html`), 'utf8');
    const spec = fs.readFileSync(path.join(fixture, 'specs', `${slug}.cy.js`), 'utf8');
    const result = await healOne({ repoRoot, cli, cypressPkg, html, spec });
    if (result.status !== 0) {
      failures.push(`${item.name}: exit ${result.status}\n${result.stderr}`);
      continue;
    }
    const payload = JSON.parse(result.stdout);
    const row = payload.locators.find((entry) => entry.old) ?? payload.locators[0];
    if (!row) {
      failures.push(`${item.name}: no locator\n${result.stdout}`);
      continue;
    }
    if (row.status !== item.expect) failures.push(`${item.name}: ${row.status} ${JSON.stringify(row)}`);
    if (item.expect === 'refused' && row.new != null) failures.push(`${item.name}: wrote ${row.new}`);
    if (result.specAfter !== spec) failures.push(`${item.name}: dry run changed the spec`);
    if (result.qaCoreLeft) failures.push(`${item.name}: left .qa-core`);
  }
  return failures;
}

async function healOne({ cli, cypressPkg, html, spec }) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-cy-eval-'));
  const specPath = path.join(dir, 'cypress/e2e/login.cy.js');
  try {
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.mkdirSync(path.join(dir, 'cypress/support'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(cypressPkg, path.join(dir, 'node_modules', 'cypress'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cy-eval', private: true }));
    fs.writeFileSync(path.join(dir, 'cypress.config.js'), `const { defineConfig } = require('cypress');\nmodule.exports = defineConfig({\n  e2e: { baseUrl: '${base}', supportFile: 'cypress/support/e2e.js', specPattern: 'cypress/e2e/**/*.cy.js' },\n  video: false,\n});\n`);
    fs.writeFileSync(path.join(dir, 'cypress/support/e2e.js'), '');
    fs.writeFileSync(specPath, spec);
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, 'cypress/e2e/login.cy.js', '--dry-run', '--json'], { cwd: dir });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const specAfter = fs.readFileSync(specPath, 'utf8');
    const qaCoreLeft = fs.existsSync(path.join(dir, '.qa-core'));
    return { ...run, specAfter, qaCoreLeft };
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = path.dirname(here);
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  const cypressPkg = process.env.QA_CORE_HEAL_CYPRESS_PACKAGE || path.join(repoRoot, 'node_modules', 'cypress');
  const failures = await runCypressFixture({ repoRoot, cli, cypressPkg });
  if (failures.length > 0) {
    console.error(failures.join('\n\n'));
    process.exit(1);
  }
  console.log('cypress evals: clean');
}
