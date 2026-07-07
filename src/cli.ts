#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { heal, type HealEvent, type HealResult, type LocatorReport } from './heal.js';
import type { CascadeLevel } from './selectors.js';
import { loadConfig } from './config.js';
import { appendAuditLog, type AuditEntry } from './audit.js';

/**
 * qa-core-heal CLI.
 *
 * Usage:
 *   qa-core-heal [spec-path] [--config <path>] [--base-url <url>]
 *                [--dry-run | --apply] [--yes] [--json] [--audit-log <path>]
 *                [--max-heals <n>] [--verify | --no-verify]
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
  const out: CliArgs = { dryRun: false, apply: false, yes: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--config') out.configPath = args[++i];
    else if (a === '--base-url') out.baseUrl = args[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--yes') out.yes = true;
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
 * Applying requires explicit consent: --yes, or an interactive TTY prompt.
 * In a non-interactive context (no TTY, or --json output) without --yes the
 * CLI exits so a script can never write files by accident.
 */
async function confirmApply(cli: CliArgs, count: number): Promise<boolean> {
  if (cli.yes) return true;
  if (!cli.json && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Apply ${count} heal(s)? [y/N] `)).trim().toLowerCase();
    rl.close();
    return answer === 'y' || answer === 'yes';
  }
  console.error(
    'Applying heals requires confirmation. Preview with --dry-run, or add --yes to apply non-interactively.',
  );
  process.exit(1);
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
  const maxHeals = cli.maxHeals ?? cfg.heal?.maxHealsPerRun;
  const verify = cli.verify ?? cfg.heal?.verifyAfterApply ?? true;
  const allowedLevels = cfg.selectorPreference as CascadeLevel[] | undefined;
  const followImports = cfg.pageObjects?.enabled !== false;
  const pageObjectDirs = cfg.pageObjects?.dir ? [fromCfg(cfg.pageObjects.dir)] : undefined;
  const storageState = cfg.auth?.storageState ? fromCfg(cfg.auth.storageState) : undefined;
  const auditPath = cli.auditLog
    ? path.resolve(cli.auditLog)
    : cfg.audit?.logPath
      ? fromCfg(cfg.audit.logPath)
      : path.resolve('.qa-core/heal-log.jsonl');

  const say = (line: string): void => { if (!cli.json) console.log(line); };
  const eventPrinter = (e: HealEvent): void => {
    switch (e.type) {
      case 'scanned': say(`  · scanned ${e.total} locator(s) across ${e.files} file(s)`); break;
      case 'opened_page': say(`  · opened ${e.url}`); break;
      case 'healing': say(`  → broken: ${e.selector}`); break;
      case 'healed': say(`  ✓ healed to ${e.new}  (level=${e.level})`); break;
      case 'unhealed': say(`  ✗ unhealable: ${e.selector}\n      ${e.reason}`); break;
      case 'done': say(`  ${e.intact} intact · ${e.healed} healed · ${e.unhealed} unhealable (of ${e.total} scanned)\n`); break;
      default: break;
    }
  };
  const runPass = async (writePass: boolean, silent: boolean) => {
    const locs: LocatorReport[] = [];
    const per: Array<{ spec: string; result: HealResult }> = [];
    for (const spec of specs) {
      if (!silent) say(`▸ Healing ${path.relative(process.cwd(), spec)}${writePass ? '' : '  (dry run, no files written)'}`);
      const result = await heal({
        specPath: spec, baseUrl, write: writePass, maxHeals, allowedLevels,
        followImports, pageObjectDirs, storageState,
        onEvent: cli.json || silent ? undefined : eventPrinter,
      });
      locs.push(...result.locators);
      per.push({ spec, result });
    }
    return { locs, per };
  };

  let locators: LocatorReport[] = [];
  let perSpec: Array<{ spec: string; result: HealResult }> = [];

  if (!write) {
    const pass = await runPass(false, false);
    locators = pass.locs;
    perSpec = pass.per;
  } else {
    // Applying always previews first: probe everything without writing, show
    // the full proposed diff, and only write after explicit consent.
    say('▸ Probing locators (preview pass, no files written yet)');
    const preview = await runPass(false, true);
    const proposed = preview.locs.filter((l) => l.status === 'healed');
    if (proposed.length === 0) {
      say('Nothing to heal. No files written.');
      locators = preview.locs;
      perSpec = preview.per;
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
      if (!confirmed) {
        say('Aborted. No files written.');
        return;
      }
      const pass = await runPass(true, false);
      locators = pass.locs;
      perSpec = pass.per;
    }
  }

  // Audit log entries are written only when heals were actually applied.
  if (write) {
    const auditEntries: AuditEntry[] = [];
    for (const { spec, result } of perSpec) {
      if (result.healed.length === 0) continue;
      let verified = false;
      if (verify) {
        const root = projectRootFor(spec);
        const rel = path.relative(root, spec);
        say(`▸ Verifying ${rel} with a re-run`);
        const run = spawnSync('npx', ['playwright', 'test', rel], {
          cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
        });
        verified = run.status === 0;
        say(verified ? '  ✓ re-run passed' : '  ✗ re-run FAILED (audit entries record verified=false)');
      }
      for (const h of result.healed) {
        auditEntries.push({
          timestamp: new Date().toISOString(),
          file: path.relative(process.cwd(), h.file).split(path.sep).join('/'),
          line: h.line,
          old: h.old,
          new: h.new,
          level: h.level,
          ambiguous: false,
          verified,
        });
      }
    }
    if (auditEntries.length > 0) {
      appendAuditLog(auditPath, auditEntries);
      say(`▸ Audit log: ${auditEntries.length} entr${auditEntries.length === 1 ? 'y' : 'ies'} appended to ${path.relative(process.cwd(), auditPath)}`);
    }
  }

  if (cli.json) {
    const count = (s: LocatorReport['status']): number => locators.filter((l) => l.status === s).length;
    const payload = {
      dryRun: !write,
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

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
