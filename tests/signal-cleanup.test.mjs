import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { baseOf, cliJs, finding, makeProject, rm, startServer, writeFindings } from './helpers/contract.mjs';
import { chromiumProfiles, installSuiteTmp, removeNewChromiumProfiles, sweepTemps } from './helpers/temps.mjs';

installSuiteTmp();

/**
 * SIGINT and SIGTERM must kill the Playwright process group, remove the
 * private output folder, and, when --apply is still unverified, put the
 * spec back and write an audit line.
 */

const profilesAtStart = chromiumProfiles();
after(() => {
  sweepTemps();
  removeNewChromiumProfiles(profilesAtStart);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { return ''; }
}

function pidsIn(dir) {
  const real = fs.realpathSync(dir);
  return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => {
    try { return fs.readlinkSync(`/proc/${n}/cwd`).startsWith(real); } catch { return false; }
  }).map(Number);
}

function spawnCli(args, cwd) {
  const child = spawn(process.execPath, [cliJs, ...args], { cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal })));
  return { child, closed, text: () => ({ stdout, stderr }) };
}

async function waitFor(fn, label, ms = 60000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    last = typeof v === 'string' ? v : '';
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ''}`);
}

function outputRootFrom(dir, cliPid, marker) {
  for (const pid of pidsIn(dir)) {
    if (pid === cliPid) continue;
    const cmd = cmdline(pid);
    if (marker && !cmd.includes(marker)) continue;
    const m = cmd.match(/--output (\S*qa-core-heal-out-[^/\s]+)/);
    if (m) return m[1];
  }
  return null;
}

/** Processes still using the project, or still naming the private output folder. */
function leftovers(dir, outRoot) {
  const real = fs.realpathSync(dir);
  const name = outRoot ? path.basename(outRoot) : '';
  return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => {
    if (Number(n) === process.pid) return false;
    const cmd = cmdline(n);
    if (name && cmd.includes(name)) return true;
    try {
      const cwd = fs.readlinkSync(`/proc/${n}/cwd`);
      return cwd.startsWith(real) || (name && cwd.includes(name));
    } catch { return false; }
  }).map(Number);
}

function assertStoppedClean(dir, outRoot) {
  assert.equal(fs.existsSync(outRoot), false, `output folder still present: ${outRoot}`);
  assert.deepEqual(leftovers(dir, outRoot), [], 'a Playwright or browser process is still running');
}

async function stopAndJoin(child, closed, sig) {
  process.kill(child.pid, sig);
  const result = await closed;
  await sleep(400);
  return result;
}

test('SIGTERM during a findings run removes the output folder and exits 143', { timeout: 120000 }, async () => {
  assert.equal(fs.existsSync('/proc/self/cwd'), true, 'this check reads /proc');
  const server = await startServer('<html><body><input id="mail-x9" /></body></html>');
  const profiles = chromiumProfiles();
  const dir = makeProject(baseOf(server), {
    'tests/a.spec.ts': `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(120000);
});
`,
  }, { timeout: 180000 });
  const findingsPath = writeFindings(dir, [finding()]);
  const resultsPath = path.join(dir, 'heal-results.json');
  const run = spawnCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--shadow-runs', '1'], dir);
  try {
    const outRoot = await waitFor(() => outputRootFrom(dir, run.child.pid), 'a Playwright child with a private output folder');
    assert.equal(fs.existsSync(outRoot), true);
    const done = await stopAndJoin(run.child, run.closed, 'SIGTERM');
    assert.equal(done.status, 143, `${run.text().stderr}`);
    assertStoppedClean(dir, outRoot);
  } finally {
    if (run.child.exitCode === null && !run.child.killed) {
      try { process.kill(run.child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    server.close();
    rm(dir);
    removeNewChromiumProfiles(profiles);
  }
});

test('SIGINT during a findings run exits 130 and leaves no output folder', { timeout: 120000 }, async () => {
  const server = await startServer('<html><body><input id="mail-x9" /></body></html>');
  const profiles = chromiumProfiles();
  const dir = makeProject(baseOf(server), {
    'tests/a.spec.ts': `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(120000);
});
`,
  }, { timeout: 180000 });
  const findingsPath = writeFindings(dir, [finding()]);
  const run = spawnCli(['--findings', findingsPath, '--results', path.join(dir, 'r.json'), '--dry-run', '--shadow-runs', '1'], dir);
  try {
    const outRoot = await waitFor(() => outputRootFrom(dir, run.child.pid), 'a Playwright child with a private output folder');
    const done = await stopAndJoin(run.child, run.closed, 'SIGINT');
    assert.equal(done.status, 130, `${run.text().stderr}`);
    assertStoppedClean(dir, outRoot);
  } finally {
    if (run.child.exitCode === null && !run.child.killed) {
      try { process.kill(run.child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    server.close();
    rm(dir);
    removeNewChromiumProfiles(profiles);
  }
});

function applyProject(base) {
  return makeProject(base, {
    'tests/a.spec.ts': `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
  await page.waitForTimeout(120000);
});
`,
  }, { timeout: 180000 });
}

async function interruptApply(sig, expectStatus) {
  const server = await startServer('<html><body><label>Mail <input id="mail-x9" name="email" type="email" /></label></body></html>');
  const profiles = chromiumProfiles();
  const dir = applyProject(baseOf(server));
  const spec = path.join(dir, 'tests/a.spec.ts');
  const original = fs.readFileSync(spec);
  const audit = path.join(dir, 'audit.jsonl');
  const run = spawnCli(['tests/a.spec.ts', '--apply', '--yes', '--audit-log', audit], dir);
  try {
    await waitFor(() => {
      const text = run.text().stdout;
      const src = fs.readFileSync(spec, 'utf8');
      return text.includes('Verifying') && src.includes('input[type="email"]') ? true : null;
    }, 'the unverified heal and the verify re-run');
    const outRoot = await waitFor(() => outputRootFrom(dir, run.child.pid), 'the verify child output folder');
    const done = await stopAndJoin(run.child, run.closed, sig);
    assert.equal(done.status, expectStatus, `${run.text().stdout}\n${run.text().stderr}`);
    assert.deepEqual(fs.readFileSync(spec), original);
    const lines = fs.readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].applied, true);
    assert.equal(lines[0].verified, false);
    assert.equal(lines[0].reverted, true);
    assert.equal(lines[0].revertReason, 'interrupted');
    assertStoppedClean(dir, outRoot);
  } finally {
    if (run.child.exitCode === null && !run.child.killed) {
      try { process.kill(run.child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    server.close();
    rm(dir);
    removeNewChromiumProfiles(profiles);
  }
}

test('SIGINT during --apply verification restores the spec and writes an interrupted audit entry', { timeout: 120000 }, async () => {
  await interruptApply('SIGINT', 130);
});

test('SIGTERM during --apply verification restores the spec and exits 143', { timeout: 120000 }, async () => {
  await interruptApply('SIGTERM', 143);
});

const HANG = `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await new Promise((r) => setTimeout(r, 120000));
});
`;

test('a spec run timeout kills Playwright and removes the output folder', { timeout: 120000 }, async () => {
  assert.equal(fs.existsSync('/proc/self/cwd'), true, 'this check reads /proc');
  const server = await startServer('<html><body><input id="mail-x9" /></body></html>');
  const profiles = chromiumProfiles();
  const dir = makeProject(baseOf(server), { 'tests/a.spec.ts': HANG }, { timeout: 180000 });
  const run = spawnCli(['tests/a.spec.ts', '--test', 'fills mail', '--run-timeout', '6'], dir);
  try {
    const outRoot = await waitFor(() => outputRootFrom(dir, run.child.pid), 'a Playwright child with a private output folder');
    const done = await run.closed;
    await sleep(400);
    assert.equal(done.status, 1, `${run.text().stdout}\n${run.text().stderr}`);
    assert.match(run.text().stderr, /timed out after 6 seconds/);
    assertStoppedClean(dir, outRoot);
  } finally {
    if (run.child.exitCode === null && !run.child.killed) {
      try { process.kill(run.child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    server.close();
    rm(dir);
    removeNewChromiumProfiles(profiles);
  }
});

async function interruptFindingsApply(sig, expectStatus) {
  const server = await startServer('<html><body><label>Mail <input id="mail-x9" name="email" type="email" /></label></body></html>');
  const profiles = chromiumProfiles();
  const dir = makeProject(baseOf(server), {
    'tests/a.spec.ts': `import { test } from '@playwright/test';
