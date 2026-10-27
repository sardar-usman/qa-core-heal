import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The qa-core contract between qa-core-flaky and qa-core-heal, version 1.
 *
 * qa-core-flaky writes a findings file. qa-core-heal reads it, decides per
 * finding what it may do, and writes a results file. The JSON Schemas are
 * vendored in schemas/ and frozen for version 1. This module holds the
 * types, the reader for the findings file, and the result builders. It has
 * no runtime dependency on a schema validator: the reader checks the fields
 * heal needs, and the test suite validates every written file against the
 * vendored schemas.
 */

export const TOOL_NAME = 'qa-core-heal';
export const FINDINGS_SCHEMA = 'qa-core.heal-findings';
export const RESULTS_SCHEMA = 'qa-core.heal-results';
export const CAPABILITIES_SCHEMA = 'qa-core.heal-capabilities';
/** Findings contract versions this build can read. */
export const SUPPORTED_FINDINGS_VERSIONS: readonly number[] = [1];
/** The results contract version this build writes. */
export const RESULTS_SCHEMA_VERSION = 1;

export function toolVersion(): string {
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}

/** The installed Playwright version, resolved from a project root first. */
export function playwrightVersion(root: string): string | null {
  const attempts = [path.join(root, 'package.json'), import.meta.url];
  for (const from of attempts) {
    try {
      const req = createRequire(from);
      const v = (req('@playwright/test/package.json') as { version?: string }).version;
      if (typeof v === 'string' && v.length > 0) return v;
    } catch { /* try the next location */ }
  }
  return null;
}

export interface Capabilities {
  schema: typeof CAPABILITIES_SCHEMA;
  schemaVersion: 1;
  tool: { name: typeof TOOL_NAME; version: string };
  contracts: { findings: number[]; results: number[] };
  playwrightVersion: string | null;
  features: { findings: boolean; targetedRun: boolean; ruleSuggestions: boolean; ai: boolean; playwrightConfig: boolean };
}

export function buildCapabilities(root: string): Capabilities {
  return {
    schema: CAPABILITIES_SCHEMA,
    schemaVersion: 1,
    tool: { name: TOOL_NAME, version: toolVersion() },
    contracts: { findings: [...SUPPORTED_FINDINGS_VERSIONS], results: [RESULTS_SCHEMA_VERSION] },
    playwrightVersion: playwrightVersion(root),
    features: { findings: true, targetedRun: true, ruleSuggestions: false, ai: false, playwrightConfig: true },
  };
}

/* ───────────────────────────── findings ───────────────────────────── */

export type HandoffMode = 'locator' | 'suggest' | 'none';

export interface Finding {
  findingId: string;
  testId: string;
  file: string;
  line: number | null;
  project: string;
  titlePath: string[];
  verdict: string;
  primaryRuleId: string;
  handoff: { mode: HandoffMode; reason: string; gates: Array<{ name: string; passed: boolean }> };
}

export interface FindingsDoc {
  schemaVersion: number;
  project: { configPath: string | null; baseUrl: string | null };
  findings: Finding[];
}

/** An error the CLI turns into a clean message and an exit code. */
export class ContractError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

