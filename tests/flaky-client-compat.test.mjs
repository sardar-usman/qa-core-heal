import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureBaseline, headCli } from './helpers/baseline.mjs';
import { baseOf, finding, findingsDoc, makeProject, rm, startServer } from './helpers/contract.mjs';

const baselineCli = ensureBaseline();

function run(cli, args, cwd) {
  const runResult = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { status: runResult.status, stdout: runResult.stdout ?? '', stderr: runResult.stderr ?? '' };
}

function scrub(text) {
  return text
    .replaceAll('0.6.0', '0.4.2')
    .replaceAll('0.5.0', '0.4.2')
    .replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt": "TIME"')
    .replace(/"timestamp":\s*"[^"]*"/g, '"timestamp": "TIME"');
}

const SPEC = `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
});
`;

test('flaky client shapes match 0.4.2, and capabilities keeps the keys flaky reads', async () => {
  const server = await startServer('<html><body><label>Mail <input id="mail" /></label></body></html>');
  const dir = makeProject(baseOf(server), { 'tests/a.spec.ts': SPEC });
  const doc = findingsDoc([finding({ mode: 'none' })], baseOf(server));
  fs.writeFileSync(path.join(dir, 'findings.json'), `${JSON.stringify(doc, null, 2)}\n`);
  const shapes = [
    ['capabilities', '--json'],
    ['--version'],
    ['--findings', 'findings.json', '--results', 'heal-results.json', '--dry-run'],
    ['--findings', 'findings.json', '--results', 'heal-results.json', '--dry-run', '--run-timeout', '30'],
    ['tests/a.spec.ts', '--dry-run', '--json'],
  ];
  try {
    for (const args of shapes) {
      fs.rmSync(path.join(dir, 'heal-results.json'), { force: true });
      const oldRun = run(baselineCli, args, dir);
      const oldResults = fs.existsSync(path.join(dir, 'heal-results.json'))
        ? fs.readFileSync(path.join(dir, 'heal-results.json'), 'utf8') : '';
      fs.rmSync(path.join(dir, 'heal-results.json'), { force: true });
      const head = run(headCli, args, dir);
      const headResults = fs.existsSync(path.join(dir, 'heal-results.json'))
        ? fs.readFileSync(path.join(dir, 'heal-results.json'), 'utf8') : '';
      assert.equal(head.status, oldRun.status, `${args.join(' ')} exit\n${head.stderr}`);
      assert.equal(head.stderr, oldRun.stderr, `${args.join(' ')} stderr`);
      if (args[0] === 'capabilities') {
        const caps = JSON.parse(head.stdout);
        assert.equal(caps.features.runTimeout, true);
        assert.ok(caps.contracts.findings.includes(1));
        assert.deepEqual(caps.features.frameworks, ['playwright-js', 'cypress-js']);
        assert.equal(caps.frameworkVersions['playwright-js'], caps.playwrightVersion);
        const oldCaps = JSON.parse(oldRun.stdout);
        delete caps.features.frameworks;
        delete caps.frameworkVersions;
        assert.equal(scrub(JSON.stringify(caps)), scrub(JSON.stringify(oldCaps)));
      } else {
        assert.equal(scrub(head.stdout), scrub(oldRun.stdout), `${args.join(' ')} stdout`);
        assert.equal(scrub(headResults), scrub(oldResults), `${args.join(' ')} results`);
      }
      assert.equal(args.includes('--framework'), false);
    }
  } finally {
    server.close();
    rm(dir);
  }
});