test('fills mail', async ({ page }) => {
  await page.goto('/');
  await page.locator('#email-7d21ac').fill('a@b.dev');
  await page.waitForTimeout(15000);
});
`,
  }, { timeout: 180000 });
  const spec = path.join(dir, 'tests/a.spec.ts');
  const original = fs.readFileSync(spec);
  const audit = path.join(dir, 'audit.jsonl');
  const findingsPath = writeFindings(dir, [finding()]);
  const run = spawnCli([
    '--findings', findingsPath, '--results', path.join(dir, 'heal-results.json'),
    '--apply', '--yes', '--audit-log', audit, '--shadow-runs', '1',
  ], dir);
  try {
    const outRoot = await waitFor(() => {
      const src = fs.readFileSync(spec, 'utf8');
      if (!src.includes('input[type="email"]')) return null;
      return outputRootFrom(dir, run.child.pid, 'rerun');
    }, 'the findings verify re-run', 90000);
    const done = await stopAndJoin(run.child, run.closed, sig);
    assert.equal(done.status, expectStatus, `${run.text().stdout}\n${run.text().stderr}`);
    assert.deepEqual(fs.readFileSync(spec), original);
    const lines = fs.readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].applied, true);
    assert.equal(lines[0].verified, false);
    assert.equal(lines[0].reverted, true);
    assert.equal(lines[0].revertReason, 'interrupted');
    assertStoppedClean(dir, outRoot);
  } finally {
    if (run.child.exitCode === null && !run.child.killed) {
      try { process.kill(run.child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    server.close();
    rm(dir);
    removeNewChromiumProfiles(profiles);
  }
}

test('SIGINT during a findings --apply verification restores the spec and writes an interrupted audit entry', { timeout: 120000 }, async () => {
  await interruptFindingsApply('SIGINT', 130);
});

test('SIGTERM during a findings --apply verification restores the spec and exits 143', { timeout: 120000 }, async () => {
  await interruptFindingsApply('SIGTERM', 143);
});

test('a findings run timeout kills Playwright and removes the output folder', { timeout: 120000 }, async () => {
  const server = await startServer('<html><body><input id="mail-x9" /></body></html>');
  const profiles = chromiumProfiles();
  const dir = makeProject(baseOf(server), { 'tests/a.spec.ts': HANG }, { timeout: 180000 });
  const findingsPath = writeFindings(dir, [finding()]);
  const resultsPath = path.join(dir, 'heal-results.json');
  const run = spawnCli(['--findings', findingsPath, '--results', resultsPath, '--dry-run', '--shadow-runs', '1', '--run-timeout', '6'], dir);
  try {
    const outRoot = await waitFor(() => outputRootFrom(dir, run.child.pid), 'a Playwright child with a private output folder');
    const done = await run.closed;
    await sleep(400);
    assert.equal(done.status, 0, `${run.text().stderr}`);
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    assert.equal(results.results[0].refusal.code, 'timeout');
    assertStoppedClean(dir, outRoot);
  } finally {
    if (run.child.exitCode === null && !run.child.killed) {
      try { process.kill(run.child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    server.close();
    rm(dir);
    removeNewChromiumProfiles(profiles);
  }
});
