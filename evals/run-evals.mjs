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
  { name: 'fuzzy-typos', port: 4187 },
  { name: 'react-churn', port: 4191 },
  // Run-first mode scenarios: the CLI's default behavior (run tests, heal
  // only real locator failures on their failure-time pages).
  { name: 'run-mode', port: 4188, mode: 'run' },
  // Remote suite: probes the live Tricentis demo shop over the network.
  // No serve.mjs; the base URL lives only in the suite's playwright.config.ts.
  { name: 'demowebshop-pom', remote: true },
];

if (!fs.existsSync(cliJs)) {
  console.error('dist/cli.js not found. Run "npm run build" first.');
  process.exit(1);
}

function listSourceFiles(suiteDir) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) out.push(p);
    }
  };
  for (const sub of ['tests', 'pages']) walk(path.join(suiteDir, sub));
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

  const server = suite.remote
    ? null
    : spawn('node', [path.join(suiteDir, 'serve.mjs')], { stdio: 'ignore' });
  try {
    if (!suite.remote) await waitForServer(`http://127.0.0.1:${suite.port}/`);

    const brokenTests = runPlaywright(suiteDir);
    // Static suites exercise --scan: probe every locator, no test execution.
    const dryRun = runCli(suiteDir, ['--scan', '--dry-run', '--json']);
    if (dryRun.status !== 0) throw new Error(`heal dry-run failed for ${suite.name}: ${dryRun.stderr}`);
    const dry = JSON.parse(dryRun.stdout);
    runCli(suiteDir, ['--scan', '--apply', '--yes', '--no-verify']);
    const finalTests = runPlaywright(suiteDir);

    return score(suite, expected, dry, brokenTests, finalTests);
  } finally {
    server?.kill();
    restoreSources(snap);
    cleanArtifacts(suiteDir);
  }
}