const VERDICTS = ['broken-test', 'environment-issue', 'likely-real-bug', 'flaky', 'needs-more-runs'];
const MODES = ['locator', 'suggest', 'none'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/**
 * Read a findings file. An unknown schema version is exit code 2 with a
 * message that names both versions. Anything else that is wrong with the
 * file is exit code 1 with the first few problems listed.
 */
export function parseFindings(text: string, label = 'the findings file'): { doc: FindingsDoc; sha256: string } {
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ContractError(`${label} is not valid JSON: ${(e as Error).message}`, 1);
  }
  if (!isObj(raw)) throw new ContractError(`${label} must hold one JSON object.`, 1);
  if (raw.schema !== FINDINGS_SCHEMA) {
    throw new ContractError(`${label} is not a qa-core heal findings file (expected "schema": "${FINDINGS_SCHEMA}").`, 1);
  }
  const v = raw.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ContractError(`${label} has no integer "schemaVersion".`, 1);
  }
  if (!SUPPORTED_FINDINGS_VERSIONS.includes(v)) {
    throw new ContractError(
      `Unsupported findings schema version ${v}. qa-core-heal ${toolVersion()} reads findings schema version ${SUPPORTED_FINDINGS_VERSIONS.join(', ')}. `
      + 'Update qa-core-heal, or write the findings again with a qa-core-flaky that matches.',
      2,
    );
  }
  const problems: string[] = [];
  const project = isObj(raw.project) ? raw.project : {};
  if (!Array.isArray(raw.findings)) problems.push('"findings" must be an array');
  const findings: Finding[] = [];
  const seen = new Set<string>();
  (Array.isArray(raw.findings) ? raw.findings : []).forEach((f: unknown, i: number) => {
    const at = `findings[${i}]`;
    if (!isObj(f)) { problems.push(`${at} must be an object`); return; }
    const before = problems.length;
    const bad = (what: string): void => { problems.push(`${at}.${what}`); };
    if (!isStr(f.findingId) || !/^[0-9a-f]{12}$/.test(f.findingId)) bad('findingId must be 12 lowercase hex characters');
    if (!isStr(f.testId) || f.testId.length === 0) bad('testId must be a non-empty string');
    if (!isStr(f.file) || f.file.length === 0) bad('file must be a non-empty string');
    if (!(f.line === null || (typeof f.line === 'number' && Number.isInteger(f.line) && f.line >= 1))) bad('line must be a positive integer or null');
    if (!isStr(f.project)) bad('project must be a string');
    if (!Array.isArray(f.titlePath) || f.titlePath.length === 0 || !f.titlePath.every(isStr)) bad('titlePath must be a non-empty array of strings');
    if (!isStr(f.verdict) || !VERDICTS.includes(f.verdict)) bad(`verdict must be one of ${VERDICTS.join(', ')}`);
    if (!isStr(f.primaryRuleId)) bad('primaryRuleId must be a string');
    const h = f.handoff;
    if (!isObj(h) || !isStr(h.mode) || !MODES.includes(h.mode)) bad(`handoff.mode must be one of ${MODES.join(', ')}`);
    else if (!Array.isArray(h.gates)) bad('handoff.gates must be an array');
    if (isStr(f.findingId)) {
      if (seen.has(f.findingId)) bad(`findingId ${f.findingId} appears more than once`);
      seen.add(f.findingId);
    }
    if (problems.length === before) {
      const hh = h as Record<string, unknown>;
      findings.push({
        findingId: f.findingId as string,
        testId: f.testId as string,
        file: f.file as string,
        line: f.line as number | null,
        project: f.project as string,
        titlePath: f.titlePath as string[],
        verdict: f.verdict as string,
        primaryRuleId: f.primaryRuleId as string,
        handoff: {
          mode: hh.mode as HandoffMode,
          reason: isStr(hh.reason) ? hh.reason : '',
          gates: (hh.gates as unknown[]).filter(isObj).map((g) => ({ name: String(g.name), passed: g.passed === true })),
        },
      });
    }
  });
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('; ');
    const more = problems.length > 5 ? ` (and ${problems.length - 5} more)` : '';
    throw new ContractError(`${label} is not valid: ${shown}${more}.`, 1);
  }
  return {
    doc: {
      schemaVersion: v,
      project: {
        configPath: isStr(project.configPath) ? project.configPath : null,
        baseUrl: isStr(project.baseUrl) ? project.baseUrl : null,
      },
      findings,
    },
    sha256,
  };
}

/**
 * The handoff gate. Heal acts on a finding only when flaky handed it off as
 * locator or suggest, AND the finding is consistent with that. A finding that
 * says none, that carries a likely-real-bug or environment-issue verdict, or
 * that has a failed gate beside a locator handoff is never run. The check
 * does not trust the mode alone, so a bug in a findings writer cannot make
 * heal touch a real defect.
 */
