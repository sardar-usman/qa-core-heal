#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { heal, type HealEvent, type HealResult, type HealTarget, type LocatorReport } from './heal.js';
import { escapeRegex, type CascadeLevel } from './selectors.js';
import { loadConfig } from './config.js';
import { appendAuditLog, type AuditEntry } from './audit.js';
import { findPlaywrightConfig, supportsTypeStripping, typeStrippingGateMessage } from './playwright-config.js';
import { classifyFailure, collectTests, parseConsent, parseJsonReport, traceFailureUrl, type TestOutcome } from './run.js';

/**
 * qa-core-heal CLI.
 *
 * Usage:
 *   qa-core-heal [spec-path] [--scan] [--config <path>] [--base-url <url>]
 *                [--project <name>] [--storage-state <path>]
 *                [--auth-setup <file>#<export>] [--auth-setup-timeout <seconds>]
 *                [--route <file>=<route>]...
 *                [--dry-run | --apply] [--yes|-y] [--json] [--audit-log <path>]
 *                [--max-heals <n>] [--verify | --no-verify]
 *
 * --auth-setup <file>#<export> (default export when #export is omitted;
 * also settable as authSetup in qa-core.config.json) runs the user's OWN
 * login function against a fresh page in the probing context before
 * probing: `await fn(page)`. It takes precedence over --storage-state. A
 * throw or timeout (60s default, --auth-setup-timeout <seconds>) fails the
 * run loudly — never a silent unauthenticated probe. Only file paths,
 * export names, and pass/fail are logged; credentials, cookie values, and
 * storage contents never are.
 *
 * Authenticated pages: --storage-state <path> probes with Playwright's
 * storageState (auto-detected from the playwright config's use.storageState
 * or conventional .auth paths when absent). A probe that gets REDIRECTED
 * off the requested page never probes the landing page as the target: it
 * reports "requested X, landed on Y (redirected)" with an auth hint or an
 * expired-session note, and refuses.
 *
 * The playwright config is imported in a child process with a CJS-compatible
 * require exposed (ESM configs calling require("dotenv").config() work) and
 * .env loaded as a fallback (never overriding set env vars). A config that
 * fails to load is WARNED about with the underlying error — never silently
 * treated as "no baseURL". When projects disagree on baseURL, pass
 * --project <name> to choose (or --base-url).
 *
 * Default (run-first) mode: run the spec(s) with Playwright first. All
 * green means nothing to do — no scanning, no probing. On failures, each
 * one is classified: locator failures (timeout waiting for a locator,
 * element not found, strict mode violation) are healed by probing ONLY the
 * failing selectors on the page URL each test was on when it failed (from
 * the trace); everything else (assertion value mismatch on a found element,
 * navigation/network errors, thrown app errors) is reported as not a
 * locator problem and never healed. After applying, only the previously
 * failing tests are re-run to verify.
 *
 * --scan mode: the static probe — no test execution, every locator in the
 * spec and its page objects probed on its inferred route. For audits and
 * suites too expensive to run.
 *
 * Exit codes:
 *   0  success: heals applied, nothing to heal, all tests passing, or an
 *      explicit --dry-run
 *   1  error (bad arguments, unreachable page, unresolvable base URL, ...)
 *   2  heals available but not applied: apply mode without --yes in a
 *      non-interactive context (stdout is not a TTY, or --json), or the
 *      interactive prompt was declined. The proposed diff is still printed.
 *
 * The target base URL is resolved from, in order: --base-url, baseUrl in
 * qa-core.config.json, use.baseURL in the project's own playwright.config,
 * and the first absolute page.goto() in the specs. Each locator is probed
 * on the route its spec navigates to (inferred from page.goto() calls; page
 * objects inherit the routes of the specs importing them); --route overrides
 * the inference per file.
 *
 * Safety defaults: applying always prints the full proposed diff first and
 * requires consent (--yes, or an interactive prompt in a TTY; a non-TTY
 * context without --yes exits instead of writing). Healed specs are re-run
 * to verify by default; --no-verify opts out.
 *
 * Reads qa-core.config.json from the working directory (or the --config path)
 * when present. CLI flags override config values. With no config file the CLI
 * behaves exactly like the original flag-only version: heal one spec, write
 * the fixes back, print human-readable progress.
 *
 * With --json, stdout carries exactly one JSON object and nothing else. The
 * output is deterministic: fixed key order, scan order preserved, no
 * timestamps.
 */

