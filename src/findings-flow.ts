import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuditEntry } from './audit.js';
import {
  applyHealPlan, applyHealPlanExcluding, heal, renderHealPlan,
  type HealOptions, type HealPlanEntry, type HealResult, type HealTarget, type LocatorReport,
} from './heal.js';
import {
  baseEntry, clip, ineligibleReason, playwrightVersion, plainEntry, refusedEntry, RESULTS_SCHEMA, RESULTS_SCHEMA_VERSION,
  toolVersion, TOOL_NAME,
  type Change, type Finding, type FindingsDoc, type HealResultEntry, type HealResultsDoc, type RefusalCode,
} from './contract.js';
import { projectRootFor } from './project-root.js';
import { resolvePlaywrightConfig } from './playwright-config.js';
import { clearUnverifiedApplies, trackOutputDir, trackUnverifiedApply, untrackOutputDir } from './process-guard.js';
import { scratchVerify } from './scratch.js';
import {
  matchFinding, outputArgs, realPathOf, resolveTarget, runSelected, type RunObserver,
} from './targeted.js';
import { classifyFailure, stripAnsi, traceFailureUrl } from './run.js';

/**
 * The findings flow: read the handoff decisions of qa-core-flaky and write
 * one result per finding.
 *
 * Per finding, in this order:
 *   1. The handoff gate. A finding that is not eligible is refused and no
 *      test is run.
 *   2. A suggest handoff is refused for now. Rule based suggestions come in
 *      a later release. Nothing is run.
 *   3. A locator handoff runs exactly one test, classifies the failure,
 *      probes the live page with the existing locator healer, and checks the
 *      candidate in a scratch copy of the project. Every requested shadow
 *      run must pass. The default is three runs.
 *   4. Only a candidate that passed that check is written as proposed.
 *   5. With --apply (and consent) the change is written, the test is re-run
 *      for real, and the change is undone when the re-run fails.
 * Nothing is ever written to a source file without --apply.
 */

export interface FindingsFlowOptions {
  doc: FindingsDoc;
  findingsSha256: string;
  cwd: string;
  resultsPath: string;
  apply: boolean;
  /** Re-run the test for real after an apply. A scratch check is always required. */
  verify: boolean;
  noTrace: boolean;
  maxHeals?: number;
  project?: string;
  runTimeoutMs: number;
  /** How many scratch runs must pass before a proposal counts as verified. Default 3. */
  shadowRuns?: number;
  /** Options for the locator healer, shared with the classic flow. */
  heal: Omit<HealOptions, 'specPaths' | 'targets' | 'write' | 'maxHeals' | 'project' | 'onEvent' | 'verbose'>;
  verbose: boolean;
  say: (line: string) => void;
  observe?: RunObserver;
  /** Ask for consent to write one change. */
  confirm: () => Promise<boolean>;
  /** Where a signal during verification writes the interrupted audit line. */
  auditPath: string;
}

export interface FindingsFlowOutcome {
  doc: HealResultsDoc;
  /** 0 when the results file is complete, 1 when a change was applied and then undone. */
  exitCode: 0 | 1;
}

const MAX_SPAN_END = Number.MAX_SAFE_INTEGER;
const STRONG_LEVELS = new Set(['role', 'label', 'placeholder', 'testid', 'alt']);

const posix = (p: string): string => p.split(path.sep).join('/');

/** Replace absolute folders in a message by short forms before it is written. */
function scrub(text: string, root: string): string {
  let out = text;
  for (const [from, to] of [[root, '.'], [process.cwd(), '.']] as const) {
    if (from.length > 1) out = out.split(from).join(to);
  }
  return out;
}

/** True when a path has a `..` step, or is absolute on any platform. Such a path is never trusted. */
function isUnsafeRelative(p: string): boolean {
  return path.isAbsolute(p) || path.win32.isAbsolute(p) || p.split(/[\\/]+/).includes('..');
}

