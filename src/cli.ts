#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { applyHealPlan, applyHealPlanExcluding, collectSpecFiles, heal, selectorSignature, type HealEvent, type HealResult, type HealTarget, type LocatorReport } from './heal.js';
import { escapeRegex, type CascadeLevel } from './selectors.js';
import { loadConfig } from './config.js';
import { appendAuditLog, type AuditEntry } from './audit.js';
import { findPlaywrightConfig, supportsTypeStripping, typeStrippingGateMessage } from './playwright-config.js';
import { classifyFailure, collectTests, parseConsent, parseJsonReport, traceFailureUrl, type TestOutcome } from './run.js';
import { describeFailedRun, runPlaywrightCli, toCliFileFilter } from './playwright-cli.js';

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
 * --auth-setup <file>#<export> (or <file>:<export>, zsh-friendly; default
 * export when no separator; also settable as authSetup in
 * qa-core.config.json) runs the user's OWN login function against a fresh
 * page in the probing context before probing: `await fn(page)`. When a
 * storage state is ALSO present (flag, config, or auto-detected), the
 * saved session is used first — fast, runs no user code — and the auth
 * setup is the automatic fallback when that session turns out expired
 * ("saved session expired; falling back to auth setup"); never the
 * reverse direction. A throw or timeout (60s default,
 * --auth-setup-timeout <seconds>) fails the run loudly — never a silent
 * unauthenticated probe. Only file paths, export names, and pass/fail are
 * logged; credentials, cookie values, and storage contents never are.
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
 * element not found, strict mode violation, a count/existence assertion
 * that found ZERO elements) are healed by probing ONLY the failing
 * selectors on the page URL each test was on when it failed (from the
 * trace); everything else (assertion value mismatch on a found element,
 * count mismatch with actual > 0, navigation/network errors, thrown app
 * errors) is reported as not a locator problem and never healed. After
 * applying, only the previously failing tests are re-run to verify.
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
  help: boolean;
  version: boolean;
  /** --verbose, or implied by --debug. */
  verbose: boolean;
  debug: boolean;
  output?: string;
  /** --no-color flag, or the NO_COLOR env var. Output is colorless today;
   *  the flag is honored so that never silently changes. */
  noColor: boolean;
}

/**
 * Detected before parsing so even a parse-time failure can honor the
 * machine-readable contract: with --json anywhere on the argv, errors go
 * to stdout as valid JSON (the human message stays on stderr).
 */
const jsonErrorMode = process.argv.includes('--json');

function fail(msg: string): never {
  if (jsonErrorMode) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      error: msg,
      verdicts: [],
      summary: { heals: 0, refusals: 0, nonLocator: 0, errors: 1 },
    }, null, 2));
  }
  console.error(msg);
  process.exit(1);
}

const HELP = `qa-core-heal — deterministic selector healing for Playwright specs

Usage:
  qa-core-heal [spec-path] [flags]

Example:
  qa-core-heal tests/checkout.spec.ts --dry-run

Flags:
  -h, --help                     show this help and exit
  -v, --version                  print the version and exit
      --scan                     static probe: every locator on its inferred route, no test execution
      --dry-run                  classify and propose heals, print the exact diff, write nothing, skip the verify re-run
      --apply                    write approved heals to source files (always previews the diff first)
  -y, --yes                      auto-approve the apply prompt for EVIDENCE-BASED HEALS ONLY. This flag
                                 will never cover suggestion-level changes; those will require a separate
                                 --accept-suggestions (future).
      --json                     machine-readable result on stdout (schemaVersion 1) instead of human text
      --output <path>            additionally write the human run report to the given file; stdout unchanged
      --verbose                  detailed progress: probe steps, candidate scoring, child commands executed
      --debug                    implies --verbose; adds stack traces and raw child stdout/stderr
      --config <file>            use this config file instead of the default qa-core.config.json lookup
      --base-url <url>           base URL of the app under test (overrides config and playwright.config)
      --project <name>           playwright project to take use.baseURL from when projects disagree
      --route <file>=<route>     override the inferred route for a spec or page-object file (repeatable)
      --storage-state <path>     probe with a saved Playwright session
      --auth-setup <file>#<fn>   run your own login function before probing (file:fn also works)
      --auth-setup-timeout <s>   seconds before a hanging auth setup fails the run (default 60)
      --settle-ms <ms>           cap on the mutation-quiet settle before candidate collection (default 2000)
      --max-heals <n>            refuse any heal beyond the first n
      --verify / --no-verify     re-run previously failing tests after applying (default on)
      --no-trace                 skip Playwright tracing; failure URLs come from route inference
      --audit-log <path>         append applied heals to this JSONL file
      --no-color                 disable ANSI colors (the NO_COLOR env var is honored automatically)

Exit codes: 0 success · 1 error, or a heal was reverted because its
verify re-run still failed · 2 heals available but not applied.
`;