interface CliArgs {
  specPath?: string;
  configPath?: string;
  baseUrl?: string;
  project?: string;
  storageState?: string;
  authSetup?: string;
  authSetupTimeout?: number;
  settleMs?: number;
  routeOverrides: Array<{ file: string; route: string }>;
  scan: boolean;
  noTrace: boolean;
  dryRun: boolean;
  apply: boolean;
  yes: boolean;
  json: boolean;
  auditLog?: string;
  maxHeals?: number;
  verify?: boolean;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseCliArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const out: CliArgs = { scan: false, noTrace: false, dryRun: false, apply: false, yes: false, json: false, routeOverrides: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--scan') out.scan = true;
    else if (a === '--no-trace') out.noTrace = true;
    else if (a === '--config') out.configPath = args[++i];
    else if (a === '--base-url') out.baseUrl = args[++i];
    else if (a === '--project') out.project = args[++i];
    else if (a === '--storage-state') out.storageState = args[++i];
    else if (a === '--auth-setup') out.authSetup = args[++i];
    else if (a === '--auth-setup-timeout') {
      const s = Number(args[++i]);
      if (!Number.isFinite(s) || s <= 0) fail('--auth-setup-timeout expects a positive number of seconds.');
      out.authSetupTimeout = s * 1000;
    }
    else if (a === '--settle-ms') {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 0) fail('--settle-ms expects a non-negative number of milliseconds.');
      out.settleMs = n;
    }
    else if (a === '--route') {
      const v = args[++i];
      const eq = v?.indexOf('=') ?? -1;
      if (!v || eq <= 0) fail('--route expects <file>=<route>, e.g. --route pages/login-page.ts=/login');
      out.routeOverrides.push({ file: v.slice(0, eq), route: v.slice(eq + 1) });
    }
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--json') out.json = true;
    else if (a === '--audit-log') out.auditLog = args[++i];
    else if (a === '--max-heals') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 0) fail('--max-heals expects a non-negative integer.');
      out.maxHeals = n;
    } else if (a === '--verify') out.verify = true;
    else if (a === '--no-verify') out.verify = false;
    else if (!a.startsWith('--') && !out.specPath) out.specPath = a;
    else fail(`Unknown argument: ${a}`);
  }
  if (out.dryRun && out.apply) fail('Pass either --dry-run or --apply, not both.');
  return out;
}

/** Every *.spec.ts / *.spec.js under dir, recursive, sorted for determinism. */
function findSpecs(testDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.spec\.(ts|js)$/.test(e.name)) out.push(p);
    }
  };
  walk(testDir);
  return out.sort();
}

/**
 * Applying requires explicit consent: --yes/-y, or an interactive TTY
 * prompt. In a non-interactive context (no TTY, or --json output) the CLI
 * NEVER prompts: without --yes it declines, and the caller turns the run
 * into a preview that exits with code 2 ("heals available but not applied")
 * so a pipeline can detect it. A script can never write files by accident.
 */
async function confirmApply(cli: CliArgs, count: number): Promise<boolean> {
  if (cli.yes) return true;
  if (!cli.json && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      // y/Y/yes apply, n/no/empty decline; anything else re-prompts instead
      // of being silently treated as "no".
      for (;;) {
        const consent = parseConsent(await rl.question(`Apply ${count} heal(s)? [y/N] `));
        if (consent === 'yes') return true;
        if (consent === 'no') return false;
        console.log('Unrecognized input. Please answer y or n.');
      }
    } finally {
      rl.close();
    }
  }
  return false;
}