/**
 * Candidate base folders for a finding's relative file path: the working
 * folder, then the folder of project.configPath. A configPath that is
 * absolute or has a `..` step adds nothing.
 */
function bases(cwd: string, doc: FindingsDoc): string[] {
  const out = [cwd];
  const cfg = doc.project.configPath;
  if (cfg && !isUnsafeRelative(cfg)) {
    const dir = path.dirname(path.resolve(cwd, cfg));
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * The --config value for Playwright: project.configPath as a path relative
 * to the Playwright working folder. Null (so Playwright finds its own
 * config, as before) when there is no configPath, it is absolute or has a
 * `..` step, the file does not exist, or its real path is outside the
 * project folder or the Playwright working folder.
 */
export function configArgFor(cwd: string, configPath: string | null | undefined, root: string): string | null {
  if (configIgnoreReason(cwd, configPath, root) !== null) return null;
  if (!configPath) return null;
  try {
    const real = fs.realpathSync(path.resolve(cwd, configPath));
    const rel = path.relative(fs.realpathSync(root), real);
    return posix(rel);
  } catch {
    return null;
  }
}

/**
 * Why a provided configPath is not passed to Playwright, or null when it is used.
 * The words are the ones --verbose prints.
 */
export function configIgnoreReason(cwd: string, configPath: string | null | undefined, root: string): string | null {
  if (!configPath) return null;
  if (isUnsafeRelative(configPath)) return 'it is absolute or it contains ..';
  const abs = path.resolve(cwd, configPath);
  let real: string;
  try {
    if (!fs.existsSync(abs)) return 'the file is missing';
    real = fs.realpathSync(abs);
    const st = fs.statSync(real);
    if (st.isDirectory()) return 'it is a folder';
    if (!st.isFile()) return 'it is not a file';
  } catch {
    return 'the file is missing';
  }
  try {
    if (!isInside(fs.realpathSync(cwd), real)) return 'it is outside the project';
    const rel = path.relative(fs.realpathSync(root), real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return 'it is outside the project';
  } catch {
    return 'it is outside the project';
  }
  return null;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled scratch state: ${String(x)}`);
}

/** The result entry when a scratch check does not pass. Null when it passed. */
export function scratchStopEntry(f: Finding, check: {
  state: 'passed' | 'failed' | 'timeout' | 'unavailable' | 'weakened';
  message: string;
  runs?: number;
  passed?: number;
  failed?: number;
}): HealResultEntry | null {
  let entry: HealResultEntry | null;
  switch (check.state) {
    case 'timeout':
      entry = refusedEntry(f, 'timeout', check.message);
      break;
    case 'unavailable':
      entry = plainEntry(f, 'error', `The change could not be checked, so it is not proposed. ${check.message}`);
      break;
    case 'failed':
      entry = refusedEntry(f, 'verification-failed', `${check.message} The change is not proposed.`);
      break;
    case 'weakened':
      return refusedEntry(f, 'weakens-test', `${check.message} The change is not proposed.`);
    case 'passed':
      return null;
    default:
      return assertNever(check.state);
  }
  const runs = check.runs ?? 0;
  const ran = runs > 0 && check.state !== 'unavailable';
  return {
    ...entry,
    verification: {
      performed: ran,
      method: ran ? 'shadow-rerun' : 'none',
      runs,
      passed: check.passed ?? 0,
      failed: check.failed ?? 0,
      baselineReproduced: check.state === 'failed' ? true : null,
      outcome: check.state === 'failed' || check.state === 'timeout' ? 'failed' : 'not-run',
    },
  };
}

/** How many scratch runs must pass when the caller does not say. */
export const DEFAULT_SHADOW_RUNS = 3;

/** True when `child` is `parent` or below it. Both must already be real paths. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The absolute spec path, or null when it is missing, absolute, or not
 * inside the project folder. The real path of the spec (links followed) is
 * compared with the real path of the project folder for every base folder.
 */
/**
 * The config's test directory, when configPath is safe and the directory
 * stays inside the project. Playwright's own default is `tests` when the
 * config does not set testDir. Null when the config cannot be used.
 */
export async function testDirBase(cwd: string, configPath: string | null | undefined): Promise<string | null> {
  if (!configPath || configArgFor(cwd, configPath, cwd) === null) return null;
  const abs = path.resolve(cwd, configPath);
  let relDir: string;
  try {
    const res = await resolvePlaywrightConfig(path.dirname(abs), undefined, abs);
    relDir = res?.testDir && res.testDir.length > 0 ? res.testDir : 'tests';
  } catch {
    return null;
  }
  if (isUnsafeRelative(relDir)) return null;
  const base = path.resolve(path.dirname(abs), relDir);
  try {
    const real = fs.realpathSync(base);
    if (!fs.statSync(real).isDirectory()) return null;
    if (!isInside(fs.realpathSync(cwd), real)) return null;
    return real;
  } catch {
    return null;
  }
}

export function resolveSpecPath(file: string, candidates: string[], projectDir: string = candidates[0]!): string | null {
  if (isUnsafeRelative(file) || /^[A-Za-z]:/.test(file)) return null;
  let fence: string;
  try { fence = fs.realpathSync(projectDir); } catch { return null; }
  for (const base of candidates) {
    const abs = path.resolve(base, file);
    try {
      if (!fs.statSync(abs).isFile()) continue;
      if (!isInside(fence, fs.realpathSync(abs))) continue;
      return abs;
    } catch { /* try the next base */ }
  }
  return null;
}

/** Map the locator healer's own refusal text to a contract refusal code. */
export function refusalFromReason(reason: string, ambiguous: boolean): RefusalCode {
  if (/identical by accessible name/.test(reason)) return 'strict-needs-human';
  if (ambiguous || /candidates disagree/.test(reason)) return 'ambiguous-match';
  if (/^kind mismatch|^re-resolved|element identity attributes are unstable/.test(reason)) return 'element-changed';
  if (/^not found on /.test(reason)) return 'possible-real-bug';
  if (/redirected to/.test(reason)) return 'navigation-or-network';
  return 'no-safe-pattern';
}

/** Point the first selection argument (file:line) at another line. */
export function withLine(args: string[], from: number, to: number): string[] {
  return args.map((a, i) => (i === 0 ? a.replace(new RegExp(`:${from}$`), `:${to}`) : a));
}

/** A unified diff for one file. Three lines of context, one hunk. */
export function unifiedDiff(rel: string, before: string, after: string): string {
  if (before === after) return '';
  const split = (t: string): { lines: string[]; nl: boolean } => {
    const nl = t.endsWith('\n');
    const lines = t.split('\n');
    if (nl) lines.pop();
    return { lines, nl };
  };
  const A = split(before);
  const B = split(after);
  const a = A.lines;
  const b = B.lines;
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ctx = 3;
  const start = Math.max(0, s - ctx);
  const endA = Math.min(a.length, ea + ctx);
  const endB = Math.min(b.length, eb + ctx);
  const out: string[] = [`--- a/${rel}`, `+++ b/${rel}`, `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`];
  const noNl = '\\ No newline at end of file';
  for (let i = start; i < s; i++) out.push(` ${a[i]}`);
  for (let i = s; i < ea; i++) {
    out.push(`-${a[i]}`);
    if (i === a.length - 1 && !A.nl) out.push(noNl);
  }
  for (let i = s; i < eb; i++) {
    out.push(`+${b[i]}`);
    if (i === b.length - 1 && !B.nl) out.push(noNl);
  }
  for (let i = ea; i < endA; i++) {
    out.push(` ${a[i]}`);
    if (i === a.length - 1 && !A.nl) out.push(noNl);
  }
  return `${out.join('\n')}\n`;
}

/** The change list of a plan, one entry per edit, in file and line order. */
function changesOf(plan: HealPlanEntry[], root: string): Change[] {
  const out: Change[] = [];
  for (const entry of plan) {
    const lines = entry.src.split('\n');
    const sorted = [...entry.edits].sort((x, y) => x.line - y.line || x.startCol - y.startCol);
    for (const e of sorted) {
      const first = lines[e.line - 1] ?? '';
      const before = e.endLine === e.line
        ? first.slice(e.startCol, e.endCol)
        : [first.slice(e.startCol), ...lines.slice(e.line, e.endLine - 1), (lines[e.endLine - 1] ?? '').slice(0, e.endCol)].join('\n');
      out.push({ file: posix(path.relative(root, entry.file)), startLine: e.line, endLine: e.endLine, before, after: e.newRaw });
    }
  }
  return out;
}

/** Remember files --apply wrote, so a signal during the findings verify re-run can put them back. */
function trackAppliedForSignal(plan: HealPlanEntry[], locators: LocatorReport[], auditPath: string, cwd: string): void {
  for (const entry of plan) {
    const rel = posix(path.relative(cwd, entry.file));
    const lines = entry.src.split('\n');
    const audit: AuditEntry[] = [];
    for (const e of entry.edits) {
      const loc = locators.find((l) => l.status === 'healed' && (l.occurrenceLines ?? [l.line]).includes(e.line));
      const first = lines[e.line - 1] ?? '';
      const before = e.endLine === e.line
        ? first.slice(e.startCol, e.endCol)
        : [first.slice(e.startCol), ...lines.slice(e.line, e.endLine - 1), (lines[e.endLine - 1] ?? '').slice(0, e.endCol)].join('\n');
      audit.push({
        timestamp: new Date().toISOString(),
        file: rel,
        line: e.line,
        old: before,
        new: loc?.new ?? e.newRaw,
        level: loc?.level ?? 'css',
        ambiguous: false,
        applied: true,
        verified: false,
        reverted: true,
        revertReason: 'interrupted',
      });
    }
    if (audit.length === 0) continue;
    trackUnverifiedApply({ file: entry.file, original: entry.src, auditPath, entries: audit });
  }
}

/** Lines removed above a line by multi-line edits, so a declaration line can be tracked. */
export function lineShift(plan: HealPlanEntry[], file: string, declLine: number): number {
  let shift = 0;
  for (const entry of plan) {
    if (realPathOf(entry.file) !== realPathOf(file)) continue;
    for (const e of entry.edits) if (e.endLine < declLine) shift += e.endLine - e.line;
  }
  return shift;
}

export async function runFindingsFlow(o: FindingsFlowOptions): Promise<FindingsFlowOutcome> {
  const { doc, say } = o;
  const entries: HealResultEntry[] = [];
  const baseDirs = bases(o.cwd, doc);
  const patchDir = path.join(path.dirname(o.resultsPath), '.qa-core', 'heal', 'patches');
  let proposedCount = 0;
  let reverted = false;
  let pwVersion: string | null = null;
  let configNoted = false;

  /** One line, once, when verbose and a provided configPath is not passed through. */
  function noteIgnoredConfig(root: string): void {
    if (configNoted || !o.verbose) return;
    const cfg = doc.project.configPath;
    if (!cfg) { configNoted = true; return; }
    if (configArgFor(o.cwd, cfg, root) !== null) return;
    configNoted = true;
    const why = configIgnoreReason(o.cwd, cfg, root) ?? 'it is outside the project';
    console.error(`[verbose] ignored configPath ${cfg}: ${why}`);
  }

  noteIgnoredConfig(o.cwd);

  for (const f of doc.findings) {
    say(`▸ ${f.findingId}  ${f.file} · ${f.titlePath.join(' › ')}  (handoff: ${f.handoff.mode})`);
    const entry = await processFinding(f);
    entries.push(entry);
    const tag = entry.status === 'refused' && entry.refusal ? `refused (${entry.refusal.code})` : entry.status;
    say(`  ${tag}: ${entry.explanation}`);
  }

  /** Each finding gets its own Playwright output folders, removed afterwards, so runs at the same time do not clear each other's files. */
  async function processFinding(f: Finding): Promise<HealResultEntry> {
    const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-out-'));
    trackOutputDir(outRoot);
    try {
      return await processOne(f, outRoot);
    } finally {
      fs.rmSync(outRoot, { recursive: true, force: true });
      untrackOutputDir(outRoot);
    }
  }

  async function processOne(f: Finding, outRoot: string): Promise<HealResultEntry> {
    // 1. The handoff gate. Nothing below runs for an ineligible finding.
    const why = ineligibleReason(f);
    if (why) return refusedEntry(f, 'ineligible-handoff', why);

    // 2. Suggest handoffs have no rule based fixes yet.
    if (f.handoff.mode === 'suggest') {
      if (f.primaryRuleId === 'SEL-STRICT') {
        return refusedEntry(f, 'strict-needs-human',
          'The locator matched several elements. Heal cannot pick one for you, because that would change what the test checks. No test was run.');
      }
      return refusedEntry(f, 'no-safe-pattern',
        `Heal ${toolVersion()} has no rule based suggestion for ${f.primaryRuleId} yet, so nothing was changed. No test was run.`);
    }

    // 3. Locator handoff.
    let specAbs = resolveSpecPath(f.file, baseDirs, o.cwd);
    // A findings file from qa-core-flaky names the spec relative to
    // Playwright's testDir. Try that only after the project root and the
    // config folder missed, and only inside the same fence.
    if (!specAbs && doc.project.configPath) {
      const td = await testDirBase(o.cwd, doc.project.configPath);
      if (td) specAbs = resolveSpecPath(f.file, [td], o.cwd);
    }
    if (!specAbs) return refusedEntry(f, 'spec-not-found', `The spec file ${f.file} was not found inside the project folder. No test was run.`);
    const root = projectRootFor(specAbs);
    noteIgnoredConfig(root);
    pwVersion ??= playwrightVersion(root);
    const fileRel = posix(path.relative(root, specAbs));
    const title = f.titlePath[f.titlePath.length - 1]!;
    const project = o.project ?? f.project;
    const config = configArgFor(o.cwd, doc.project.configPath, root);

    const res = await resolveTarget({
      root, file: specAbs, title, project, config, outputDir: path.join(outRoot, 'list'),
      match: matchFinding(f.titlePath, project, f.file),
      timeoutMs: o.runTimeoutMs, observe: o.observe,
    });
    if (res.kind === 'not-found') {
      let linkNote = '';
      try {
        if (fs.lstatSync(specAbs).isSymbolicLink()) {
          linkNote = ' The file is a symbolic link, and Playwright lists the real file, so heal does not run the link.';
        }
      } catch { /* the path check above already required a file */ }
      return refusedEntry(f, 'spec-not-found', `No test with the title path "${f.titlePath.join(' › ')}" was found in ${fileRel}.${linkNote} No test was run.`);
    }
    if (res.kind === 'ambiguous') {
      return refusedEntry(f, 'ambiguous-match', `${res.count} tests match this finding in ${fileRel}, and heal runs exactly one test. No test was run. Pass --project to narrow it.`);
    }
    if (res.kind === 'error') {
      return res.timedOut
        ? refusedEntry(f, 'timeout', 'Listing the tests timed out. No test was run.')
        : plainEntry(f, 'error', scrub(res.message, root));
    }

    const first = await runSelected(root, res.selectArgs, [...outputArgs(path.join(outRoot, 'first')), ...(o.noTrace ? [] : ['--trace', 'retain-on-failure'])], o.runTimeoutMs, o.observe);
    if (first.kind === 'timeout') return refusedEntry(f, 'timeout', 'The test run timed out before it finished.');
    if (first.kind === 'error') return plainEntry(f, 'error', scrub(first.message, root));
    if (first.status === 'skipped') return plainEntry(f, 'error', 'The test is skipped, so heal could not run it.');
    if (first.status === 'expected' || first.status === 'flaky') {
      return plainEntry(f, 'nothing-to-heal', first.status === 'flaky'
        ? 'The test failed and then passed on a retry, so there is no stable failure to heal. This is weak evidence only.'
        : 'The test passed when heal ran it. This is weak evidence only: it does not show that the flakiness is gone.');
    }

    // The test failed. Is it a locator failure?
    const test = first.test;
    const failure = classifyFailure(test.message);
    if (failure.kind === 'other') {
      // Source code frames show neighbouring lines (often a page.goto), so
      // they are removed before looking for a navigation or network error.
      const noFrames = stripAnsi(test.message).replace(/^[ \t]*>?[ \t]*\d+ \|.*$/gm, '');
      if (/page\.goto:|net::|Navigation failed|NS_ERROR|Protocol error/.test(noFrames)) {
        return refusedEntry(f, 'navigation-or-network', `The test failed on a navigation or network step, which a test change cannot fix: ${scrub(failure.summary, root)}`);
      }
      return plainEntry(f, 'not-locator', `The test did not fail on a locator: ${scrub(failure.summary, root)}`);
    }
    if (!failure.selector) {
      return plainEntry(f, 'not-locator', 'The test failed on a locator, but heal could not read the failing selector from the message.');
    }
    const url = !o.noTrace && test.tracePath ? traceFailureUrl(test.tracePath) : null;
    const next = res.startLines.find((l) => l > test.line);
    const target: HealTarget = {
      selector: failure.selector,
      url: url ?? undefined,
      test: test.title,
      locations: test.locations,
      strict: failure.strict,
      chained: failure.chained,
      testSpan: test.line > 0 ? { file: specAbs, startLine: test.line, endLine: next ?? MAX_SPAN_END } : undefined,
    };

    let healed: HealResult;
    try {
      healed = await heal({
        ...o.heal,
        specPaths: [specAbs], targets: [target], write: false, project: project || undefined,
        maxHeals: o.maxHeals !== undefined ? Math.max(0, o.maxHeals - proposedCount) : undefined,
        verbose: o.verbose,
      });
    } catch (e) {
      return plainEntry(f, 'error', scrub(e instanceof Error ? e.message : String(e), root));
    }

    const candidates = healed.locators.filter((l) => l.status === 'healed');
    if (candidates.length === 0 || healed.plan.length === 0) {
      const refused = healed.locators.find((l) => l.status === 'refused');
      if (refused) {
        return refusedEntry(f, refusalFromReason(refused.reason ?? '', refused.ambiguous), scrub(refused.reason ?? 'Heal refused this locator.', root));
      }
      const um = healed.unmatchedTargets[0];
      if (um) {
        return um.shape === 'unknown'
          ? plainEntry(f, 'error', 'The failing locator could not be matched to the source. This is a bug in heal worth reporting.')
          : refusedEntry(f, 'no-safe-pattern', `The failing locator is built ${um.shape === 'chained' ? 'by chaining' : 'dynamically'}. Heal only changes literal top level locator calls.`);
      }
      if (healed.fileErrors.length > 0) return plainEntry(f, 'error', 'A source file could not be read, so its locators were skipped.');
      return plainEntry(f, 'not-locator', 'The locator in the source still resolves on the live page, so heal has nothing to change. The failure is probably about timing or state, not about the locator.');
    }

    const changes = changesOf(healed.plan, root);
    const rendered = renderHealPlan(healed.plan);
    const level = candidates[0]!.level;
    const occurrences = candidates.reduce((n, c) => n + (c.occurrences ?? 1), 0);
    const reviewLevel = f.primaryRuleId === 'SEL-ZERO' || !STRONG_LEVELS.has(level) || occurrences > 1 ? 'review-carefully' : 'standard';

    // 4. The scratch check. No candidate is shown without it.
    const declShift = lineShift(healed.plan, specAbs, test.line);
    const scratchArgs = withLine(res.selectArgs, test.line, test.line - declShift);
    const check = await scratchVerify({
      root, plan: healed.plan, selectArgs: scratchArgs, timeoutMs: o.runTimeoutMs,
      runs: o.shadowRuns ?? DEFAULT_SHADOW_RUNS,
      outputDir: path.join(outRoot, 'scratch'), observe: o.observe,
    });
    const stopped = scratchStopEntry(f, check);
    if (stopped) return stopped;

    const times = check.runs === 1 ? 'once' : `${check.runs} times`;
    const core = `The locator failed, and a ${level} locator matched one confident element on the live page (${occurrences} occurrence${occurrences === 1 ? '' : 's'}). `
      + `The test passed ${times} in a scratch copy with this change.`
      + (reviewLevel === 'review-carefully' ? ' Review it carefully.' : '');
    const patchName = `${f.findingId}.diff`;
    fs.mkdirSync(patchDir, { recursive: true });
    fs.writeFileSync(path.join(patchDir, patchName),
      rendered.map((r) => unifiedDiff(posix(path.relative(root, r.file)), r.before, r.after)).join(''));
    const patchFile = posix(path.relative(path.dirname(o.resultsPath), path.join(patchDir, patchName)));

    const entry: HealResultEntry = {
      ...baseEntry(f),
      status: 'proposed',
      strategy: 'locator-heal',
      fixRuleId: 'HEAL-SEL-LOCATOR',
      reviewLevel,
      changes,
      patchFile,
      explanation: clip(`${core} This is a proposal and it is not applied.`, 600),
      verification: {
        performed: true, method: 'shadow-rerun',
        runs: check.runs, passed: check.passed, failed: check.failed,
        // The first real run already failed, which is what 0.4.0 recorded.
        // This build does not run the unpatched test again inside the copy.
        baselineReproduced: true, outcome: 'passed',
      },
    };
    proposedCount++;

    // 5. Apply only on request.
    if (!o.apply) return entry;
    say(`  proposed change${changes.length === 1 ? '' : 's'}:`);
    for (const c of changes) { say(`    ${c.file}:${c.startLine}`); say(`      - ${c.before}`); say(`      + ${c.after}`); }
    if (!(await o.confirm())) {
      say('  not applied: consent was not given.');
      return entry;
    }
    for (const entryPlan of healed.plan) {
      if (fs.readFileSync(entryPlan.file, 'utf8') !== entryPlan.src) {
        return plainEntry(f, 'error', `${posix(path.relative(root, entryPlan.file))} changed while heal was running, so nothing was written.`);
      }
    }
    applyHealPlan(healed.plan);
    if (o.verify) {
      trackAppliedForSignal(healed.plan, healed.locators, o.auditPath, o.cwd);
      const again = await runSelected(root, withLine(res.selectArgs, test.line, test.line - declShift), outputArgs(path.join(outRoot, 'rerun')), o.runTimeoutMs, o.observe);
      // The rerun finished, so a later signal must not restore the file again.
      clearUnverifiedApplies();
      if (again.kind !== 'ran' || again.status !== 'expected') {
        applyHealPlanExcluding(healed.plan, () => true);
        reverted = true;
        return refusedEntry(f, 'verification-failed', 'The change was written and the test was run again, but it did not pass, so the change was undone. The files are back to how they were.');
      }
    }
    return { ...entry, status: 'applied', explanation: clip(`${core} It was applied because --apply was given.`, 600) };
  }

  const results: HealResultsDoc = {
    schema: RESULTS_SCHEMA,
    schemaVersion: RESULTS_SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: toolVersion(), playwrightVersion: pwVersion ?? playwrightVersion(o.cwd) },
    generatedAt: new Date().toISOString(),
    mode: o.apply ? 'apply' : 'dry-run',
    input: { findingsSchemaVersion: 1, findingsSha256: o.findingsSha256, findingCount: doc.findings.length },
    ai: { enabled: false, provider: null, model: null },
    results: entries,
  };
  return { doc: results, exitCode: reverted ? 1 : 0 };
}