export function ineligibleReason(f: Finding): string | null {
  if (f.handoff.mode === 'none') {
    return `Flaky handed this finding off as none${f.handoff.reason ? ` (${f.handoff.reason})` : ''}, so heal does not act on it and no test was run.`;
  }
  if (f.verdict === 'likely-real-bug' || f.verdict === 'environment-issue') {
    return `The verdict is ${f.verdict}, which heal never acts on, whatever the handoff says. No test was run.`;
  }
  const failed = f.handoff.gates.find((g) => !g.passed);
  if (failed && f.handoff.mode === 'locator') {
    return `The handoff gate ${failed.name} did not pass, so a locator handoff is not allowed. No test was run.`;
  }
  return null;
}

/* ───────────────────────────── results ───────────────────────────── */

export type ResultStatus = 'proposed' | 'applied' | 'refused' | 'not-locator' | 'nothing-to-heal' | 'error';
export type Strategy = 'locator-heal' | 'rule-suggestion' | 'ai-suggestion' | 'none';

export const REFUSAL_CODES = [
  'ambiguous-match', 'element-changed', 'strict-needs-human', 'possible-real-bug', 'weakens-test',
  'verification-failed', 'baseline-not-reproduced', 'no-safe-pattern', 'ai-disabled', 'ai-invalid-output',
  'ineligible-handoff', 'navigation-or-network', 'spec-not-found', 'timeout',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export interface Change { file: string; startLine: number; endLine: number; before: string; after: string }

export interface Verification {
  performed: boolean;
  method: 'shadow-rerun' | 'none';
  runs: number;
  passed: number;
  failed: number;
  baselineReproduced: boolean | null;
  outcome: 'passed' | 'failed' | 'not-run';
}

export interface HealResultEntry {
  findingId: string;
  testId: string;
  status: ResultStatus;
  strategy: Strategy;
  fixRuleId: string | null;
  reviewLevel: 'standard' | 'review-carefully';
  changes: Change[];
  patchFile: string | null;
  explanation: string;
  refusal: { code: RefusalCode; message: string } | null;
  verification: Verification;
  ai: { used: boolean; label: string | null; promptSha256: string | null };
}

export interface HealResultsDoc {
  schema: typeof RESULTS_SCHEMA;
  schemaVersion: 1;
  tool: { name: typeof TOOL_NAME; version: string; playwrightVersion: string | null };
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  input: { findingsSchemaVersion: 1; findingsSha256: string; findingCount: number };
  ai: { enabled: boolean; provider: string | null; model: string | null };
  results: HealResultEntry[];
}

export const NOT_RUN: Verification = {
  performed: false, method: 'none', runs: 0, passed: 0, failed: 0, baselineReproduced: null, outcome: 'not-run',
};

/** Cut text to a schema limit, ending in three dots when something was cut. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

/** An entry with every required field set to its quiet default. */
export function baseEntry(f: Finding): HealResultEntry {
  return {
    findingId: f.findingId,
    testId: f.testId,
    status: 'error',
    strategy: 'none',
    fixRuleId: null,
    reviewLevel: 'standard',
    changes: [],
    patchFile: null,
    explanation: '',
    refusal: null,
    verification: { ...NOT_RUN },
    ai: { used: false, label: null, promptSha256: null },
  };
}

export function refusedEntry(f: Finding, code: RefusalCode, message: string): HealResultEntry {
  const text = clip(message, 400);
  return { ...baseEntry(f), status: 'refused', explanation: clip(message, 600), refusal: { code, message: text } };
}

export function plainEntry(f: Finding, status: 'not-locator' | 'nothing-to-heal' | 'error', explanation: string): HealResultEntry {
  return { ...baseEntry(f), status, explanation: clip(explanation, 600) };
}