/** Nearest directory at or above the spec that holds a package.json. */
function projectRootFor(specPath: string): string {
  let dir = path.dirname(specPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(specPath);
    dir = parent;
  }
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv);
  const loaded = loadConfig(cli.configPath);
  const cfg = loaded?.config ?? {};
  const cfgDir = loaded?.dir ?? process.cwd();
  const fromCfg = (p: string): string => path.resolve(cfgDir, p);

  let specs: string[] = [];
  if (cli.specPath) specs = [path.resolve(cli.specPath)];
  else if (cfg.testDir) specs = findSpecs(fromCfg(cfg.testDir));
  if (specs.length === 0) {
    fail('Usage: qa-core-heal <spec-path> [flags], or set testDir in qa-core.config.json.');
  }

  // Flag > config > default, per field.
  const write = cli.dryRun ? false : cli.apply ? true : !(cfg.heal?.dryRunByDefault ?? false);
  const baseUrl = cli.baseUrl ?? cfg.baseUrl;

  // Reading a TypeScript playwright config needs Node's native type
  // stripping (22.6+). Gate ONLY the path that actually needs it: with an
  // explicit base URL, or a .js config, older Node keeps working.
  if (!baseUrl && !supportsTypeStripping()) {
    const roots = [process.cwd()];
    for (const spec of specs) {
      const root = projectRootFor(spec);
      if (!roots.includes(root)) roots.push(root);
    }
    if (roots.some((r) => findPlaywrightConfig(r)?.endsWith('.ts'))) {
      fail(typeStrippingGateMessage());
    }
  }
  const maxHeals = cli.maxHeals ?? cfg.heal?.maxHealsPerRun;
  const verify = cli.verify ?? cfg.heal?.verifyAfterApply ?? true;
  const allowedLevels = cfg.selectorPreference as CascadeLevel[] | undefined;
  const followImports = cfg.pageObjects?.enabled !== false;
  const pageObjectDirs = cfg.pageObjects?.dir ? [fromCfg(cfg.pageObjects.dir)] : undefined;
  // Authenticated probing: flag > qa-core.config.json auth.storageState;
  // with neither, heal auto-detects (playwright config use.storageState,
  // then conventional .auth paths). Only the file PATH is ever logged.
  const storageState = cli.storageState
    ? path.resolve(cli.storageState)
    : cfg.auth?.storageState
      ? fromCfg(cfg.auth.storageState)
      : undefined;
  const auditPath = cli.auditLog
    ? path.resolve(cli.auditLog)
    : cfg.audit?.logPath
      ? fromCfg(cfg.audit.logPath)
      : path.resolve('.qa-core/heal-log.jsonl');

  const say = (line: string): void => { if (!cli.json) console.log(line); };
  // Per-locator lines are grouped under their source file, so a spec that
  // imports several page objects reads as one block per file. Fresh state
  // per pass: the current-file marker must reset between preview and apply.
  const makeEventPrinter = (): ((e: HealEvent) => void) => {
    let currentFile: string | null = null;
    const fileHeader = (f: string): void => {
      if (f === currentFile) return;
      currentFile = f;
      say(`\n  ${f}:`);
    };
    return (e: HealEvent): void => {
      switch (e.type) {
        case 'scanned': say(`  · scanned ${e.total} locator(s) across ${e.files} file(s)`); break;
        case 'opened_page': say(`  · opened ${e.url}`); break;
        case 'healing': fileHeader(e.file); say(`    → broken: ${e.selector}`); break;
        case 'healed': fileHeader(e.file); say(`    ✓ healed to ${e.new}  (level=${e.level})`); break;
        case 'unhealed': fileHeader(e.file); say(`    ✗ unhealable: ${e.selector}\n        ${e.reason}`); break;
        case 'done': say(`\n  ${e.intact} intact · ${e.healed} healed · ${e.unhealed} unhealable (of ${e.total} scanned)\n`); break;
        default: break;
      }
    };
  };
  // ONE heal() call for the whole run: page objects shared between specs
  // are scanned once and probed on every importing spec's route. Events
  // (intact / healed / unhealable-with-reason) print in every human mode so
  // refusal reasons are never hidden behind a summary count.
  const runPass = async (writePass: boolean, events: boolean, targets?: HealTarget[]): Promise<HealResult> =>
    heal({
      specPaths: specs, baseUrl, project: cli.project, write: writePass, maxHeals, allowedLevels,
      followImports, pageObjectDirs, storageState, targets,
      authSetup: cli.authSetup ?? cfg.authSetup,
      authSetupTimeout: cli.authSetupTimeout,
      settleMs: cli.settleMs,
      routeOverrides: cli.routeOverrides.length > 0 ? cli.routeOverrides : undefined,
      onEvent: cli.json || !events ? undefined : makeEventPrinter(),
    });
  const sayHeader = (suffix: string): void => {
    if (specs.length === 1) say(`▸ Healing ${path.relative(process.cwd(), specs[0]!)}${suffix}`);
    else say(`▸ Healing ${specs.length} spec files jointly${suffix}`);
  };
  const printDiff = (proposed: LocatorReport[]): void => {
    if (cli.json) return;
    say(`\nProposed heals (${proposed.length}):\n`);
    for (const p of proposed) {
      say(`  ${p.file}:${p.line}`);
      say(`    - ${p.old}`);
      say(`    + ${p.new}`);
      say('');
    }
  };
  const writeAudit = (heals: HealResult['healed'], verifiedFor: (h: HealResult['healed'][number]) => boolean): void => {
    const auditEntries: AuditEntry[] = heals.map((h) => ({
      timestamp: new Date().toISOString(),
      file: path.relative(process.cwd(), h.file).split(path.sep).join('/'),
      line: h.line,
      old: h.old,
      new: h.new,
      level: h.level,
      ambiguous: false,
      verified: verifiedFor(h),
    }));
    if (auditEntries.length > 0) {
      appendAuditLog(auditPath, auditEntries);
      say(`▸ Audit log: ${auditEntries.length} entr${auditEntries.length === 1 ? 'y' : 'ies'} appended to ${path.relative(process.cwd(), auditPath)}`);
    }
  };

  if (!cli.scan) {
    await runFirstFlow({
      cli, specs, write, verify, say, runPass, printDiff, writeAudit,
    });
    return;
  }

  let result: HealResult;
  let applied = false; // files actually written this run

  if (!write) {
    sayHeader('  (dry run, no files written)');
    result = await runPass(false, true);
  } else {
    // Applying always previews first: probe everything without writing —
    // printing the same per-locator detail as dry-run — then show the full
    // proposed diff and only write after explicit consent.
    sayHeader('  (preview pass, no files written yet)');
    const preview = await runPass(false, true);
    const proposed = preview.locators.filter((l) => l.status === 'healed');
    if (proposed.length === 0) {
      say('Nothing to heal. No files written.');
      result = preview;
    } else {
      if (!cli.json) {
        say(`\nProposed heals (${proposed.length}):\n`);
        for (const p of proposed) {
          say(`  ${p.file}:${p.line}`);
          say(`    - ${p.old}`);
          say(`    + ${p.new}`);
          say('');
        }
      }
      const confirmed = await confirmApply(cli, proposed.length);
      if (confirmed) {
        say('▸ Applying heals');
        result = await runPass(true, false);
        applied = true;
      } else {
        // Declined at the prompt, or non-interactive without --yes: the
        // preview above is the deliverable. Exit code 2 tells pipelines
        // "heals available but not applied".
        say('Heals available but not applied. No files written. Pass --yes (or -y) to apply without prompting.');
        result = preview;
        process.exitCode = 2;
      }
    }
  }
  const locators = result.locators;

  // Audit log entries are written only when heals were actually applied.
  if (applied && result.healed.length > 0) {
    const healedFiles = new Set(result.healed.map((h) => h.file));
    // Verify each spec whose gathered files (itself or its page objects)
    // received a heal. A heal in a shared page object counts as verified
    // only when EVERY spec that uses it passes its re-run.
    const verifiedBySpec = new Map<string, boolean>();
    if (verify) {
      for (const spec of specs) {
        const gathered = result.specFiles[spec] ?? [];
        if (!gathered.some((f) => healedFiles.has(f))) continue;
        const root = projectRootFor(spec);
        const rel = path.relative(root, spec);
        say(`▸ Verifying ${rel} with a re-run`);
        const run = spawnSync('npx', ['playwright', 'test', rel], {
          cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
        });
        verifiedBySpec.set(spec, run.status === 0);
        say(run.status === 0 ? '  ✓ re-run passed' : '  ✗ re-run FAILED (audit entries record verified=false)');
      }
    }
    writeAudit(result.healed, (h) => {
      const owners = specs.filter((sp) => (result.specFiles[sp] ?? []).includes(h.file));
      return verify && owners.length > 0 && owners.every((sp) => verifiedBySpec.get(sp) === true);
    });
  }

  if (cli.json) {
    const count = (s: LocatorReport['status']): number => locators.filter((l) => l.status === s).length;
    const payload = {
      // True whenever this run wrote no files (dry-run, nothing to heal,
      // or heals available but not confirmed).
      dryRun: !applied,
      scanned: locators.length,
      healed: count('healed'),
      intact: count('intact'),
      refused: count('refused'),
      locators,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const count = (s: LocatorReport['status']): number => locators.filter((l) => l.status === s).length;
    say(`Done. ${count('intact')} intact · ${count('healed')} healed · ${count('refused')} refused (${locators.length} locators across ${specs.length} spec file(s)).`);
  }
}