function parseCliArgs(argv: string[]): CliArgs {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        scan: { type: 'boolean' },
        'no-trace': { type: 'boolean' },
        config: { type: 'string' },
        'base-url': { type: 'string' },
        project: { type: 'string' },
        'storage-state': { type: 'string' },
        'auth-setup': { type: 'string' },
        'auth-setup-timeout': { type: 'string' },
        'settle-ms': { type: 'string' },
        route: { type: 'string', multiple: true },
        'dry-run': { type: 'boolean' },
        apply: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        json: { type: 'boolean' },
        'audit-log': { type: 'string' },
        'max-heals': { type: 'string' },
        verify: { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        verbose: { type: 'boolean' },
        debug: { type: 'boolean' },
        output: { type: 'string' },
        'no-color': { type: 'boolean' },
      },
    }));
  } catch (e) {
    // parseArgs appends a long positional-escaping hint; the first
    // sentence carries the actual problem.
    const first = (e as Error).message.split(/\.\s/)[0]!.replace(/\.$/, '');
    fail(`${first}. Run qa-core-heal --help for usage.`);
  }
  const v = values as Record<string, string | boolean | string[] | undefined>;
  const out: CliArgs = {
    scan: v.scan === true,
    noTrace: v['no-trace'] === true,
    dryRun: v['dry-run'] === true,
    apply: v.apply === true,
    yes: v.yes === true,
    json: v.json === true,
    routeOverrides: [],
    help: v.help === true,
    version: v.version === true,
    debug: v.debug === true,
    verbose: v.verbose === true || v.debug === true,
    noColor: v['no-color'] === true || (process.env.NO_COLOR ?? '') !== '',
  };
  out.configPath = v.config as string | undefined;
  out.baseUrl = v['base-url'] as string | undefined;
  out.project = v.project as string | undefined;
  out.storageState = v['storage-state'] as string | undefined;
  out.authSetup = v['auth-setup'] as string | undefined;
  out.auditLog = v['audit-log'] as string | undefined;
  out.output = v.output as string | undefined;
  if (v['auth-setup-timeout'] !== undefined) {
    const s = Number(v['auth-setup-timeout']);
    if (!Number.isFinite(s) || s <= 0) fail('--auth-setup-timeout expects a positive number of seconds.');
    out.authSetupTimeout = s * 1000;
  }
  if (v['settle-ms'] !== undefined) {
    const n = Number(v['settle-ms']);
    if (!Number.isFinite(n) || n < 0) fail('--settle-ms expects a non-negative number of milliseconds.');
    out.settleMs = n;
  }
  for (const r of (v.route as string[] | undefined) ?? []) {
    const eq = r.indexOf('=');
    if (eq <= 0) fail('--route expects <file>=<route>, e.g. --route pages/login-page.ts=/login');
    out.routeOverrides.push({ file: r.slice(0, eq), route: r.slice(eq + 1) });
  }
  if (v['max-heals'] !== undefined) {
    const n = Number(v['max-heals']);
    if (!Number.isInteger(n) || n < 0) fail('--max-heals expects a non-negative integer.');
    out.maxHeals = n;
  }
  if (v['no-verify'] === true) out.verify = false;
  else if (v.verify === true) out.verify = true;
  out.specPath = positionals[0];
  if (positionals.length > 1) fail(`Unknown argument: ${positionals[1]}`);
  if (out.dryRun && out.apply) fail('Pass either --dry-run or --apply, not both.');
  return out;
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

/** One row of the schemaVersion-1 verdicts array (see README contract). */
interface Verdict {
  spec: string;
  testTitle: string | null;
  classification: 'locator' | 'non-locator';
  message: string | null;
  healApplied: boolean;
  before: string | null;
  after: string | null;
  verified: boolean | null;
  /** The heal was applied but undone: its verify re-run still failed. */
  reverted: boolean;
  /** Set when reverted: why the re-run still failed. 'non-locator' means
   *  the healed locator resolves and the heal may well be correct. */
  revertReason: 'locator' | 'non-locator' | null;
}

