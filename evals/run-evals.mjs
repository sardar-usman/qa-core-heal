import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Eval harness for qa-core-heal.
 *
 * For each fixture suite:
 *   1. snapshot the spec and page-object sources (so the suite can be
 *      restored to its broken state afterwards)
 *   2. start the suite's local server
 *   3. run the broken suite and record which tests fail
 *   4. run heal dry-run with JSON output and compare against
 *      expected-results.json
 *   5. apply heals, re-run the suite, record final pass counts
 *   6. restore the broken sources, clean artifacts, stop the server
 *
 * Scoring:
 *   correct heal      = expected healed, got healed, AND its test passes on
 *                       the post-apply re-run
 *   correct refusal   = expected refused, got refused
 *   wrong heal        = expected refused but healed anyway (flagged loudly),
 *                       or healed but its test still fails after apply
 *   miss              = expected healed but refused
 *   cascade level agreement is reported separately as informational.
 *
 * Outputs evals/results.json and evals/RESULTS.md. Neither contains
 * timestamps or durations, so two runs on the same tree are byte-identical.
 */

const evalsDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.dirname(evalsDir);
const cliJs = path.join(packageDir, 'dist', 'cli.js');
const requireFrom = createRequire(import.meta.url);
const playwrightVersion = requireFrom('playwright/package.json').version;

const SUITES = [
  { name: 'checkout-basic', port: 4181 },
  { name: 'signup-pom', port: 4182 },
  { name: 'orders-dashboard', port: 4183 },
  { name: 'account-settings', port: 4184 },
  { name: 'pricing-hostile', port: 4185 },
  { name: 'hostile-mutation', port: 4186 },
];

if (!fs.existsSync(cliJs)) {
  console.error('dist/cli.js not found. Run "npm run build" first.');
  process.exit(1);
}

function listSourceFiles(suiteDir) {
  const out = [];
  for (const sub of ['tests', 'pages']) {
    const dir = path.join(suiteDir, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith('.ts')) out.push(path.join(dir, name));
    }
  }
  return out;
}

function snapshotSources(suiteDir) {
  const snap = new Map();
  for (const f of listSourceFiles(suiteDir)) snap.set(f, fs.readFileSync(f, 'utf8'));
  return snap;
}

function restoreSources(snap) {
  for (const [f, src] of snap) fs.writeFileSync(f, src);
}

function cleanArtifacts(suiteDir) {
  for (const d of ['.qa-core', 'test-results', 'playwright-report']) {
    fs.rmSync(path.join(suiteDir, d), { recursive: true, force: true });
  }
}

async function waitForServer(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`server did not start for ${url}`);
}

function collectSpecs(node, out) {
  for (const s of node.specs ?? []) out.push({ title: s.title, ok: !!s.ok });
  for (const child of node.suites ?? []) collectSpecs(child, out);
  return out;
}