interface RunFirstCtx {
  cli: CliArgs;
  specs: string[];
  write: boolean;
  verify: boolean;
  say: (line: string) => void;
  runPass: (writePass: boolean, events: boolean, targets?: HealTarget[]) => Promise<HealResult>;
  printDiff: (proposed: LocatorReport[]) => void;
  writeAudit: (heals: HealResult['healed'], verifiedFor: (h: HealResult['healed'][number]) => boolean) => void;
}

/**
 * Default (run-first) mode: run the specs, heal only what actually failed
 * for locator reasons, on the page each test was on when it failed.
 */
async function runFirstFlow(ctx: RunFirstCtx): Promise<void> {
  const { cli, specs, write, verify, say, runPass, printDiff, writeAudit } = ctx;
  const root = projectRootFor(specs[0]!);
  const rels = specs.map((s) => path.relative(root, s));

  say(`▸ Running ${rels.length === 1 ? rels[0]! : `${rels.length} spec files`} to find failures`);
  // --no-trace: for setups where tracing is unavailable or unwanted (custom
  // browser launches, older Playwright); failure URLs then come from static
  // route inference, or the locator is refused when no route is knowable.
  const traceArgs = cli.noTrace ? [] : ['--trace', 'retain-on-failure'];
  const run = spawnSync('npx', ['playwright', 'test', ...rels, '--reporter=json', ...traceArgs], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
  });
  const report = parseJsonReport(run.stdout ?? '') as { config?: { rootDir?: string } } | null;
  if (!report) {
    fail(`Could not run the Playwright tests (no JSON report). ${String(run.stderr ?? '').split('\n')[0] ?? ''}`);
  }
  const tests = collectTests(report as Parameters<typeof collectTests>[0]);
  if (tests.length === 0) {
    fail(`Playwright reported no tests for ${rels.join(', ')} — check the spec path and playwright config.`);
  }
  const failing = tests.filter((t) => !t.ok);

  const emit = (
    result: HealResult | null,
    applied: boolean,
    nonLocator: Array<{ test: string; reason: string }>,
    unmatchedTargets: HealTarget[] = [],
  ): void => {
    const locators = result?.locators ?? [];
    const count = (s: LocatorReport['status']): number => locators.filter((l) => l.status === s).length;
    if (cli.json) {
      console.log(JSON.stringify({
        dryRun: !applied,
        scanned: locators.length,
        healed: count('healed'),
        intact: count('intact'),
        refused: count('refused'),
        locators,
        nonLocatorFailures: nonLocator,
        unmatchedFailures: unmatchedTargets.map((u) => ({ selector: u.selector, test: u.test ?? null })),
      }, null, 2));
    } else if (result) {
      const skipped = nonLocator.length > 0 ? ` · ${nonLocator.length} non-locator failure(s) skipped` : '';
      say(`Done. ${count('intact')} intact · ${count('healed')} healed · ${count('refused')} refused (${locators.length} failing locator(s) probed)${skipped}.`);
    }
  };

  // 1. All green: nothing to do, and nothing was probed or scanned.
  if (failing.length === 0) {
    say('All tests passing. Nothing to heal.');
    if (cli.json) emit(null, false, []);
    return;
  }

  // 2. Classify each failure: only locator failures are heal candidates.
  say(`  ${failing.length} of ${tests.length} test(s) failing\n`);
  const targets: HealTarget[] = [];
  const locatorTests: TestOutcome[] = [];
  const nonLocator: Array<{ test: string; reason: string }> = [];
  for (const t of failing) {
    const c = classifyFailure(t.message);
    if (c.kind === 'locator' && c.selector) {
      const url = !cli.noTrace && t.tracePath ? traceFailureUrl(t.tracePath) : null;
      targets.push({
        selector: c.selector,
        url: url ?? undefined,
        test: t.title,
        locations: t.locations,
      });
      locatorTests.push(t);
      say(`  → ${t.title} — locator failure: ${c.selector}${url ? `  (page: ${url})` : ''}`);
    } else {
      const reason = c.kind === 'other' ? c.summary : 'locator failure, but the selector could not be extracted';
      nonLocator.push({ test: t.title, reason });
      say(`  ✗ ${t.title} — not a locator problem, healing won't fix this\n      ${reason}`);
    }
  }
  if (targets.length === 0) {
    say('\nNo locator failures to heal.');
    emit(null, false, nonLocator);
    return;
  }

  // 3. Probe ONLY the failing selectors, each on its failure-time page.
  say(`\n▸ Probing ${targets.length} failing locator(s) on their failure page(s)${write ? '' : '  (dry run, no files written)'}`);
  const preview = await runPass(false, true, targets);
  // A failing locator we could not find in the source is OUR bug, not a
  // clean bill of health: name it loudly and exit non-zero. Never print
  // "Nothing to heal" while these exist.
  const unmatched = preview.unmatchedTargets;
  if (unmatched.length > 0) {
    say('');
    for (const u of unmatched) {
      say(`✗ 1 failing locator could not be matched to source: ${u.selector} (from ${u.test ?? 'unknown test'}). This is a bug worth reporting.`);
    }
  }
  let result = preview;
  let applied = false;
  const proposed = preview.locators.filter((l) => l.status === 'healed');
  if (write && proposed.length === 0) {
    if (unmatched.length === 0) say('Nothing to heal. No files written.');
  } else if (write) {
    printDiff(proposed);
    const confirmed = await confirmApply(cli, proposed.length);
    if (confirmed) {
      say('▸ Applying heals');
      result = await runPass(true, false, targets);
      applied = true;
    } else {
      say('Heals available but not applied. No files written. Pass --yes (or -y) to apply without prompting.');
      process.exitCode = 2;
    }
  }

  // 4. Verify by re-running ONLY the previously failing locator tests.
  let rerunPassed: boolean | null = null;
  if (applied && verify && result.healed.length > 0) {
    const rootDir = report.config?.rootDir ?? root;
    const fileArgs = [...new Set(locatorTests.map((t) => path.relative(root, path.resolve(rootDir, t.file))))];
    const grep = locatorTests.map((t) => escapeRegex(t.title)).join('|');
    say(`▸ Verifying: re-running ${locatorTests.length} previously failing test(s)`);
    const rerun = spawnSync('npx', ['playwright', 'test', ...fileArgs, '--grep', grep], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32',
    });
    rerunPassed = rerun.status === 0;
    say(rerunPassed ? '  ✓ re-run passed' : '  ✗ re-run FAILED (audit entries record verified=false)');
  }
  if (applied && result.healed.length > 0) {
    writeAudit(result.healed, () => verify && rerunPassed === true);
  }
  emit(result, applied, nonLocator, unmatched);
  // Unmatched targets are a bug in heal's matching, not a user mistake:
  // exit 1 (takes precedence over the not-applied exit 2).
  if (unmatched.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