/** Run one spec file with Playwright; true when it passes. */
function playwrightFilePasses(suiteDir, relSpec) {
  const run = spawnSync('npx', ['playwright', 'test', relSpec, '--reporter=line'], {
    cwd: suiteDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  return run.status === 0;
}

/**
 * Run-first mode scenarios. Each scenario exercises the CLI's DEFAULT
 * behavior (no --scan): run the tests, classify failures, heal only real
 * locator failures on their failure-time page.
 */
async function runScenarioSuite(suite) {
  const suiteDir = path.join(evalsDir, 'fixtures', suite.name);
  const snap = snapshotSources(suiteDir);
  cleanArtifacts(suiteDir);
  const server = spawn('node', [path.join(suiteDir, 'serve.mjs')], { stdio: 'ignore' });

  const notes = [];
  const perLocator = [];
  let correctHeals = 0;
  let wrongHeals = 0;
  let misses = 0;
  let scenariosPassed = 0;
  const scenario = (name, ok, detail) => {
    perLocator.push({ scenario: name, verdict: ok ? 'pass' : 'fail', detail: detail ?? null });
    if (ok) scenariosPassed++;
    else notes.push(`WRONG (run-mode scenario failed): ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const sourcesUnchanged = () =>
    [...snap].every(([f, src]) => fs.readFileSync(f, 'utf8') === src);

  try {
    await waitForServer(`http://127.0.0.1:${suite.port}/`);

    // 1. All tests pass: zero probing, zero scanning.
    {
      const r = runCli(suiteDir, ['tests/passing.spec.ts']);
      scenario('passing spec exits 0 with no probing',
        r.status === 0
          && r.stdout.includes('All tests passing. Nothing to heal.')
          && !r.stdout.includes('scanned')
          && !r.stdout.includes('opened'),
        `exit ${r.status}`);
    }

    // 2. Assertion mismatch on a FOUND element: reported, never healed.
    {
      const r = runCli(suiteDir, ['tests/assert-fail.spec.ts']);
      const unchanged = sourcesUnchanged();
      if (!unchanged) wrongHeals++;
      scenario('assertion failure reported as non-locator, no heal',
        r.status === 0
          && r.stdout.includes("not a locator problem, healing won't fix this")
          && unchanged,
        `exit ${r.status}`);
    }

    // 3. Locator failure: heal it, re-run green. The page hosts a
    //    third-party iframe (different origin) whose frame snapshots are
    //    the LAST in the trace — the extracted failure URL must still be
    //    the MAIN page, never the widget.
    {
      const r = runCli(suiteDir, ['tests/locator-fail.spec.ts', '-y']);
      const src = fs.readFileSync(path.join(suiteDir, 'tests/locator-fail.spec.ts'), 'utf8');
      const healed = src.includes('getByRole("textbox"');
      const green = healed && playwrightFilePasses(suiteDir, 'tests/locator-fail.spec.ts');
      const mainPageUrl = r.stdout.includes('(page: http://127.0.0.1:4188/)')
        && !r.stdout.includes('4189');
      if (healed && green) correctHeals++;
      else if (healed) wrongHeals++;
      else misses++;
      scenario('locator failure heals and re-runs green (main-page URL, not the iframe)',
        r.status === 0 && r.stdout.includes('✓ re-run passed') && healed && green && mainPageUrl,
        `exit ${r.status}, mainPageUrl ${mainPageUrl}`);
      restoreSources(snap);
      cleanArtifacts(suiteDir);
    }

    // 5. Structural target matching: (a) the broken locator lives in an
    //    imported POM, (b) a getByRole whose source style (double quotes,
    //    quoted keys) differs from Playwright's error rendering, (c) a
    //    plain CSS locator(). All three must heal end-to-end.
    {
      const r = runCli(suiteDir, ['tests/pom.spec.ts', '-y']);
      const pomSrc = fs.readFileSync(path.join(suiteDir, 'pages/home-page.ts'), 'utf8');
      const specSrc = fs.readFileSync(path.join(suiteDir, 'tests/pom.spec.ts'), 'utf8');
      const healedPom = pomSrc.includes('{"name":"Quantity","exact":true}');
      const healedRole = specSrc.includes('{"name":"Quantity","exact":true}') && !specSrc.includes('Quantity_9');
      const healedCss = specSrc.includes('page.locator("#status")');
      const green = playwrightFilePasses(suiteDir, 'tests/pom.spec.ts');
      const healedCount = [healedPom, healedRole, healedCss].filter(Boolean).length;
      if (green) correctHeals += healedCount;
      else wrongHeals += healedCount;
      misses += 3 - healedCount;
      scenario('POM / role-options-style / css locator failures all heal end-to-end',
        r.status === 0 && r.stdout.includes('✓ re-run passed')
          && healedPom && healedRole && healedCss && green,
        `exit ${r.status}, pom ${healedPom}, role ${healedRole}, css ${healedCss}, green ${green}`);
      restoreSources(snap);
      cleanArtifacts(suiteDir);
    }

    // 6. The second-repo shape: the locator wait outlives the TEST timeout
    //    and the pending action dies on the closed page — the evidence
    //    lives in a secondary error's call log. Must classify as a locator
    //    failure and heal.
    {
      const r = runCli(suiteDir, ['tests/timeout-shape.spec.ts', '-y']);
      const src = fs.readFileSync(path.join(suiteDir, 'tests/timeout-shape.spec.ts'), 'utf8');
      const healed = src.includes('getByRole("textbox"');
      const green = healed && playwrightFilePasses(suiteDir, 'tests/timeout-shape.spec.ts');
      if (healed && green) correctHeals++;
      else if (healed) wrongHeals++;
      else misses++;
      scenario('timeout+closed failure classified as locator and healed',
        r.status === 0 && r.stdout.includes("locator failure: locator('#quantiy')")
          && r.stdout.includes('✓ re-run passed') && healed && green,
        `exit ${r.status}, healed ${healed}, green ${green}`);
      restoreSources(snap);
      cleanArtifacts(suiteDir);
    }

    // 7. Manual chromium.launch() in beforeAll (no usable trace, forced via
    //    --no-trace): the failure URL comes from static route inference.
    {
      const r = runCli(suiteDir, ['tests/manual-browser.spec.ts', '--no-trace', '-y']);
      const src = fs.readFileSync(path.join(suiteDir, 'tests/manual-browser.spec.ts'), 'utf8');
      const healed = src.includes('page.locator("#status")');
      const green = healed && playwrightFilePasses(suiteDir, 'tests/manual-browser.spec.ts');
      if (healed && green) correctHeals++;
      else if (healed) wrongHeals++;
      else misses++;
      scenario('manual-browser failure heals via route inference without a trace',
        r.status === 0 && !r.stdout.includes('(page:')
          && r.stdout.includes('✓ re-run passed') && healed && green,
        `exit ${r.status}, healed ${healed}, green ${green}`);
      restoreSources(snap);
      cleanArtifacts(suiteDir);
    }

    // 8. Locator evidence in the call log, selector defined in a POM two
    //    imports deep (spec -> page object -> widget).
    {
      const r = runCli(suiteDir, ['tests/deep-pom.spec.ts', '-y']);
      const widgetSrc = fs.readFileSync(path.join(suiteDir, 'pages/widgets/search-widget.ts'), 'utf8');
      const healed = widgetSrc.includes('getByRole("textbox"') && !widgetSrc.includes('quantity_field_1');
      const green = healed && playwrightFilePasses(suiteDir, 'tests/deep-pom.spec.ts');
      if (healed && green) correctHeals++;
      else if (healed) wrongHeals++;
      else misses++;
      scenario('two-imports-deep POM locator heals end-to-end',
        r.status === 0 && r.stdout.includes('✓ re-run passed') && healed && green,
        `exit ${r.status}, healed ${healed}, green ${green}`);
      restoreSources(snap);
      cleanArtifacts(suiteDir);
    }

    // 9. Unloadable config (a TS enum defeats type stripping) + relative
    //    goto only: no baseURL resolves, nothing anchors the origin check —
    //    the main-frame trace URL must be TRUSTED and the heal succeed
    //    purely from it.
    {
      const appDir = path.join(suiteDir, 'broken-config-app');
      const specPath = path.join(appDir, 'tests/app.spec.ts');
      const specBackup = fs.readFileSync(specPath, 'utf8');
      const r = spawnSync('node', [cliJs, 'tests/app.spec.ts', '-y'], {
        cwd: appDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      });
      const src = fs.readFileSync(specPath, 'utf8');
      const healed = src.includes('getByRole("textbox"');
      const green = healed && playwrightFilePasses(appDir, 'tests/app.spec.ts');
      const trusted = (r.stderr ?? '').includes('using failure page from trace: http://127.0.0.1:4188/');
      const warned = (r.stderr ?? '').includes('failed to load');
      if (healed && green) correctHeals++;
      else if (healed) wrongHeals++;
      else misses++;
      scenario('unloadable config: heal succeeds purely from the trusted trace URL',
        r.status === 0 && r.stdout.includes('✓ re-run passed') && healed && green && trusted && warned,
        `exit ${r.status}, healed ${healed}, green ${green}, trusted ${trusted}, warned ${warned}`);
      fs.writeFileSync(specPath, specBackup);
      fs.rmSync(path.join(appDir, 'test-results'), { recursive: true, force: true });
      fs.rmSync(path.join(appDir, '.qa-core'), { recursive: true, force: true });
    }

    // 10. Authenticated probing: /app 302-redirects to /login without the
    //     session cookie. (a) without --storage-state: refuse, print the
    //     redirect and the auth hint; (b) with a valid state: heal
    //     end-to-end and re-run green; (c) with an expired state: print the
    //     expired-session message and refuse.
    {
      const stdio = (r) => (r.stdout ?? '') + (r.stderr ?? '');
      // (a) unauthenticated
      const a = runCli(suiteDir, ['tests/auth-app.spec.ts']);
      const aOk = a.status === 0
        && stdio(a).includes('requested /app, landed on /login (redirected)')
        && stdio(a).includes('the page may require authentication; pass --storage-state <path>')
        && stdio(a).includes('redirected to /login; the target page could not be probed')
        && sourcesUnchanged();
      // (c) expired state
      const c = runCli(suiteDir, ['tests/auth-app.spec.ts', '--storage-state', 'auth-states/expired.json']);
      const cOk = c.status === 0
        && stdio(c).includes('storage state was applied but /app still redirected to /login; the saved session may be expired. Re-generate it and retry.')
        && sourcesUnchanged();
      // (b) valid state: heals and re-runs green
      const b = runCli(suiteDir, ['tests/auth-app.spec.ts', '--storage-state', 'auth-states/valid.json', '-y']);
      const src = fs.readFileSync(path.join(suiteDir, 'tests/auth-app.spec.ts'), 'utf8');
      const healed = src.includes('getByRole("textbox"');
      const green = healed && playwrightFilePasses(suiteDir, 'tests/auth-app.spec.ts');
      if (healed && green) correctHeals++;
      else if (healed) wrongHeals++;
      else misses++;
      scenario('authenticated probing: refuse+hint / heal with state / expired message',
        aOk && cOk && b.status === 0 && b.stdout.includes('✓ re-run passed') && healed && green,
        `a ${aOk} (exit ${a.status}), c ${cOk} (exit ${c.status}), b exit ${b.status}, healed ${healed}, green ${green}`);
      restoreSources(snap);
      cleanArtifacts(suiteDir);
    }

    // 11. --auth-setup: the user's own login function authenticates the
    //     probing context. (a) working login: heal end-to-end; (b) throwing
    //     login: loud failure, NO unauthenticated probe; (c) login that
    //     runs but never authenticates: the redirect-after-auth message.
    {
      const stdio = (r) => (r.stdout ?? '') + (r.stderr ?? '');
      // (b) throwing setup: exit non-zero, nothing probed, nothing changed.
      const b = runCli(suiteDir, ['tests/auth-app.spec.ts', '--auth-setup', 'utils/login-broken.ts#login']);
      const bOk = b.status !== 0
        && stdio(b).includes('auth setup utils/login-broken.ts#login failed: bad credentials')
        && !b.stdout.includes('· opened')
        && sourcesUnchanged();
      // (c) silently-failing setup: redirect-after-auth message, refusal.
      const c = runCli(suiteDir, ['tests/auth-app.spec.ts', '--auth-setup', 'utils/login-noop.ts#login']);
      const cOk = c.status === 0
        && stdio(c).includes('auth setup ran but /app still redirected to /login; the login function may have failed silently or the session did not persist')
        && sourcesUnchanged();
      // (a) working setup: authenticated probe, heal, green re-run.
      const a = runCli(suiteDir, ['tests/auth-app.spec.ts', '--auth-setup', 'utils/login.ts#login', '-y']);
      const src = fs.readFileSync(path.join(suiteDir, 'tests/auth-app.spec.ts'), 'utf8');
      const healed = src.includes('getByRole("textbox"');
      const green = healed && playwrightFilePasses(suiteDir, 'tests/auth-app.spec.ts');
      if (healed && green) correctHeals++;
      else if (healed) wrongHeals++;
      else misses++;
      const aOk = a.status === 0
        && stdio(a).includes('auth setup utils/login.ts#login succeeded')
        && a.stdout.includes('✓ re-run passed')
        && !stdio(a).includes('ExperimentalWarning')
        && !stdio(a).includes('To load an ES module');
      scenario('--auth-setup: login fn heals / throwing fails loud / silent no-auth reported',
        aOk && bOk && cOk && healed && green,
        `a ${aOk} (exit ${a.status}), b ${bOk} (exit ${b.status}), c ${cOk} (exit ${c.status}), healed ${healed}, green ${green}`);
      restoreSources(snap);
      cleanArtifacts(suiteDir);
    }

    // 4. State-gated element (reached by clicking, no goto names its page):
    //    --scan must refuse; the default run mode heals on the REAL failure
    //    URL taken from the trace.
    {
      const scan = runCli(suiteDir, ['tests/state-gated.spec.ts', '--scan', '--dry-run', '--json']);
      let refusedInScan = false;
      try {
        const dry = JSON.parse(scan.stdout);
        refusedInScan = dry.locators.length === 1 && dry.locators[0].status === 'refused';
      } catch { /* fails the scenario below */ }
      const r = runCli(suiteDir, ['tests/state-gated.spec.ts', '-y']);
      const src = fs.readFileSync(path.join(suiteDir, 'tests/state-gated.spec.ts'), 'utf8');
      const healed = src.includes('getByRole("button"');
      const green = healed && playwrightFilePasses(suiteDir, 'tests/state-gated.spec.ts');
      if (healed && green) correctHeals++;
      else if (healed) wrongHeals++;
      else misses++;
      scenario('state-gated element: scan refuses, run mode heals on the failure URL',
        refusedInScan && r.status === 0 && r.stdout.includes('✓ re-run passed') && healed && green,
        `scan refused: ${refusedInScan}, run exit ${r.status}`);
      restoreSources(snap);
      cleanArtifacts(suiteDir);
    }
  } finally {
    server.kill();
    restoreSources(snap);
    cleanArtifacts(suiteDir);
  }

  const SCENARIOS = 11;
  return {
    suite: suite.name,
    locators: 11,
    broken: 11,
    healedExpected: 11,
    intactExpected: 0,
    correctHeals,
    correctRefusals: 0,
    correctIntact: 0,
    wrongHeals,
    misses,
    levelMatches: correctHeals,
    healedGot: correctHeals,
    brokenRunTotalTests: SCENARIOS,
    finalPassed: scenariosPassed,
    finalFailed: SCENARIOS - scenariosPassed,
    expectedFailures: 0,
    finalOk: scenariosPassed === SCENARIOS,
    scenariosPassed,
    scenariosTotal: SCENARIOS,
    perLocator,
    notes,
  };
}

function score(suite, expected, dry, brokenTests, finalTests) {
  const got = new Map(dry.locators.map((l) => [`${l.file}|${l.old}`, l]));
  const finalOkByTitle = new Map(finalTests.map((t) => [t.title, t.ok]));
  const notes = [];
  const perLocator = [];

  let correctHeals = 0;
  let correctRefusals = 0;
  let correctIntact = 0;
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
    // A locator pinned as forbidden output: healing it to anything containing
    // this fragment is a wrong heal no matter what else the scoring says.
    if (e.mustNotContain && g.new && g.new.includes(e.mustNotContain)) {
      notes.push(`WRONG HEAL (forbidden shape): ${e.old} healed to ${g.new}, which contains "${e.mustNotContain}"`);
    }
    let verdict;
    if (e.expect === 'intact') {
      // The locator is valid on its own route; touching it at all is wrong.
      if (g.status === 'intact') {
        verdict = 'correct-intact';
        correctIntact++;
      } else if (g.status === 'healed') {
        verdict = 'wrong-heal';
        wrongHeals++;
        notes.push(`WRONG HEAL (should have stayed intact): ${e.old} was healed to ${g.new}`);
      } else {
        verdict = 'miss';
        misses++;
        notes.push(`miss: ${e.old} should probe intact on its route, got refused${g.reason ? ` (${g.reason})` : ''}`);
      }
    } else if (e.expect === 'healed') {
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
    broken: expected.locators.filter((e) => e.expect !== 'intact').length,
    healedExpected: expected.locators.filter((e) => e.expect === 'healed').length,
    intactExpected: expected.locators.filter((e) => e.expect === 'intact').length,
    correctHeals,
    correctRefusals,
    correctIntact,
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
    intactExpected: sum('intactExpected'),
    correctHeals: sum('correctHeals'),
    correctRefusals: sum('correctRefusals'),
    correctIntact: sum('correctIntact'),
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
  lines.push('| Suite | Locators | Broken | Healed | Correctly refused | Intact kept | Wrong heals | Final suite status |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const status = `${r.finalPassed}/${r.brokenRunTotalTests} passed` +
      (r.expectedFailures > 0 ? ` (${r.expectedFailures} expected failure${r.expectedFailures === 1 ? '' : 's'})` : '') +
      (r.finalOk ? '' : ' !! unexpected failures');
    const intactCell = r.intactExpected > 0 ? `${r.correctIntact}/${r.intactExpected}` : '—';
    lines.push(`| ${r.suite} | ${r.locators} | ${r.broken} | ${r.correctHeals}/${r.healedExpected} | ${r.correctRefusals}/${r.broken - r.healedExpected} | ${intactCell} | ${r.wrongHeals} | ${status} |`);
  }
  lines.push(`| **Total** | **${totals.locators}** | **${totals.broken}** | **${totals.correctHeals}/${totals.healedExpected}** | **${totals.correctRefusals}/${totals.broken - totals.healedExpected}** | **${totals.correctIntact}/${totals.intactExpected}** | **${totals.wrongHeals}** | |`);
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

// Optional filter: `node evals/run-evals.mjs <suite-name>` runs one suite.
const only = process.argv[2];
const selected = only ? SUITES.filter((s) => s.name === only) : SUITES;
if (only && selected.length === 0) {
  console.error(`Unknown suite "${only}". Available: ${SUITES.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

const results = [];
for (const suite of selected) {
  console.log(`=== ${suite.name} ===`);
  const r = suite.mode === 'run' ? await runScenarioSuite(suite) : await runSuite(suite);
  const intactBit = r.intactExpected > 0 ? ` · intact ${r.correctIntact}/${r.intactExpected}` : '';
  const scenarioBit = r.scenariosTotal ? ` · scenarios ${r.scenariosPassed}/${r.scenariosTotal}` : '';
  console.log(`    heals ${r.correctHeals}/${r.healedExpected} · refusals ${r.correctRefusals}/${r.broken - r.healedExpected}${intactBit}${scenarioBit} · wrong ${r.wrongHeals} · final ${r.finalPassed}/${r.brokenRunTotalTests}${r.finalOk ? '' : ' !!'}`);
  results.push(r);
}

const totals = totalsOf(results);
if (only) {
  console.log('\nSingle-suite run: results.json / RESULTS.md not rewritten.');
} else {
  const payload = { playwrightVersion, suites: results, totals };
  fs.writeFileSync(path.join(evalsDir, 'results.json'), JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(path.join(evalsDir, 'RESULTS.md'), renderMarkdown(results, totals));
  console.log('\nWrote evals/results.json and evals/RESULTS.md');
}
const anyWrong = totals.wrongHeals > 0 || totals.misses > 0 || results.some((r) => !r.finalOk || r.notes.some((n) => n.startsWith('FIXTURE') || n.startsWith('WRONG')));
process.exitCode = anyWrong ? 1 : 0;