/** Run the suite's playwright tests, return [{title, ok}] sorted by title. */
function runPlaywright(suiteDir) {
  const run = spawnSync('npx', ['playwright', 'test', '--reporter=json'], {
    cwd: suiteDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const raw = run.stdout.slice(run.stdout.indexOf('{'));
  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    throw new Error(`could not parse playwright JSON for ${suiteDir}: ${e.message}`);
  }
  const specs = [];
  for (const s of report.suites ?? []) collectSpecs(s, specs);
  return specs.sort((a, b) => a.title.localeCompare(b.title));
}

function runCli(suiteDir, args) {
  return spawnSync('node', [cliJs, ...args], {
    cwd: suiteDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}

async function runSuite(suite) {
  const suiteDir = path.join(evalsDir, 'fixtures', suite.name);
  const expected = JSON.parse(fs.readFileSync(path.join(suiteDir, 'expected-results.json'), 'utf8'));
  const snap = snapshotSources(suiteDir);
  cleanArtifacts(suiteDir);

  const server = spawn('node', [path.join(suiteDir, 'serve.mjs')], { stdio: 'ignore' });
  try {
    await waitForServer(`http://127.0.0.1:${suite.port}/`);

    const brokenTests = runPlaywright(suiteDir);
    const dryRun = runCli(suiteDir, ['--dry-run', '--json']);
    if (dryRun.status !== 0) throw new Error(`heal dry-run failed for ${suite.name}: ${dryRun.stderr}`);
    const dry = JSON.parse(dryRun.stdout);
    runCli(suiteDir, ['--apply', '--yes', '--no-verify']);
    const finalTests = runPlaywright(suiteDir);

    return score(suite, expected, dry, brokenTests, finalTests);
  } finally {
    server.kill();
    restoreSources(snap);
    cleanArtifacts(suiteDir);
  }
}

function score(suite, expected, dry, brokenTests, finalTests) {
  const got = new Map(dry.locators.map((l) => [`${l.file}|${l.old}`, l]));
  const finalOkByTitle = new Map(finalTests.map((t) => [t.title, t.ok]));
  const notes = [];
  const perLocator = [];

  let correctHeals = 0;
  let correctRefusals = 0;
  let wrongHeals = 0;
  let misses = 0;
  let levelMatches = 0;
  let healedGot = 0;

  for (const e of expected.locators) {
    const g = got.get(`${e.file}|${e.old}`);
    if (!g) {
      notes.push(`FIXTURE ISSUE: expected locator not found in scan: ${e.file} ${e.old}`);
      perLocator.push({ file: e.file, old: e.old, expect: e.expect, got: 'missing', verdict: 'fixture-issue' });
      continue;
    }
    const testOk = finalOkByTitle.get(e.test) === true;
    let verdict;
    if (e.expect === 'healed') {
      if (g.status === 'healed') {
        healedGot++;
        if (testOk) {
          verdict = 'correct-heal';
          correctHeals++;
          if (g.level === e.level) levelMatches++;
          else notes.push(`level differs (informational): ${e.old} expected ${e.level}, got ${g.level}`);
        } else {
          verdict = 'wrong-heal';
          wrongHeals++;
          notes.push(`WRONG HEAL: ${e.old} healed to ${g.new} but test "${e.test}" still fails`);
        }
      } else {
        verdict = 'miss';
        misses++;
        notes.push(`miss: expected heal for ${e.old}, got ${g.status}${g.reason ? ` (${g.reason})` : ''}`);
      }
    } else {
      if (g.status === 'refused') {
        if (e.reason && g.reason !== e.reason) {
          verdict = 'wrong-reason';
          notes.push(`WRONG REASON: ${e.old} refused with "${g.reason}", expected "${e.reason}"`);
        } else {
          verdict = 'correct-refusal';
          correctRefusals++;
        }
      } else if (g.status === 'healed') {
        verdict = 'wrong-heal';
        wrongHeals++;
        notes.push(`WRONG HEAL (should have refused): ${e.old} was healed to ${g.new}`);
      } else {
        verdict = 'fixture-issue';
        notes.push(`FIXTURE ISSUE: expected refusal for ${e.old} but locator probed intact`);
      }
    }
    perLocator.push({
      file: e.file, old: e.old, expect: e.expect, got: g.status,
      gotNew: g.new, expectLevel: e.level ?? null, gotLevel: g.level,
      testPassed: finalOkByTitle.get(e.test) ?? null, verdict,
    });
  }

  // Sanity: a locator meant to stay intact must not show up broken.
  const expectedKeys = new Set(expected.locators.map((e) => `${e.file}|${e.old}`));
  for (const l of dry.locators) {
    if (l.status !== 'intact' && !expectedKeys.has(`${l.file}|${l.old}`)) {
      notes.push(`FIXTURE ISSUE: unplanned non-intact locator: ${l.file} ${l.old} (${l.status})`);
    }
  }

  const expectedFailTitles = new Set(
    expected.locators.filter((e) => e.expect === 'refused').map((e) => e.test),
  );
  const finalFailed = finalTests.filter((t) => !t.ok);
  const unexpectedFailures = finalFailed.filter((t) => !expectedFailTitles.has(t.title));
  const finalOk = unexpectedFailures.length === 0;

  return {
    suite: suite.name,
    locators: dry.scanned,
    broken: expected.locators.length,
    healedExpected: expected.locators.filter((e) => e.expect === 'healed').length,
    correctHeals,
    correctRefusals,
    wrongHeals,
    misses,
    levelMatches,
    healedGot,
    brokenRunFailedTests: brokenTests.filter((t) => !t.ok).length,
    brokenRunTotalTests: brokenTests.length,
    finalPassed: finalTests.filter((t) => t.ok).length,
    finalFailed: finalFailed.length,
    expectedFailures: expectedFailTitles.size,
    finalOk,
    perLocator,
    notes,
  };
}

function totalsOf(results) {
  const sum = (k) => results.reduce((a, r) => a + r[k], 0);
  return {
    locators: sum('locators'),
    broken: sum('broken'),
    healedExpected: sum('healedExpected'),
    correctHeals: sum('correctHeals'),
    correctRefusals: sum('correctRefusals'),
    wrongHeals: sum('wrongHeals'),
    misses: sum('misses'),
    levelMatches: sum('levelMatches'),
  };
}

function renderMarkdown(results, totals) {
  const lines = [];
  lines.push('# qa-core-heal eval results');
  lines.push('');
  lines.push(`Playwright version: ${playwrightVersion}`);
  lines.push('');
  lines.push('A heal counts as correct only when its status matches the expected outcome');
  lines.push('AND the test that uses the locator passes after the heal is applied.');
  lines.push('Expected refusals (no identity left to heal from) count as correct behavior.');
  lines.push('');
  lines.push('| Suite | Locators | Broken | Healed | Correctly refused | Wrong heals | Final suite status |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    const status = `${r.finalPassed}/${r.brokenRunTotalTests} passed` +
      (r.expectedFailures > 0 ? ` (${r.expectedFailures} expected failure${r.expectedFailures === 1 ? '' : 's'})` : '') +
      (r.finalOk ? '' : ' !! unexpected failures');
    lines.push(`| ${r.suite} | ${r.locators} | ${r.broken} | ${r.correctHeals}/${r.healedExpected} | ${r.correctRefusals}/${r.broken - r.healedExpected} | ${r.wrongHeals} | ${status} |`);
  }
  lines.push(`| **Total** | **${totals.locators}** | **${totals.broken}** | **${totals.correctHeals}/${totals.healedExpected}** | **${totals.correctRefusals}/${totals.broken - totals.healedExpected}** | **${totals.wrongHeals}** | |`);
  lines.push('');
  lines.push(`Misses (expected heal, got refusal): ${totals.misses}`);
  lines.push(`Cascade level agreement (informational): ${totals.levelMatches}/${totals.correctHeals} correct heals landed on the predicted level.`);
  lines.push('');
  const allNotes = results.flatMap((r) => r.notes.map((n) => `- [${r.suite}] ${n}`));
  if (allNotes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    lines.push(...allNotes);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

const results = [];
for (const suite of SUITES) {
  console.log(`=== ${suite.name} ===`);
  const r = await runSuite(suite);
  console.log(`    heals ${r.correctHeals}/${r.healedExpected} · refusals ${r.correctRefusals}/${r.broken - r.healedExpected} · wrong ${r.wrongHeals} · final ${r.finalPassed}/${r.brokenRunTotalTests}${r.finalOk ? '' : ' !!'}`);
  results.push(r);
}

const totals = totalsOf(results);
const payload = { playwrightVersion, suites: results, totals };
fs.writeFileSync(path.join(evalsDir, 'results.json'), JSON.stringify(payload, null, 2) + '\n');
fs.writeFileSync(path.join(evalsDir, 'RESULTS.md'), renderMarkdown(results, totals));
console.log('\nWrote evals/results.json and evals/RESULTS.md');
const anyWrong = totals.wrongHeals > 0 || totals.misses > 0 || results.some((r) => !r.finalOk || r.notes.some((n) => n.startsWith('FIXTURE') || n.startsWith('WRONG')));
process.exitCode = anyWrong ? 1 : 0;