function locatorVerdict(
  l: LocatorReport,
  applied: boolean,
  testTitle: string | null,
  verified: boolean | null,
): Verdict {
  return {
    spec: l.file,
    testTitle,
    classification: 'locator',
    message: l.reason ?? (l.status === 'intact' ? 'intact' : null),
    healApplied: l.status === 'healed' && applied,
    before: l.old,
    after: l.status === 'healed' ? l.new : null,
    verified: l.status === 'healed' ? verified : null,
    reverted: false,
    revertReason: null,
  };
}

/** --verbose/--debug reporting around child Playwright runs. Extra lines
 *  only, on stderr — verdicts and messages stay untouched. */
function logChildRun(cli: CliArgs, run: ReturnType<typeof runPlaywrightCli>): void {
  if (cli.verbose) console.error(`[verbose] child: ${run.command} (exit ${run.status ?? 'spawn-error'})`);
  if (cli.debug) {
    if (run.stdout) console.error(`[debug] child stdout:\n${run.stdout}`);
    if (run.stderr) console.error(`[debug] child stderr:\n${run.stderr}`);
  }
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
  if (cli.help) {
    console.log(HELP);
    return;
  }
  if (cli.version) {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    console.log(pkg.version);
    return;
  }
  const loaded = loadConfig(cli.configPath);
  const cfg = loaded?.config ?? {};
  const cfgDir = loaded?.dir ?? process.cwd();
  const fromCfg = (p: string): string => path.resolve(cfgDir, p);

  // A DIRECTORY target is walked for spec files, never read as a file:
  // "qa-core-heal tests/systematic" used to push the directory itself into
  // readFileSync and die with a bare EISDIR.
  const verboseNote = cli.verbose ? (line: string): void => console.error(line) : undefined;
  let specs: string[] = [];
  if (cli.specPath) {
    const target = path.resolve(cli.specPath);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      specs = collectSpecFiles(target, verboseNote);
      if (specs.length === 0) {
        fail(`No spec files (*.spec.ts/js, *.test.ts/js) found under directory: ${target}`);
      }
    } else {
      specs = [target];
    }
  } else if (cfg.testDir) {
    specs = collectSpecFiles(fromCfg(cfg.testDir), verboseNote);
  }
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

  // The human report, teed to --output when given; stdout is unchanged.
  const reportLines: string[] = [];
  const say = (line: string): void => {
    if (cli.json) return;
    console.log(line);
    reportLines.push(line);
  };
  if (cli.output) {
    const outPath = path.resolve(cli.output);
    process.on('exit', () => {
      try { fs.writeFileSync(outPath, reportLines.join('\n') + '\n'); } catch { /* best effort */ }
    });
  }
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
      verbose: cli.verbose,
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
  const writeAudit = (
    heals: HealResult['healed'],
    verifiedFor: (h: HealResult['healed'][number]) => boolean,
    revertedFor: (h: HealResult['healed'][number]) => boolean = () => false,
    revertReasonFor: (h: HealResult['healed'][number]) => 'locator' | 'non-locator' | undefined = () => undefined,
  ): void => {
    const auditEntries: AuditEntry[] = heals.map((h) => ({
      timestamp: new Date().toISOString(),
      file: path.relative(process.cwd(), h.file).split(path.sep).join('/'),
      line: h.line,
      old: h.old,
      new: h.new,
      level: h.level,
      ambiguous: false,
      // The heal WAS written; a revert does not erase that history.
      applied: true,
      verified: verifiedFor(h),
      reverted: revertedFor(h),
      ...(revertedFor(h) ? { revertReason: revertReasonFor(h) ?? 'locator' } : {}),
    }));
    if (auditEntries.length > 0) {
      appendAuditLog(auditPath, auditEntries);
      say(`▸ Audit log: ${auditEntries.length} entr${auditEntries.length === 1 ? 'y' : 'ies'} appended to ${path.relative(process.cwd(), auditPath)}`);
    }
  };

  if (!cli.scan) {
    await runFirstFlow({
      cli, specs, write, verify, say, runPass, printDiff, writeAudit,
      displayTarget: cli.specPath,
    });
    return;
  }

  let result: HealResult;
  let applied = false; // files actually written this run

  if (!write) {
    sayHeader('  (dry run, no files written)');
    result = await runPass(false, true);
    // The explicit --dry-run FLAG (not config dryRunByDefault, which must
    // keep today's byte-identical output) also prints the exact would-be
    // diff and states its own contract.
    if (cli.dryRun) {
      const proposed = result.locators.filter((l) => l.status === 'healed');
      if (proposed.length > 0) printDiff(proposed);
      say('dry run: no files changed, heal not verified');
    }
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
        // Apply the PREVIEWED plan, never a re-probe: consent (--yes or
        // the prompt) can only ever gate this write. A second probe could
        // reach a different verdict than the diff the user just approved.
        const written = applyHealPlan(preview.plan);
        result = {
          ...preview,
          filesWritten: written,
          healedPath: specs.find((sp) => written.includes(sp)) ?? written[0] ?? null,
        };
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
  // Heals reverted after a failed per-spec verify, keyed "file|line" (the
  // report-relative file), for the JSON verdicts.
  const scanRevertedKeys = new Set<string>();
  const scanRevertReasonByKey = new Map<string, 'locator' | 'non-locator'>();

  // Audit log entries are written only when heals were actually applied.
  if (applied && result.healed.length > 0) {
    const healedFiles = new Set(result.healed.map((h) => h.file));
    // Verify each spec whose gathered files (itself or its page objects)
    // received a heal. A heal in a shared page object counts as verified
    // only when EVERY spec that uses it passes its re-run.
    const verifiedBySpec = new Map<string, boolean>();
    // Why a failing verify re-run failed: 'non-locator' only when EVERY
    // failing test in the spec classifies non-locator (assertion/app/
    // navigation) — any locator-classified failure keeps 'locator'.
    const revertReasonBySpec = new Map<string, { reason: 'locator' | 'non-locator'; line?: string }>();
    if (verify) {
      for (const spec of specs) {
        const gathered = result.specFiles[spec] ?? [];
        if (!gathered.some((f) => healedFiles.has(f))) continue;
        const root = projectRootFor(spec);
        const rel = path.relative(root, spec);
        say(`▸ Verifying ${rel} with a re-run`);
        const run = runPlaywrightCli(root, ['test', toCliFileFilter(rel), '--reporter=json'], 32 * 1024 * 1024);
        logChildRun(cli, run);
        verifiedBySpec.set(spec, run.status === 0);
        if (run.status !== 0) {
          let reason: 'locator' | 'non-locator' = 'locator';
          let line: string | undefined;
          const rep = parseJsonReport(run.stdout ?? '');
          if (rep) {
            const failing = collectTests(rep as Parameters<typeof collectTests>[0]).filter((x) => !x.ok);
            const classes = failing.map((x) => classifyFailure(x.message));
            if (classes.length > 0 && classes.every((c) => c.kind === 'other')) {
              reason = 'non-locator';
              line = classes.find((c) => c.kind === 'other' && c.summary)?.summary;
            }
          }
          revertReasonBySpec.set(spec, { reason, line });
        }
        say(run.status === 0 ? '  ✓ re-run passed' : '  ✗ re-run FAILED (audit entries record verified=false)');
      }
    }
    // Revert contract (scan-mode granularity: PER SPEC — without test
    // execution there is no per-test signal, so a heal is reverted when
    // ANY spec that owns its file still fails after applying). The audit
    // keeps the full history: applied:true, verified:false, reverted:true.
    const revertedHeals = new Set<HealResult['healed'][number]>();
    if (verify) {
      for (const h of result.healed) {
        const owners = specs.filter((sp) => (result.specFiles[sp] ?? []).includes(h.file));
        if (owners.some((sp) => verifiedBySpec.get(sp) === false)) revertedHeals.add(h);
      }
      if (revertedHeals.size > 0) {
        applyHealPlanExcluding(result.plan, (file, edit) =>
          [...revertedHeals].some((h) => h.file === file && h.line === edit.line && h.new === edit.newRaw));
        for (const h of revertedHeals) {
          const rel = path.relative(process.cwd(), h.file).split(path.sep).join('/');
          const owners = specs.filter((sp) => (result.specFiles[sp] ?? []).includes(h.file));
          const infos = owners.map((sp) => revertReasonBySpec.get(sp)).filter((x) => x != null);
          const info = infos.length > 0 && infos.every((x) => x!.reason === 'non-locator')
            ? { reason: 'non-locator' as const, line: infos.find((x) => x!.line)?.line }
            : { reason: 'locator' as const };
          scanRevertedKeys.add(`${rel}|${h.line}`);
          scanRevertReasonByKey.set(`${rel}|${h.line}`, info.reason);
          if (info.reason === 'non-locator') {
            say(`✗ heal reverted: the re-run still fails, but no longer for a locator reason${info.line ? ` (${info.line})` : ''}. `
              + `The heal may be correct; the remaining failure looks like a test or app problem. — ${rel}:${h.line} ${h.old}`);
          } else {
            say(`✗ heal reverted: re-run still failing after heal — ${rel}:${h.line} ${h.old}`);
          }
        }
        say(`${revertedHeals.size} heal(s) reverted: re-run still failing after heal`);
        process.exitCode = 1;
      }
    }
    writeAudit(result.healed, (h) => {
      const owners = specs.filter((sp) => (result.specFiles[sp] ?? []).includes(h.file));
      return verify && owners.length > 0 && owners.every((sp) => verifiedBySpec.get(sp) === true);
    }, (h) => revertedHeals.has(h),
    (h) => scanRevertReasonByKey.get(`${path.relative(process.cwd(), h.file).split(path.sep).join('/')}|${h.line}`));
  }

  if (cli.json) {
    const count = (s: LocatorReport['status']): number => locators.filter((l) => l.status === s).length;
    const payload = {
      // schemaVersion 1 is the compatibility contract (see README); the
      // legacy keys below it are kept verbatim for existing consumers.
      schemaVersion: 1,
      // True whenever this run wrote no files (dry-run, nothing to heal,
      // or heals available but not confirmed).
      dryRun: !applied,
      scanned: locators.length,
      healed: count('healed'),
      intact: count('intact'),
      refused: count('refused'),
      locators,
      verdicts: locators.map((l) => {
        const reverted = scanRevertedKeys.has(`${l.file}|${l.line}`);
        return {
          ...locatorVerdict(l, applied, null, reverted ? false : null),
          reverted,
          revertReason: reverted ? (scanRevertReasonByKey.get(`${l.file}|${l.line}`) ?? 'locator') : null,
        };
      }),
      summary: { heals: count('healed'), refusals: count('refused'), nonLocator: 0, errors: result.fileErrors.length },
      fileErrors: result.fileErrors,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const count = (s: LocatorReport['status']): number => locators.filter((l) => l.status === s).length;
    say(`Done. ${count('intact')} intact · ${count('healed')} healed · ${count('refused')} refused (${locators.length} locators across ${specs.length} spec file(s)).`);
    if (result.fileErrors.length > 0) {
      say(`${result.fileErrors.length} locator(s) skipped due to file errors`);
    }
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
  writeAudit: (
    heals: HealResult['healed'],
    verifiedFor: (h: HealResult['healed'][number]) => boolean,
    revertedFor?: (h: HealResult['healed'][number]) => boolean,
    revertReasonFor?: (h: HealResult['healed'][number]) => 'locator' | 'non-locator' | undefined,
  ) => void;
  /** The spec target exactly as the user typed it, for the run echo. */
  displayTarget?: string;
}

/**
 * Default (run-first) mode: run the specs, heal only what actually failed
 * for locator reasons, on the page each test was on when it failed.
 */
async function runFirstFlow(ctx: RunFirstCtx): Promise<void> {
  const { cli, specs, write, verify, say, runPass, printDiff, writeAudit } = ctx;
  const root = projectRootFor(specs[0]!);
  // Display form: forward slashes, unescaped. Child filters go through
  // toCliFileFilter at the spawn sites.
  const rels = specs.map((s) => path.relative(root, s).split(path.sep).join('/'));

  // The echo shows what the USER typed (verbatim, their separators), never
  // a converted form; testDir-derived runs keep the derived description.
  say(`▸ Running ${ctx.displayTarget ?? (rels.length === 1 ? rels[0]! : `${rels.length} spec files`)} to find failures`);
  // --no-trace: for setups where tracing is unavailable or unwanted (custom
  // browser launches, older Playwright); failure URLs then come from static
  // route inference, or the locator is refused when no route is knowable.
  const traceArgs = cli.noTrace ? [] : ['--trace', 'retain-on-failure'];
  const run = runPlaywrightCli(root, ['test', ...rels.map(toCliFileFilter), '--reporter=json', ...traceArgs], 64 * 1024 * 1024);
  logChildRun(cli, run);
  const report = parseJsonReport(run.stdout ?? '') as { config?: { rootDir?: string } } | null;
  if (!report) {
    // The child's failure story travels whole: the exact command, the
    // spawn error code or exit status, and the stderr tail. A bare
    // "could not run" would leave a Windows ENOENT indistinguishable
    // from a broken config.
    fail(`Could not run the Playwright tests (no JSON report). ${describeFailedRun(run)}`);
  }
  const tests = collectTests(report as Parameters<typeof collectTests>[0]);
  if (tests.length === 0) {
    fail(`Playwright reported no tests for ${rels.join(', ')} — check the spec path and playwright config.`);
  }
  const failing = tests.filter((t) => !t.ok);

  // Declared before emit(): the all-green path emits with these still
  // empty, and emit's title lookup closes over `targets`.
  const targets: HealTarget[] = [];
  const locatorTests: TestOutcome[] = [];
  const nonLocator: Array<{ test: string; reason: string; file?: string }> = [];
  // Heals reverted because their test still failed after applying,
  // keyed "file|line" — feeds the verdicts and the audit.
  const revertedKeys = new Set<string>();
  // Why each reverting re-run failed: 'locator' (the heal did not fix the
  // lookup) or 'non-locator' (the healed locator resolves; the remaining
  // failure is an assertion/app/navigation problem). Keyed both by test
  // title (classification time) and by "file|line" (verdict/audit time).
  const revertReasonByTitle = new Map<string, { reason: 'locator' | 'non-locator'; line?: string }>();
  const revertReasonByKey = new Map<string, 'locator' | 'non-locator'>();
  // Test titles for locator verdicts and per-test verification, matched
  // structurally (the same signature the healer uses).
  const titleFor = (old: string): string | null => {
    const sig = selectorSignature(old.replace(/^(?:this\.)?page\./, ''));
    if (!sig) return null;
    for (const t of targets) {
      if (t.test && selectorSignature(t.selector) === sig) return t.test;
    }
    return null;
  };

  const emit = (
    result: HealResult | null,
    applied: boolean,
    nonLocator: Array<{ test: string; reason: string; file?: string }>,
    unmatchedTargets: Array<HealTarget & { shape?: 'chained' | 'dynamic' | 'unknown' }> = [],
    rerunPassed: boolean | null = null,
  ): void => {
    const locators = result?.locators ?? [];
    const count = (s: LocatorReport['status']): number => locators.filter((l) => l.status === s).length;
    if (cli.json) {
      const verdicts: Verdict[] = [
        ...locators.map((l) => {
          const reverted = revertedKeys.has(`${l.file}|${l.line}`);
          const v = locatorVerdict(
            l, applied, titleFor(l.old),
            reverted ? false : (applied && verify ? rerunPassed : null),
          );
          return {
            ...v,
            reverted,
            revertReason: reverted ? (revertReasonByKey.get(`${l.file}|${l.line}`) ?? 'locator') : null,
          };
        }),
        ...nonLocator.map((n) => ({
          spec: n.file ?? '',
          testTitle: n.test,
          classification: 'non-locator' as const,
          message: n.reason,
          healApplied: false,
          before: null,
          after: null,
          verified: null,
          reverted: false,
          revertReason: null,
        })),
      ];
      console.log(JSON.stringify({
        schemaVersion: 1,
        dryRun: !applied,
        scanned: locators.length,
        healed: count('healed'),
        intact: count('intact'),
        refused: count('refused'),
        locators,
        nonLocatorFailures: nonLocator,
        unmatchedFailures: unmatchedTargets.map((u) => ({ selector: u.selector, test: u.test ?? null, shape: u.shape ?? 'unknown' })),
        verdicts,
        summary: {
          heals: count('healed'),
          refusals: count('refused'),
          nonLocator: nonLocator.length,
          // Chained/dynamic unmatched are a documented limitation, not a
          // tool error; only unknown-shape unmatched count here.
          errors: unmatchedTargets.filter((u) => u.shape !== 'chained' && u.shape !== 'dynamic').length
            + (result?.fileErrors.length ?? 0),
        },
        fileErrors: result?.fileErrors ?? [],
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
  for (const t of failing) {
    const c = classifyFailure(t.message);
    if (c.kind === 'locator' && c.selector) {
      const url = !cli.noTrace && t.tracePath ? traceFailureUrl(t.tracePath) : null;
      targets.push({
        selector: c.selector,
        url: url ?? undefined,
        test: t.title,
        locations: t.locations,
        strict: c.strict,
        chained: c.chained,
      });
      locatorTests.push(t);
      say(`  → ${t.title} — locator failure: ${c.selector}${url ? `  (page: ${url})` : ''}`);
    } else {
      const reason = c.kind === 'other' ? c.summary : 'locator failure, but the selector could not be extracted';
      nonLocator.push({ test: t.title, reason, file: t.file });
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
  // "Nothing to heal" while these exist. EXCEPT: a target whose source
  // file could not be read at all was already reported as a file error —
  // that is a skipped locator, not a matching bug.
  const erroredFiles = new Set(preview.fileErrors.map((f) => path.resolve(f.path)));
  const fileSkipped = preview.unmatchedTargets.filter((u) =>
    u.locations?.some((l) => erroredFiles.has(path.resolve(l.file))));
  const unmatched = preview.unmatchedTargets.filter((u) => !fileSkipped.includes(u));
  // "Bug worth reporting" only ever fires for a literal, matchable-looking
  // call that genuinely failed to match. Chained and dynamically built
  // locators are a documented limitation and get the honest teaching
  // message instead.
  const unknownUnmatched = unmatched.filter((u) => u.shape !== 'chained' && u.shape !== 'dynamic');
  if (unmatched.length > 0) {
    say('');
    for (const u of unmatched) {
      if (u.shape === 'chained' || u.shape === 'dynamic') {
        const how = u.shape === 'chained'
          ? 'by chaining (a .locator()/.getBy…() call on another locator)'
          : 'dynamically (a variable, template, or concatenated selector)';
        say(`✗ could not heal ${u.selector} (from ${u.test ?? 'unknown test'}): this locator appears to be built ${how}; only literal top-level locator calls (page.locator('…'), page.getByRole(…)) can be matched and healed`);
      } else {
        say(`✗ 1 failing locator could not be matched to source: ${u.selector} (from ${u.test ?? 'unknown test'}). This is a bug worth reporting.`);
      }
    }
  }
  let result = preview;
  let applied = false;
  const proposed = preview.locators.filter((l) => l.status === 'healed');
  // The explicit --dry-run FLAG also prints the exact would-be diff and
  // states its own contract; refusals above are identical to normal mode.
  if (!write && cli.dryRun) {
    if (proposed.length > 0) printDiff(proposed);
    say('dry run: no files changed, heal not verified');
  }
  if (write && proposed.length === 0) {
    if (unmatched.length === 0) say('Nothing to heal. No files written.');
  } else if (write) {
    printDiff(proposed);
    const confirmed = await confirmApply(cli, proposed.length);
    if (confirmed) {
      say('▸ Applying heals');
      // Apply the PREVIEWED plan, never a re-probe (see scan mode above):
      // --yes only skips the prompt, and the diff that lands is byte-for-
      // byte the diff that was shown.
      const written = applyHealPlan(preview.plan);
      result = {
        ...preview,
        filesWritten: written,
        healedPath: specs.find((sp) => written.includes(sp)) ?? written[0] ?? null,
      };
      applied = true;
    } else {
      say('Heals available but not applied. No files written. Pass --yes (or -y) to apply without prompting.');
      process.exitCode = 2;
    }
  }

  // 4. Verify by re-running ONLY the previously failing locator tests.
  //    Contract: a heal whose test STILL fails after applying is REVERTED
  //    — run-mode granularity is PER TEST: when the combined re-run
  //    fails, each previously failing test is re-run individually and
  //    only the heals whose tests still fail are undone; heals whose
  //    tests now pass stay, individually verified.
  let rerunPassed: boolean | null = null;
  const verifiedByTitle = new Map<string, boolean>();
  if (applied && verify && result.healed.length > 0) {
    const rootDir = report.config?.rootDir ?? root;
    const fileArgOf = (t: TestOutcome): string => toCliFileFilter(path.relative(root, path.resolve(rootDir, t.file)));
    const fileArgs = [...new Set(locatorTests.map(fileArgOf))];
    const grep = locatorTests.map((t) => escapeRegex(t.title)).join('|');
    say(`▸ Verifying: re-running ${locatorTests.length} previously failing test(s)`);
    // The grep pattern joins titles with '|': under a Windows shell that
    // would be a cmd.exe pipe — runPlaywrightCli passes argv verbatim.
    const rerun = runPlaywrightCli(root, ['test', ...fileArgs, '--grep', grep], 32 * 1024 * 1024);
    logChildRun(cli, rerun);
    rerunPassed = rerun.status === 0;
    if (rerunPassed) {
      say('  ✓ re-run passed');
      for (const t of locatorTests) verifiedByTitle.set(t.title, true);
    } else {
      say('  ✗ re-run FAILED — verifying per test to isolate the failing heal(s)');
      for (const t of locatorTests) {
        const one = runPlaywrightCli(root, ['test', fileArgOf(t), '--grep', escapeRegex(t.title), '--reporter=json'], 32 * 1024 * 1024);
        logChildRun(cli, one);
        verifiedByTitle.set(t.title, one.status === 0);
        // Why is it STILL failing? A locator-classified failure means the
        // heal did not fix (or wrongly fixed) the lookup; a non-locator
        // failure (assertion value mismatch, app error, navigation) means
        // the healed locator now RESOLVES and the remaining problem is
        // likely the test or the app, not the heal (0.3.3 field case:
        // a CORRECT heal was reverted with wording implying it was wrong).
        // The revert itself is unconditional either way.
        if (one.status !== 0) {
          let reason: 'locator' | 'non-locator' = 'locator';
          let line: string | undefined;
          const oneReport = parseJsonReport(one.stdout ?? '');
          if (oneReport) {
            const failed = collectTests(oneReport as Parameters<typeof collectTests>[0])
              .find((x) => !x.ok && x.title === t.title);
            if (failed?.message) {
              const c = classifyFailure(failed.message);
              if (c.kind === 'other') {
                reason = 'non-locator';
                line = c.summary;
              }
            }
          }
          revertReasonByTitle.set(t.title, { reason, line });
        }
      }
      const revertedHeals = new Set<HealResult['healed'][number]>();
      for (const h of result.healed) {
        const title = titleFor(h.old);
        // Unmappable heals are reverted too: without a test to vouch for
        // the heal, a failed combined re-run leaves it unverified.
        if (!title || verifiedByTitle.get(title) !== true) revertedHeals.add(h);
      }
      if (revertedHeals.size > 0) {
        applyHealPlanExcluding(result.plan, (file, edit) =>
          [...revertedHeals].some((h) => h.file === file && h.line === edit.line && h.new === edit.newRaw));
        for (const h of revertedHeals) {
          const rel = path.relative(process.cwd(), h.file).split(path.sep).join('/');
          const title = titleFor(h.old);
          const info = title ? revertReasonByTitle.get(title) : undefined;
          revertedKeys.add(`${rel}|${h.line}`);
          revertReasonByKey.set(`${rel}|${h.line}`, info?.reason ?? 'locator');
          if (info?.reason === 'non-locator') {
            say(`  ✗ heal reverted: the re-run still fails, but no longer for a locator reason${info.line ? ` (${info.line})` : ''}. `
              + `The heal may be correct; the remaining failure looks like a test or app problem. — ${rel}:${h.line} ${h.old}`);
          } else {
            say(`  ✗ heal reverted: re-run still failing after heal — ${rel}:${h.line} ${h.old}`);
          }
        }
        say(`${revertedHeals.size} heal(s) reverted: re-run still failing after heal`);
        process.exitCode = 1;
      }
    }
  }
  if (applied && result.healed.length > 0) {
    const relOf = (h: HealResult['healed'][number]): string =>
      path.relative(process.cwd(), h.file).split(path.sep).join('/');
    writeAudit(
      result.healed,
      (h) => {
        if (!verify) return false;
        if (rerunPassed === true) return true;
        const title = titleFor(h.old);
        return title != null && verifiedByTitle.get(title) === true;
      },
      (h) => revertedKeys.has(`${relOf(h)}|${h.line}`),
      (h) => revertReasonByKey.get(`${relOf(h)}|${h.line}`),
    );
  }
  emit(result, applied, nonLocator, unmatched, rerunPassed);
  // The final skip summary: precise (per-target) when targets could be
  // attributed to errored files, else one per unreadable file.
  if (result.fileErrors.length > 0) {
    say(`${fileSkipped.length > 0 ? fileSkipped.length : result.fileErrors.length} locator(s) skipped due to file errors`);
  }
  // UNKNOWN-shape unmatched targets are a bug in heal's matching, not a
  // user mistake: exit 1 (takes precedence over the not-applied exit 2).
  // Chained/dynamic unmatched are a documented limitation, not an error.
  if (unknownUnmatched.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  // --debug adds the stack; --json keeps stdout a single valid JSON object
  // carrying the failure story (fail() handles both for explicit exits).
  if (process.argv.includes('--debug') && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  fail(err instanceof Error ? err.message : String(err));
});
