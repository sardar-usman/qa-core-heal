import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type ElementHandle, type Locator, type Page, type FrameLocator } from 'playwright';
import { emitLocatorCall, resolve as resolveIntent, type CascadeLevel, type Scope } from './selectors.js';
import { healResolve } from './heal-resolve.js';
import { installEvalShim } from './eval-shim.js';
import { resolvePlaywrightConfig } from './playwright-config.js';
import {
  buildRoutePlan, routesForLocator, routeLabel, resolveRoute, stripAutoSuffixes, hasExplicitRoute, type RouteOverride,
} from './routes.js';
import { kindsFromTokens, kindsFromTrailingApi, kindOfElement, kindConflict, type ElementKind } from './kind.js';
import { matchFuzzy, type FuzzyCandidate } from './fuzzy.js';
import { loadAuthSetup, withTimeout } from './auth-setup.js';

/**
 * Standalone selector healing for an existing Playwright spec.
 *
 * Given a spec whose selectors no longer match the live page, this:
 *
 *   1. Loads the spec and, if it uses POM, the page-object files it imports
 *      (the locators live there, not in the spec).
 *   2. Opens the live page the spec targets (from a page.goto or the page
 *      object's `url`, or an explicit --base-url).
 *   3. Probes every locator against the live page. One that still resolves is
 *      left untouched.
 *   4. A locator that no longer resolves is re-resolved with the SAME locator
 *      ladder and healResolve logic the Explorer uses (semantic intent, a
 *      different stable locator), NOT an LLM guess.
 *   5. Confirms the re-resolved element is the SAME intended element (its
 *      accessible name / text / label still matches the original intent). A
 *      heal to the wrong element is worse than no heal, so an unconfirmed or
 *      ambiguous match is refused.
 *   6. Writes the repaired files back and reports every heal and every locator
 *      it could not heal. An unhealable selector is reported, never silently
 *      left or wrongly changed.
 *
 * This is fully deterministic: no spec run, no model call. It reuses
 * `healResolve` and the cascade from selectors.ts, and `emitLocatorCall` to
 * write the new locator, so there is one locator ladder in the codebase.
 */

export interface HealOptions {
  /** Single spec path; kept for back-compat. Use specPaths for a whole run. */
  specPath?: string;
  /**
   * All spec files of the run, healed jointly: a page object imported by
   * several specs is scanned once and probed on every importing spec's route.
   */
  specPaths?: string[];
  /** Per-file route overrides (--route <file>=<route>). */
  routeOverrides?: RouteOverride[];
  /**
   * Run-first mode: probe ONLY locator calls matching these selectors (as
   * Playwright prints them, e.g. "locator('#x')"), each on its failure-time
   * URL when known. Calls not matching any target are skipped entirely.
   */
  targets?: HealTarget[];
  /** Base URL override. When absent, resolved from the project's playwright config, then the specs. */
  baseUrl?: string;
  /** Playwright project name, for configs whose projects disagree on baseURL. */
  project?: string;
  /** Write repaired files to disk. Default true; false previews without writing. */
  write?: boolean;
  /** Accepted for back-compat with older callers; unused (healing is model-free). */
  model?: string;
  onEvent?: (event: HealEvent) => void;
  /** Cap on heals recorded per run; heals beyond the cap are refused. */
  maxHeals?: number;
  /** When set, a heal landing on a cascade level not in this list is refused. */
  allowedLevels?: CascadeLevel[];
  /** Follow relative imports to page objects. Default true. */
  followImports?: boolean;
  /** Extra directories whose .ts/.js files are also scanned for locators. */
  pageObjectDirs?: string[];
  /** Playwright storage state file for authenticated pages. */
  storageState?: string;
  /**
   * "file#exportName" of the user's own login function, called with a page
   * in the probing context before probing. Takes precedence over
   * storageState. Failures are loud, never a silent unauthenticated probe.
   */
  authSetup?: string;
  /** Milliseconds before a hanging auth setup fails the run. Default 60000. */
  authSetupTimeout?: number;
  /**
   * Cap (ms) on the mutation-quiet settle before fuzzy candidate
   * collection on SPA pages. Default 2000; 0 disables the wait.
   */
  settleMs?: number;
}

export type HealEvent =
  | { type: 'scanned'; total: number; files: number }
  | { type: 'opened_page'; url: string }
  | { type: 'intact'; selector: string }
  | { type: 'healing'; selector: string; file: string }
  | { type: 'healed'; old: string; new: string; level: CascadeLevel; file: string }
  | { type: 'unhealed'; selector: string; reason: string; file: string }
  | { type: 'done'; healed: number; unhealed: number; intact: number; total: number; files: string[] };

export interface HealTarget {
  /** Selector call text, root stripped: "locator('#x')", "getByRole(...)". */
  selector: string;
  /** Page URL at failure time; absent falls back to route inference. */
  url?: string;
  /** Title of the failing test, for reporting. */
  test?: string;
  /** Failure stack frames (most specific first), the PRIMARY match signal. */
  locations?: Array<{ file: string; line: number }>;
  /**
   * The failure was a strict mode violation: the locator matched SEVERAL
   * elements. A probe finding a multi-match must treat that as the failure
   * itself (positional intent was deleted), never as an intact locator.
   */
  strict?: boolean;
}

export interface HealDetail { file: string; line: number; old: string; new: string; level: CascadeLevel }
export interface UnhealDetail { file: string; selector: string; reason: string }

/** One entry per scanned locator, in scan order. Powers the machine-readable report. */
export interface LocatorReport {
  /** Relative to the working directory, forward slashes. */
  file: string;
  /** 1-indexed source line. */
  line: number;
  old: string;
  /** The proposed replacement call; null unless healed. */
  new: string | null;
  /** Healed: the new locator's cascade level. Otherwise the original locator's. */
  level: CascadeLevel;
  ambiguous: boolean;
  status: 'healed' | 'intact' | 'refused';
  /** Present only when status is refused. */
  reason?: string;
}

export interface HealResult {
  /** The spec path when it (or a POM file) was written; null when nothing changed. */
  healedPath: string | null;
  filesWritten: string[];
  scanned: number;
  intact: number;
  healed: HealDetail[];
  unhealable: UnhealDetail[];
  /** Total locators scanned. Kept for back-compat with `${healed}/${total}` callers. */
  total: number;
  /** One entry per scanned locator, in scan order. */
  locators: LocatorReport[];
  /** Spec path -> every file gathered for it (itself + page objects). */
  specFiles: Record<string, string[]>;
  /** Targets that matched NO locator call in the gathered sources. */
  unmatchedTargets: HealTarget[];
}

/* ─────────────────────────── parsing ─────────────────────────── */

const LOCATOR_METHODS = [
  'getByRole', 'getByLabel', 'getByPlaceholder', 'getByText',
  'getByAltText', 'getByTitle', 'getByTestId', 'locator',
] as const;
type LocatorMethod = (typeof LOCATOR_METHODS)[number];

interface LocatorArgs {
  role?: string; name?: string; exact?: boolean;
  label?: string; placeholder?: string; text?: string;
  alt?: string; title?: string; testid?: string;
  css?: string; xpath?: string;
  /** The { hasText: "..." } filter on a locator() call, when present. */
  hasText?: string;
  /**
   * Every getByRole option beyond name/exact, parsed to canonical values
   * (checked/disabled/expanded/includeHidden/pressed/selected as booleans,
   * level as a number). Part of the call's identity: checked:false means
   * an UNCHECKED checkbox, not an unset option.
   */
  roleOpts?: Record<string, boolean | number>;
}

interface LocatorCall {
  file: string;
  line: number;      // 1-indexed line the call STARTS on
  startCol: number;  // 0-indexed within the start line
  /** Line the call's closing paren sits on: > line for a wrapped call. */
  endLine: number;
  endCol: number;    // exclusive, within endLine
  /** The `page...getByX(...)` text, newlines collapsed for display; no trailing .first()/.click(). */
  raw: string;
  root: string;      // 'page' or 'this.page'
  method: LocatorMethod;
  level: CascadeLevel;
  frameChain: string[];
  args: LocatorArgs;
  /** Rest of the END line after the call: the API chained on it (".fill(...)"). */
  trailing: string;
}

/** Read a JS string literal starting at s[i] (a quote). Returns its value and end index. */
function readString(s: string, i: number): { value: string; end: number } | null {
  const quote = s[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let out = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      const n = s[j + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : (n ?? '');
      j += 2;
      continue;
    }
    if (c === quote) return { value: out, end: j + 1 };
    out += c;
    j++;
  }
  return null;
}

/** Index of the ')' matching the '(' at `open`, skipping string literals. -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === '`') {
      const r = readString(s, j);
      if (!r) return -1;
      j = r.end - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** First string literal anywhere in a fragment. */
function firstString(s: string): string | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' || s[i] === "'" || s[i] === '`') {
      const r = readString(s, i);
      if (r) return r.value;
    }
  }
  return null;
}

/** Value of a `<key>: "..."` string option, with or without a quoted key (JSON emits `"name":`). */
function namedString(s: string, key: string): string | null {
  const m = s.match(new RegExp(`["']?\\b${key}\\b["']?\\s*:\\s*`));
  if (!m || m.index == null) return null;
  const at = m.index + m[0].length;
  const r = readString(s, at);
  return r ? r.value : null;
}

function levelOf(method: LocatorMethod, args: LocatorArgs): CascadeLevel {
  switch (method) {
    case 'getByRole': return 'role';
    case 'getByLabel': return 'label';
    case 'getByPlaceholder': return 'placeholder';
    case 'getByText': return 'text';
    case 'getByAltText': return 'alt';
    case 'getByTitle': return 'title';
    case 'getByTestId': return 'testid';
    case 'locator': return args.xpath ? 'xpath' : 'css';
  }
}

/** getByRole boolean options beyond exact; a fixed list keeps signatures canonical. */
const ROLE_BOOL_OPTS = ['checked', 'disabled', 'expanded', 'includeHidden', 'pressed', 'selected'] as const;

function parseArgs(method: LocatorMethod, argsRaw: string): LocatorArgs {
  const first = firstString(argsRaw);
  switch (method) {
    case 'getByRole': {
      // exact:false is Playwright's default, canonically equal to absent;
      // every OTHER boolean keeps its explicit value (checked:false is an
      // assertion about state, not an omission).
      const roleOpts: Record<string, boolean | number> = {};
      for (const k of ROLE_BOOL_OPTS) {
        const m = argsRaw.match(new RegExp(`["']?\\b${k}\\b["']?\\s*:\\s*(true|false)\\b`));
        if (m) roleOpts[k] = m[1] === 'true';
      }
      const lm = argsRaw.match(/["']?\blevel\b["']?\s*:\s*(\d+)/);
      if (lm) roleOpts.level = Number(lm[1]);
      return {
        role: first ?? '',
        name: namedString(argsRaw, 'name') ?? undefined,
        exact: /["']?\bexact\b["']?\s*:\s*true\b/.test(argsRaw),
        roleOpts: Object.keys(roleOpts).length > 0 ? roleOpts : undefined,
      };
    }
    case 'getByLabel': return { label: first ?? '' };
    case 'getByPlaceholder': return { placeholder: first ?? '' };
    case 'getByText': return { text: first ?? '' };
    case 'getByAltText': return { alt: first ?? '' };
    case 'getByTitle': return { title: first ?? '' };
    case 'getByTestId': return { testid: first ?? '' };
    case 'locator': {
      const s = first ?? '';
      const hasText = namedString(argsRaw, 'hasText') ?? undefined;
      if (s.startsWith('xpath=')) return { xpath: s.slice('xpath='.length), hasText };
      if (s.startsWith('//') || s.startsWith('./') || s.startsWith('(//')) return { xpath: s, hasText };
      return { css: s, hasText };
    }
  }
}

/**
 * Extract every locator chain in a file: page[.frameLocator(...)].getByX(...)
 * / .locator(...). Scans the WHOLE source, not lines: a prettier-wrapped
 * call whose options object spans several lines (the real-world shape for
 * any getByRole with a long name + exact:true) is one call, parsed whole.
 * Missing those made run mode report a failing locator that exists
 * verbatim in the POM as "could not be matched to source".
 */
function parseLocatorCalls(src: string, file: string): LocatorCall[] {
  const calls: LocatorCall[] = [];
  // Line-start offsets, for offset -> (1-indexed line, 0-indexed col).
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') lineStarts.push(i + 1);
  }
  const posOf = (offset: number): { line: number; col: number } => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - lineStarts[lo]! };
  };
  const rootRe = /(?<![\w.$])(this\.page|page)\b/g;
  let rm: RegExpExecArray | null;
  while ((rm = rootRe.exec(src)) !== null) {
    const root = rm[1]!;
    let pos = rm.index + root.length;
    const frameChain: string[] = [];
    let matched: LocatorMethod | null = null;
    let open = -1;
    // Consume any .frameLocator("...") prefixes, then the terminal locator method.
    for (;;) {
      if (src.startsWith('.frameLocator(', pos)) {
        const fo = pos + '.frameLocator'.length;
        const fc = matchParen(src, fo);
        if (fc < 0) break;
        const inner = firstString(src.slice(fo + 1, fc));
        if (inner != null) frameChain.push(inner);
        pos = fc + 1;
        continue;
      }
      for (const m of LOCATOR_METHODS) {
        if (src.startsWith('.' + m + '(', pos)) { matched = m; open = pos + 1 + m.length; break; }
      }
      break;
    }
    if (!matched || open < 0) continue;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const argsRaw = src.slice(open + 1, close);
    const args = parseArgs(matched, argsRaw);
    const start = posOf(rm.index);
    const end = posOf(close + 1);
    const lineEnd = src.indexOf('\n', close + 1);
    calls.push({
      file,
      line: start.line, startCol: start.col,
      endLine: end.line, endCol: end.col,
      // Collapse the wrapping for display and matching; the edit
      // coordinates above, not this text, drive the write-back.
      raw: src.slice(rm.index, close + 1).replace(/\s*\n\s*/g, ' '),
      root, method: matched,
      level: levelOf(matched, args), frameChain, args,
      trailing: src.slice(close + 1, lineEnd < 0 ? src.length : lineEnd),
    });
    // Never re-scan inside the consumed call (a root token in a string
    // literal argument is not a new chain).
    rootRe.lastIndex = close + 1;
  }
  return calls;
}

/* ─────────────────────── file + url discovery ─────────────────────── */

interface SourceFile { path: string; src: string }

/**
 * The spec plus every relative-imported page-object file that exists on
 * disk, followed RECURSIVELY: a page object importing another page object
 * (a widget two imports deep) is gathered too, cycle-safe and capped.
 */
function gatherFiles(
  specPath: string,
  specSrc: string,
  followImports: boolean,
  pageObjectDirs?: string[],
): SourceFile[] {
  const files: SourceFile[] = [{ path: specPath, src: specSrc }];
  const seen = new Set([specPath]);
  if (followImports) {
    const queue: SourceFile[] = [files[0]!];
    while (queue.length > 0 && files.length < 200) {
      const current = queue.shift()!;
      const dir = path.dirname(current.path);
      for (const m of current.src.matchAll(/import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.')) continue; // package import, not a local page object
        const resolved = resolveImport(dir, spec);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          const f = { path: resolved, src: fs.readFileSync(resolved, 'utf8') };
          files.push(f);
          queue.push(f);
        }
      }
    }
  }
  // Extra page-object directories from config. Scanned flat (not recursive),
  // sorted for a deterministic scan order, deduped against imported files.
  for (const d of pageObjectDirs ?? []) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names.sort()) {
      if (!/\.(ts|js)$/.test(name)) continue;
      const p = path.resolve(d, name);
      if (seen.has(p)) continue;
      try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
      seen.add(p);
      files.push({ path: p, src: fs.readFileSync(p, 'utf8') });
    }
  }
  return files;
}

/** Resolve a relative import to a real file, trying the common extensions. */
function resolveImport(fromDir: string, spec: string): string | null {
  const base = path.resolve(fromDir, spec);
  const candidates = [
    base, `${base}.ts`, `${base}.js`,
    base.replace(/\.js$/, '.ts'), base.replace(/\.ts$/, '.js'),
    path.join(base, 'index.ts'), path.join(base, 'index.js'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* not this one */ }
  }
  return null;
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

/**
 * The base URL the spec targets, in priority order:
 *   1. an explicit override (--base-url flag or qa-core.config.json baseUrl)
 *   2. use.baseURL from the project's own playwright.config.ts/.js, actually
 *      imported (defineConfig and env vars evaluate; no text scraping)
 *   3. the first absolute URL in a page.goto() call in the scanned files
 *   4. an absolute page-object `url` property
 * Only when all of these fail does the CLI ask for --base-url.
 */
async function resolveBaseUrl(
  files: SourceFile[],
  roots: string[],
  baseUrl: string | undefined,
  project?: string,
): Promise<{ url: string | null; configStorageState: string | null }> {
  let configStorageState: string | null = null;
  let url: string | null = baseUrl ?? null;
  for (const root of roots) {
    if (url && configStorageState) break;
    const res = await resolvePlaywrightConfig(root, project);
    if (!res) continue; // no config in this root
    if (!configStorageState && res.storageState) configStorageState = res.storageState;
    if (url) continue;
    if (res.baseUrl) {
      url = res.baseUrl;
      continue;
    }
    // A config that exists but could not deliver a baseURL is a FAILURE to
    // report, never a silent absence.
    const name = path.basename(res.configPath);
    if (res.loadError) {
      console.error(`${name} failed to load (${res.loadError}); falling back to goto() scan / --base-url`);
    } else if (res.disagreement) {
      const list = res.disagreement.map((p) => `${p.name}: ${p.baseURL}`).join(', ');
      console.error(`${name} defines projects with different baseURLs (${list}); pass --project <name> or --base-url`);
    }
  }
  if (!url) {
    for (const f of files) {
      const g = f.src.match(/\.goto\(\s*["'`](https?:\/\/[^"'`]+)["'`]/);
      if (g) { url = g[1]!; break; }
    }
  }
  if (!url) {
    for (const f of files) {
      const u = f.src.match(/\burl\s*[:=]\s*["'`](https?:\/\/[^"'`]+)["'`]/);
      if (u) { url = u[1]!; break; }
    }
  }
  return { url, configStorageState };
}

/** Conventional storage-state locations, tried when nothing is declared. */
const STORAGE_STATE_CONVENTIONS = ['.auth/state.json', 'playwright/.auth/user.json'];

/* ─────────────────── live probing + confirmation ─────────────────── */

function scopeFor(page: Page, frameChain: string[]): Scope {
  let scope: Scope = page;
  for (const f of frameChain) scope = (scope as Page | FrameLocator).frameLocator(f);
  return scope;
}

/** Rebuild the actual Playwright locator so we can ask the live page if it still resolves. */
function buildLocator(page: Page, call: LocatorCall) {
  const scope = scopeFor(page, call.frameChain);
  const a = call.args;
  const role = (a.role ?? '') as Parameters<Page['getByRole']>[0];
  switch (call.method) {
    case 'getByRole': {
      const opts: Record<string, unknown> = { ...(a.roleOpts ?? {}) };
      if (a.name) {
        opts.name = a.name;
        if (a.exact) opts.exact = a.exact;
      }
      return Object.keys(opts).length > 0
        ? scope.getByRole(role, opts as Parameters<Page['getByRole']>[1])
        : scope.getByRole(role);
    }
    case 'getByLabel': return scope.getByLabel(a.label ?? '');
    case 'getByPlaceholder': return scope.getByPlaceholder(a.placeholder ?? '');
    case 'getByText': return scope.getByText(a.text ?? '');
    case 'getByAltText': return scope.getByAltText(a.alt ?? '');
    case 'getByTitle': return scope.getByTitle(a.title ?? '');
    case 'getByTestId': return scope.getByTestId(a.testid ?? '');
    case 'locator': return scope.locator(a.xpath ? `xpath=${a.xpath}` : (a.css ?? ''));
  }
}

/** The human-readable identity the original locator carried, used to re-find and confirm. */
function intentToken(call: LocatorCall): string {
  const a = call.args;
  switch (call.level) {
    case 'role': return a.name ?? '';
    case 'label': return a.label ?? '';
    case 'placeholder': return a.placeholder ?? '';
    case 'text': return a.text ?? '';
    case 'alt': return a.alt ?? '';
    case 'title': return a.title ?? '';
    case 'testid': return a.testid ?? '';
    case 'css':
    case 'css-tag-fix': return tokenFromCss(a.css ?? '');
    case 'xpath': return '';
  }
}

/** Best-effort human token from a CSS selector (id / class / attribute value). */
function tokenFromCss(css: string): string {
  const attr = css.match(/\[(?:data-test(?:id)?|name|aria-label|placeholder|title|alt)\s*=\s*["']?([^"'\]]+)/i);
  if (attr) return attr[1]!.replace(/[-_]+/g, ' ').trim();
  const idOrClass = css.match(/[#.]([A-Za-z][\w-]{1,})/);
  if (idOrClass) return idOrClass[1]!.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return '';
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The element kind(s) the original locator implies: keyword tokens in the
 * selector itself (id/class/attribute/tag words, or the getByRole role) plus
 * the API chained on the call site (.fill → text input, .check → checkable).
 * Empty when the selector says nothing about kind.
 */
function expectedKindsOf(call: LocatorCall): ElementKind[] {
  const a = call.args;
  const selectorText = call.method === 'getByRole'
    ? (a.role ?? '')
    : (a.css ?? a.xpath ?? a.testid ?? '');
  const out = kindsFromTokens(selectorText);
  for (const k of kindsFromTrailingApi(call.trailing)) {
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * How long the identity probe watches the element between its two reads.
 * Long enough that any timer-driven attribute rewriting shows up, short
 * enough to add no visible latency to a heal.
 */
const IDENTITY_WINDOW_MS = 45;

interface IdentityProbe {
  /** Keyed identity evidence at the start of the window. */
  first: Array<[string, string]>;
  /** The same evidence read again at the end of the window. */
  second: Array<[string, string]>;
  /** Evidence keys the MutationObserver saw change during the window. */
  mutated: string[];
  /**
   * Values the MutationObserver saw pass through during the window (the
   * oldValue of each mutation). Without these, two endpoint reads that land
   * in the same phase of a fast flip would miss the other phase's value and
   * the instability reason would itself be timing-dependent.
   */
  observed: Array<[string, string]>;
}

/**
 * Read the element's identity evidence (accessible name sources + text + id)
 * twice over a short window, with a MutationObserver bridging the gap so a
 * value that flips and flips back between the reads is still caught. Runs on
 * a pinned ElementHandle inside ONE evaluate call, so the same physical DOM
 * node is read both times and nothing can be re-queried in between.
 */
async function probeIdentity(handle: ElementHandle<SVGElement | HTMLElement>): Promise<IdentityProbe> {
  return handle.evaluate(async (el, windowMs) => {
    const ATTRS = ['aria-label', 'placeholder', 'name', 'alt', 'title', 'value', 'data-testid', 'data-test'];
    const read = (): Array<[string, string]> => {
      const out: Array<[string, string]> = [];
      for (let i = 0; i < ATTRS.length; i++) {
        const v = el.getAttribute(ATTRS[i]!);
        if (v) out.push(['attr:' + ATTRS[i], v]);
      }
      const inp = el as HTMLInputElement;
      if (typeof inp.value === 'string' && inp.value) out.push(['prop:value', inp.value]);
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) out.push(['text', t]);
      if (el.id) out.push(['id', el.id]);
      // Associated label text: for label-for inputs this IS the accessible
      // name, and often the only human identity the element carries.
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length > 0) {
        const lt = (labels[0]!.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (lt) out.push(['label', lt]);
      }
      return out;
    };
    const mutated = new Set<string>();
    const observed: Array<[string, string]> = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName) {
          let key: string | null = null;
          if (r.attributeName === 'id') key = 'id';
          else if (ATTRS.indexOf(r.attributeName) >= 0) key = 'attr:' + r.attributeName;
          if (key) {
            mutated.add(key);
            if (r.oldValue) observed.push([key, r.oldValue]);
          }
        } else {
          mutated.add('text');
          if (r.type === 'characterData' && r.oldValue) observed.push(['text', r.oldValue]);
        }
      }
    });
    observer.observe(el, {
      attributes: true, attributeOldValue: true,
      childList: true, characterData: true, characterDataOldValue: true,
      subtree: true,
    });
    const first = read();
    await new Promise((res) => setTimeout(res, windowMs));
    const second = read();
    observer.disconnect();
    return { first, second, mutated: Array.from(mutated), observed };
  }, IDENTITY_WINDOW_MS);
}

interface ConfirmResult {
  confirmed: boolean;
  /** True when confirmation failed but a DISCARDED (unstable) value would have matched. */
  unstableMatch: boolean;
  /** On a genuine mismatch: what WAS found, so the refusal is debuggable. */
  got?: string;
}

/** Lowercase, whitespace collapsed, AND separators unified: "search_field"
 *  and "search field" are the same identity word sequence. */
function normSep(s: string): string {
  return norm(s).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The separator/case-complete canonical word sequence: camelCase split
 * BEFORE lowercasing (norm/normSep lowercase first, which destroys the
 * camel boundary), then every separator unified to a single space. Glued,
 * snake, kebab, camel, and spaced forms of an identifier all normalize to
 * the same string: "ajaxButton", "ajax_button", "ajax-button", and
 * "ajax Button" are all "ajax button".
 */
function normWords(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Stable logical identity of an element: what it IS, not which node. */
interface Fingerprint {
  tag: string; id: string; name: string; testid: string; type: string;
  role: string; ariaLabel: string; placeholder: string; text: string;
  labelText: string;
  box: { x: number; y: number; w: number; h: number } | null;
}

/** Read the fingerprint via a FRESH locator query; retries ride out a node
 *  being replaced mid-read (SPA re-renders swap nodes; locators re-query).
 *  A read landing on a node DETACHED between resolution and evaluation is
 *  a mid-render artifact, not evidence — its zero-sized box would fake a
 *  geometry disagreement — so it throws into the retry. */
async function readFingerprint(locator: ReturnType<typeof buildLocator>): Promise<Fingerprint | null> {
  for (let i = 0; i < 3; i++) {
    try {
      return await locator.first().evaluate((el) => {
        if (!el.isConnected) throw new Error('detached mid-render');
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          name: el.getAttribute('name') ?? '',
          testid: el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? '',
          type: el.getAttribute('type') ?? '',
          role: el.getAttribute('role') ?? '',
          ariaLabel: el.getAttribute('aria-label') ?? '',
          placeholder: el.getAttribute('placeholder') ?? '',
          text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
          labelText: (() => {
            const labels = (el as HTMLInputElement).labels;
            return labels && labels.length > 0
              ? (labels[0]!.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
              : '';
          })(),
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      });
    } catch {
      await new Promise((res) => setTimeout(res, 60));
    }
  }
  return null;
}

/** Same logical element: identity fields equal, geometry within tolerance.
 *  Deliberately RAW equality, no separator/case normalization: this compares
 *  two reads of the SAME locator with itself — any difference means the
 *  element changed between reads, whatever its spelling convention. */
function fingerprintsAgree(a: Fingerprint, b: Fingerprint): boolean {
  const identityEqual = a.tag === b.tag && a.id === b.id && a.name === b.name
    && a.testid === b.testid && a.type === b.type && a.role === b.role
    && a.ariaLabel === b.ariaLabel && a.placeholder === b.placeholder
    && a.text === b.text && a.labelText === b.labelText;
  if (!identityEqual) return false;
  if (!a.box || !b.box) return true;
  const close = (x: number, y: number): boolean => Math.abs(x - y) <= 5;
  return close(a.box.x, b.box.x) && close(a.box.y, b.box.y)
    && close(a.box.w, b.box.w) && close(a.box.h, b.box.h);
}

/** Compact, secret-free description for mismatch diagnostics. */
function describeFingerprint(f: Fingerprint): string {
  let out = f.tag;
  if (f.id) out += `[id="${f.id}"]`;
  if (f.name) out += `[name="${f.name}"]`;
  if (f.type) out += `[type="${f.type}"]`;
  if (!f.id && !f.name && f.text) out += ` "${f.text}"`;
  if (f.box) out += ` at (${f.box.x}, ${f.box.y})`;
  return out;
}

/**
 * Confirm the re-resolved element is the SAME intended element: its accessible
 * name / text / label must still carry the original token. This is the guard
 * that makes a wrong heal (to a different element) fail instead of shipping.
 *
 * Three layers, in order:
 *   1. The pinned-handle probe: identity evidence read twice with a mutation
 *      watch in between; values that changed during the window are discarded
 *      before matching. When only DISCARDED evidence would have matched, the
 *      refusal is the deterministic instability one (hostile pages).
 *   2. Churn tolerance: SPA re-renders replace nodes mid-probe, so a failed
 *      attempt retries once after a short settle.
 *   3. The fingerprint pass: two FRESH locator reads compared as logical
 *      identity (tag, key attributes, accessible-name sources, geometry
 *      within tolerance) — agreement means the same logical element even if
 *      every node was replaced. Agreeing fingerprints that still do not
 *      carry the token are a GENUINE mismatch, refused with the diff named.
 *
 * Matching compares separator-normalized forms too: an attribute
 * "search_field" carries the token "search field 1".
 */
async function confirmSameElement(locator: ReturnType<typeof buildLocator>, token: string): Promise<ConfirmResult> {
  const nt = norm(token);
  if (nt.length < 2) return { confirmed: false, unstableMatch: false }; // nothing specific enough to confirm against
  const st = normSep(token);
  const wt = normWords(token);
  // Every identity comparison in the confirm/fingerprint path goes through
  // this one predicate. Three canonical forms, each a monotonic widening of
  // the last: raw lowercase (norm), separator-unified (normSep), and the
  // camel-aware word sequence (normWords) — so a candidate carrying the
  // token as ANY of glued/snake/kebab/camel/spaced matches. The real-world
  // failure this pins: token "ajax Button" (from .ajaxButton) against the
  // element's id "ajaxButton" — equal only after the camel split.
  const matches = (s: string): boolean => {
    const ns = norm(s);
    if (ns && (ns.includes(nt) || (ns.length >= 3 && nt.includes(ns)))) return true;
    const ss = normSep(s);
    if (ss && (ss.includes(st) || (ss.length >= 3 && st.includes(ss)))) return true;
    const ws = normWords(s);
    return !!ws && !!wt && (ws.includes(wt) || (ws.length >= 3 && wt.includes(ws)));
  };

  const attempt = async (): Promise<'confirmed' | 'unstable' | 'nomatch' | 'gone'> => {
    const handle = await locator.first().elementHandle().catch(() => null);
    if (!handle) return 'gone';
    let probe: IdentityProbe;
    try {
      probe = await probeIdentity(handle);
    } catch {
      return 'gone';
    } finally {
      await handle.dispose().catch(() => undefined);
    }
    const secondByKey = new Map(probe.second);
    const unstableKeys = new Set(probe.mutated);
    const stable: string[] = [];
    const discarded: string[] = [];
    for (const [key, v1] of probe.first) {
      const v2 = secondByKey.get(key);
      if (!unstableKeys.has(key) && v2 === v1) {
        stable.push(v1);
      } else {
        discarded.push(v1);
        if (v2 != null && v2 !== v1) discarded.push(v2);
      }
    }
    const firstKeys = new Set(probe.first.map(([k]) => k));
    for (const [key, v2] of probe.second) {
      if (!firstKeys.has(key)) discarded.push(v2);
    }
    for (const [, oldValue] of probe.observed) discarded.push(oldValue);
    if (stable.some(matches)) return 'confirmed';
    if (discarded.some(matches)) return 'unstable';
    return 'nomatch';
  };

  let verdict = await attempt();
  if (verdict !== 'confirmed' && verdict !== 'unstable') {
    // Settle and retry once: rides out mid-render reads.
    await new Promise((res) => setTimeout(res, 250));
    verdict = await attempt();
  }
  if (verdict === 'confirmed') return { confirmed: true, unstableMatch: false };
  if (verdict === 'unstable') return { confirmed: false, unstableMatch: true };

  // Fingerprint pass: node identity no longer matters, logical identity does.
  const f1 = await readFingerprint(locator);
  await new Promise((res) => setTimeout(res, 120));
  const f2 = f1 ? await readFingerprint(locator) : null;
  if (!f1 || !f2) return { confirmed: false, unstableMatch: false };
  if (!fingerprintsAgree(f1, f2)) return { confirmed: false, unstableMatch: true };
  const identityValues = [f1.id, f1.name, f1.testid, f1.ariaLabel, f1.placeholder, f1.text, f1.labelText].filter(Boolean);
  if (identityValues.some(matches)) return { confirmed: true, unstableMatch: false };
  return { confirmed: false, unstableMatch: false, got: describeFingerprint(f1) };
}

/* ─────────────────────────── write-back ─────────────────────────── */

interface Edit { line: number; startCol: number; endLine: number; endCol: number; newRaw: string }

/** Replace each edit's span (possibly several lines, for a wrapped call)
 *  with its single-line replacement. Bottom-up, right-to-left, so earlier
 *  edits' coordinates stay valid; locator calls never overlap. */
function applyEdits(src: string, edits: Edit[]): string {
  const lines = src.split('\n');
  const sorted = [...edits].sort((a, b) => b.line - a.line || b.startCol - a.startCol);
  for (const e of sorted) {
    const head = (lines[e.line - 1] ?? '').slice(0, e.startCol);
    const tail = (lines[e.endLine - 1] ?? '').slice(e.endCol);
    lines.splice(e.line - 1, e.endLine - e.line + 1, head + e.newRaw + tail);
  }
  return lines.join('\n');
}

/* ─────────────────── selector identity (structural) ─────────────────── */

/**
 * Canonical identity of a locator call: the method plus its identity-
 * bearing arguments. Built from PARSED values, so quote style, spacing,
 * quoted-vs-bare option keys, and the receiver prefix never matter —
 * `page.getByRole("textbox", {"name":"X"})` in source and
 * `getByRole('textbox', { name: 'X' })` in a Playwright error are the
 * same identity.
 */
function argsSignature(method: LocatorMethod, args: LocatorArgs): string {
  const sig: Record<string, unknown> = { method };
  if (method === 'getByRole') {
    sig.role = args.role ?? '';
    if (args.name) sig.name = args.name;
    if (args.exact) sig.exact = true;
    // ALL remaining options, in a fixed key order so property order in the
    // source or the error rendering can never affect the signature.
    for (const k of ROLE_BOOL_OPTS) {
      if (args.roleOpts?.[k] !== undefined) sig[k] = args.roleOpts[k];
    }
    if (args.roleOpts?.level !== undefined) sig.level = args.roleOpts.level;
  } else if (method === 'locator') {
    if (args.xpath) sig.xpath = args.xpath;
    else sig.css = args.css ?? '';
    if (args.hasText) sig.hasText = args.hasText;
  } else {
    sig.value = args.label ?? args.placeholder ?? args.text ?? args.alt ?? args.title ?? args.testid ?? '';
  }
  return JSON.stringify(sig);
}

/** Signature of a selector call TEXT (e.g. from an error message), or null. */
export function selectorSignature(text: string): string | null {
  const t = text.trim();
  const m = t.match(/^(getByRole|getByLabel|getByPlaceholder|getByText|getByAltText|getByTitle|getByTestId|locator)\s*\(/);
  if (!m) return null;
  const method = m[1] as LocatorMethod;
  const open = m[0].length - 1;
  const close = matchParen(t, open);
  if (close < 0) return null;
  return argsSignature(method, parseArgs(method, t.slice(open + 1, close)));
}

/* ─────────────────────── fuzzy typo matching ─────────────────────── */

/**
 * The identifier fuzzy matching may score: the string identity a locator
 * carries. For semantic locators that is the name/label/placeholder/text
 * string itself; for CSS it is a SIMPLE #id/.class (compound selectors name
 * a position, not an identity), else the { hasText } filter when present.
 */
function fuzzySource(call: LocatorCall): string | null {
  const a = call.args;
  switch (call.level) {
    case 'role': return a.name || null;
    case 'label': return a.label || null;
    case 'placeholder': return a.placeholder || null;
    case 'text': return a.text || null;
    case 'title': return a.title || null;
    case 'alt': return a.alt || null;
    case 'testid': return a.testid || null;
    case 'css':
    case 'css-tag-fix': {
      const t = (a.css ?? '').trim();
      const m = t.match(/^[#.]([A-Za-z_][\w-]*)$/);
      if (m) return m[1]!;
      // A SINGLE attribute selector carries its value as the identity:
      // [name="search_f"] is the identifier "search_f". Compound
      // selectors stay excluded.
      const am = t.match(/^\[(?:name|id|data-testid|data-test|aria-label|placeholder)\s*=\s*["']([^"']+)["']\]$/);
      if (am) return am[1]!;
      return a.hasText || null;
    }
    case 'xpath': return a.hasText || null;
  }
}

/**
 * Positive evidence that a never-found element is state-dependent: its
 * selector names a UI pattern that typically exists only after user actions.
 * Without such a token the refusal must hedge — a plain missing element may
 * simply have been removed or renamed beyond recognition.
 */
const STATE_TOKENS = new Set([
  'toast', 'modal', 'alert', 'result', 'notification', 'snackbar',
  'dialog', 'popup', 'confirmation', 'flash',
]);

function stateDependencyHint(call: LocatorCall): string | null {
  const a = call.args;
  const sources = [a.css, a.xpath, a.testid, a.name, a.label, a.placeholder, a.text, a.title, a.alt, a.hasText];
  for (const s of sources) {
    if (!s) continue;
    const words = s.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/).filter(Boolean);
    for (const w of words) {
      if (STATE_TOKENS.has(w.toLowerCase())) return w.toLowerCase();
    }
  }
  return null;
}

/**
 * The teaching appendix for compound-CSS refusals: WHY the selector could
 * not be recovered and what to use instead. Appended to lacking-identity
 * refusals (no-identity, not-found) in both scan and run modes.
 */
const COMPOUND_HINT = 'compound CSS selectors carry little recoverable identity '
  + '(utility classes describe styling, not which element this is); '
  + 'consider getByRole or a data-testid';

/**
 * A CSS selector that is more than one simple token: tag+class chains,
 * multi-class stacks, combinators, positional pseudo-classes. A single
 * #id, .class, [attr] or bare tag is NOT compound.
 */
function isCompoundCss(call: LocatorCall): boolean {
  if (call.level !== 'css') return false;
  const css = (call.args.css ?? '').trim();
  if (!css) return false;
  return !/^(?:[#.][A-Za-z_][\w-]*|\[[^\]]+\]|[A-Za-z][A-Za-z0-9-]*)$/.test(css);
}

function withCompoundHint(call: LocatorCall, reason: string): string {
  if (!isCompoundCss(call)) return reason;
  return `${reason.replace(/\.$/, '')}; ${COMPOUND_HINT}`;
}

/** An element found by the fuzzy page scan, with enough identity to relocate it. */
interface ScannedElement extends FuzzyCandidate {
  tag: string;
  id: string | null;
  name: string | null;
  /** value -> which attribute carried it, for rebuilding a locator. */
  attrOf: Record<string, string>;
}

/** "quantity-field" → "quantity field", "NewsletterEmail" → "Newsletter Email". */
function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collect every element carrying an identifier, with its identity values:
 * attribute-based identities plus, for leaf elements, their own short
 * visible text (so getByText and hasText identities can fuzzy-match too).
 * Label elements are skipped as candidates — their text already counts as
 * the identity of the control they label; scoring them separately would
 * make every labeled input look ambiguous against itself.
 */
async function scanIdentifiers(
  page: Page,
  settleCapMs: number,
): Promise<{ settled: boolean; elements: ScannedElement[] }> {
  return page.evaluate(async (capMs: number) => {
    // Mutation-quiet settle: fetch-then-render SPAs populate the DOM late.
    // Waits for 150ms without mutations, capped; settled=false on cap.
    let settled = true;
    if (capMs > 0) {
      settled = await new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (ok: boolean): void => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(quietTimer);
          clearTimeout(capTimer);
          resolve(ok);
        };
        let quietTimer = setTimeout(() => finish(true), 150);
        const observer = new MutationObserver(() => {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish(true), 150);
        });
        observer.observe(document.documentElement, {
          subtree: true, childList: true, attributes: true, characterData: true,
        });
        const capTimer = setTimeout(() => finish(false), capMs);
      });
    }
    const out: Array<{
      display: string; values: string[]; tag: string;
      id: string | null; name: string | null; attrOf: Record<string, string>;
    }> = [];
    const entryOf = new Map<Element, { values: string[]; attrOf: Record<string, string> }>();
    const add = (el: Element, v: string | null | undefined, attr: string): void => {
      const t = v?.trim();
      if (!t) return;
      let entry = entryOf.get(el);
      if (!entry) {
        entry = { values: [], attrOf: {} };
        entryOf.set(el, entry);
      }
      if (entry.values.indexOf(t) >= 0) return;
      entry.values.push(t);
      entry.attrOf[t] = attr;
    };
    // The document plus every OPEN shadow root, discovered breadth-first
    // (nested roots included). Playwright locators pierce open shadow roots
    // natively — users' tests work there — so candidate evidence must come
    // from the same tree the locators see. Closed roots cannot be entered;
    // their presence is reported separately via the attachShadow hook.
    const roots: Array<Document | ShadowRoot> = [document];
    for (let r = 0; r < roots.length && roots.length <= 64; r++) {
      for (const el of Array.from(roots[r]!.querySelectorAll('*')).slice(0, 4000)) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    let textCount = 0;
    for (const root of roots) {
      // label[for] resolves by id WITHIN its own tree, so the map is per root.
      const labelFor = new Map<string, string>();
      for (const l of Array.from(root.querySelectorAll('label[for]'))) {
        const t = (l.textContent ?? '').replace(/\s+/g, ' ').trim();
        const f = l.getAttribute('for');
        if (t && f && !labelFor.has(f)) labelFor.set(f, t);
      }
      const attrEls = Array.from(
        root.querySelectorAll('[id], [name], [aria-label], [data-testid], [data-test], [placeholder]'),
      ).slice(0, 2000);
      for (const el of attrEls) {
        add(el, el.id, 'id');
        add(el, el.getAttribute('name'), 'name');
        add(el, el.getAttribute('aria-label'), 'aria-label');
        add(el, el.getAttribute('data-testid'), 'data-testid');
        add(el, el.getAttribute('data-test'), 'data-test');
        add(el, el.getAttribute('placeholder'), 'placeholder');
        if (el.id && labelFor.has(el.id)) add(el, labelFor.get(el.id)!, 'label');
      }
      // Leaf elements with short visible text. Skips labels (see above),
      // options (the select is the identity), and anything inside a label.
      const textEls = Array.from(
        root.querySelectorAll(root === document ? 'body *' : '*'),
      ).slice(0, 4000);
      for (const el of textEls) {
        if (textCount >= 2000) break;
        const tag = el.tagName.toLowerCase();
        if (tag === 'label' || tag === 'option' || tag === 'script' || tag === 'style' || tag === 'noscript') continue;
        if (el.children.length > 0 || el.closest('label')) continue;
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 80) continue;
        add(el, t, 'text');
        textCount++;
      }
    }
    // Render-random ids (React useId, hashes) make useless display names:
    // prefer a human identity for messages.
    const generatedId = (v: string): boolean =>
      /^[_:]?r[_:]?(?=[0-9a-z]*\d)[0-9a-z]+[_:.-]/i.test(v)
      || v.split(/[^A-Za-z0-9]+/).filter(Boolean)
        .every((w) => /^\d+$/.test(w) || (/^[0-9a-f]{4,}$/i.test(w) && /\d/.test(w)));
    for (const [el, entry] of entryOf) {
      const id = (el as HTMLElement).id || null;
      const name = el.getAttribute('name');
      const human = entry.values.find((v) => entry.attrOf[v] !== 'id' && entry.attrOf[v] !== 'name' && !generatedId(v));
      const display = id && !generatedId(id)
        ? `#${id}`
        : name && !generatedId(name)
          ? `[name="${name}"]`
          : human
            ? `"${human}"`
            : id
              ? `#${id}`
              : entry.values[0]!;
      out.push({
        display, values: entry.values, tag: el.tagName.toLowerCase(),
        id, name, attrOf: entry.attrOf,
      });
    }
    return { settled, elements: out };
  }, settleCapMs);
}

/* ─────────────── compound-selector tag-typo correction ─────────────── */

/**
 * Every valid HTML (living standard + obsolete-but-real) and SVG element
 * name, lowercased. Used as the reference list for tag-typo correction: a
 * leading selector token NOT in this set may be a typo; one IN it never is.
 * A deliberately broad list is the conservative choice — a name counted as
 * valid is merely left alone.
 */
const KNOWN_TAGS = new Set([
  // HTML
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base',
  'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
  'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select',
  'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th',
  'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
  // obsolete but real
  'acronym', 'big', 'center', 'dir', 'font', 'frame', 'frameset', 'marquee',
  'nobr', 'noframes', 'param', 'plaintext', 'strike', 'tt', 'xmp',
  // SVG (CSS tag matching in HTML documents is case-insensitive)
  'svg', 'animate', 'animatemotion', 'animatetransform', 'circle',
  'clippath', 'defs', 'desc', 'ellipse', 'feblend', 'fecolormatrix',
  'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
  'fediffuselighting', 'fedisplacementmap', 'fedistantlight',
  'fedropshadow', 'feflood', 'fefunca', 'fefuncb', 'fefuncg', 'fefuncr',
  'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology',
  'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight',
  'fetile', 'feturbulence', 'filter', 'foreignobject', 'g', 'image',
  'line', 'lineargradient', 'marker', 'mask', 'metadata', 'mpath', 'path',
  'pattern', 'polygon', 'polyline', 'radialgradient', 'rect', 'set',
  'stop', 'symbol', 'text', 'textpath', 'tspan', 'use', 'view',
  // MathML core
  'math', 'mfrac', 'mi', 'mn', 'mo', 'mroot', 'mrow', 'msqrt', 'msub',
  'msup', 'mtable', 'mtd', 'mtext', 'mtr',
]);

/** True when a and b are exactly ONE edit apart: an insertion, a deletion,
 *  a substitution, or an adjacent transposition. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let first = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (first < 0) { first = i; continue; }
      // A second mismatch: only an adjacent transposition survives.
      return first === i - 1 && a[i] === b[i - 1] && a[i - 1] === b[i]
        && a.slice(i + 1) === b.slice(i + 1);
    }
    return first >= 0;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

/**
 * Corrected full selectors for a compound CSS selector whose LEADING tag
 * token is not a valid element name, one per known tag a single edit away
 * ("buttons.btn.btn-primary" → ["button.btn.btn-primary"]). Empty when the
 * selector does not start with a tag token followed by more selector text
 * (so bare tags, .class/#id starts, and dashed custom elements are never
 * touched), when the tag is valid, or when nothing is one edit away. Which
 * correction (if any) may HEAL is decided by the caller's unique-match
 * probe; this only says what is worth probing.
 */
export function tagTypoCorrections(css: string): string[] {
  const m = css.trim().match(/^([A-Za-z][A-Za-z0-9_]*)([.#:[].+)$/s);
  if (!m) return [];
  const tag = m[1]!.toLowerCase();
  const rest = m[2]!;
  const out: string[] = [];
  if (tag.includes('_')) {
    // '_' is illegal in ANY tag name — custom elements use dashes, never
    // underscores — so this is always a typo: strip the underscore suffix,
    // then the same one-edit correction, distance 0 included (the strip
    // itself was the edit): "buttons_1" → "buttons" → "button".
    const stripped = tag.split('_')[0]!;
    if (stripped.length < 2) return [];
    for (const known of KNOWN_TAGS) {
      if (known === stripped || oneEditApart(stripped, known)) out.push(known + rest);
    }
    return out.sort();
  }
  if (KNOWN_TAGS.has(tag)) return [];
  for (const known of KNOWN_TAGS) {
    if (oneEditApart(tag, known)) out.push(known + rest);
  }
  return out.sort();
}

/** Plain edit distance (insert/delete/substitute), for the dashed-tag hint. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n]!;
}

/**
 * The known tag closest to `token` within `maxDist` edits, alphabetical on
 * ties, null when nothing is close enough. Hint-only: dashed tag names are
 * spec-legal custom elements and are NEVER auto-corrected.
 */
export function closestKnownTag(token: string, maxDist: number): string | null {
  let best: string | null = null;
  let bestD = maxDist + 1;
  for (const known of KNOWN_TAGS) {
    const d = editDistance(token.toLowerCase(), known);
    if (d < bestD || (d === bestD && best !== null && known < best)) {
      best = known;
      bestD = d;
    }
  }
  return bestD <= maxDist ? best : null;
}

/**
 * The teaching hint for a compound selector whose leading tag token is
 * DASHED: it may be a custom element (spec-legal) or a typo — undecidable
 * from the page, so no heal, but the refusal points at the likely fix.
 */
function dashedTagHint(call: LocatorCall): string | null {
  if (call.level !== 'css') return null;
  const m = (call.args.css ?? '').trim().match(/^([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)([.#:[].+)$/s);
  if (!m) return null;
  const token = m[1]!.toLowerCase();
  const closest = closestKnownTag(token, 2);
  return `'${token}' may be a custom element (dashed tag names are spec-legal) or a typo; `
    + `if it's a typo, correct it directly${closest ? ` - closest valid tag: '${closest}'` : ''}`;
}

/* ─────────────────────────── main ─────────────────────────── */

/** Outcome of probing one locator on one route. */
type RouteOutcome =
  | { kind: 'intact'; count: number }
  | {
      /**
       * A strict-failure locator matching SEVERAL elements on its failure
       * page: the deleted positional disambiguator cannot be recovered.
       * candidates carry each element's distinguishing descriptor.
       */
      kind: 'strict-multi';
      count: number;
      candidates: string[];
    }
  | { kind: 'no-identity' }
  | { kind: 'redirected'; to: string }
  | { kind: 'unresolved'; closest?: string }
  | { kind: 'ambiguous'; closeMatches?: string[]; candidates?: string[] }
  | {
      kind: 'resolved';
      newRaw: string;
      level: CascadeLevel;
      confirmed: boolean;
      unstableMatch: boolean;
      /** The candidate element's actual kind, for the kind-mismatch guard. */
      candidateKind: ElementKind | null;
      /** The token confirmation ran against, for mismatch diagnostics. */
      confirmToken: string;
      /** On a genuine mismatch: what WAS found (tag/attrs/geometry). */
      mismatch?: string;
      /**
       * The original call was getByRole with exact:true and the candidate
       * resolved at role level with the IDENTICAL exact name: the role is
       * the corrected hypothesis (link -> button), so the kind expectation
       * derived from the OLD role must not veto the heal.
       */
      roleCorrected?: boolean;
    };

export async function heal(opts: HealOptions): Promise<HealResult> {
  const specPaths = (opts.specPaths ?? (opts.specPath ? [opts.specPath] : []))
    .map((p) => path.resolve(p));
  if (specPaths.length === 0) throw new Error('No spec path given.');
  const write = opts.write !== false;

  // Gather each spec's files, deduped across specs: a page object imported
  // by several specs is scanned ONCE, but remembers every importing spec so
  // its locators can be probed on each of their routes.
  const files: SourceFile[] = [];
  const seenFiles = new Set<string>();
  const specFiles = new Map<string, string[]>();
  for (const sp of specPaths) {
    if (!fs.existsSync(sp)) throw new Error(`Spec not found: ${sp}`);
    const src = fs.readFileSync(sp, 'utf8');
    const gathered = gatherFiles(sp, src, opts.followImports !== false, opts.pageObjectDirs);
    const list: string[] = [];
    for (const f of gathered) {
      if (!seenFiles.has(f.path)) {
        seenFiles.add(f.path);
        files.push(f);
      }
      list.push(f.path);
    }
    specFiles.set(sp, list);
  }
  const calls = files.flatMap((f) => parseLocatorCalls(f.src, f.path));

  const roots = [process.cwd()];
  const specRoot = projectRootFor(specPaths[0]!);
  if (!roots.includes(specRoot)) roots.push(specRoot);
  const resolved = await resolveBaseUrl(files, roots, opts.baseUrl, opts.project);
  let url = resolved.url;
  // Nothing resolved, but run-mode targets carry failure-time trace URLs:
  // they already passed the main-frame and non-http filters, and with no
  // baseURL or absolute goto() to compare against, they ARE the best
  // knowledge available. A run must not die holding the right answer.
  let baseFromTrace = false;
  if (!url && opts.targets) {
    const fromTrace = opts.targets.find((t) => t.url && /^https?:\/\//.test(t.url))?.url;
    if (fromTrace) {
      try {
        url = new URL(fromTrace).origin + '/';
        baseFromTrace = true;
      } catch { /* unparseable; fall through to the error below */ }
    }
  }
  if (!url) {
    throw new Error(
      'Could not determine the target URL: no --base-url, no baseUrl in qa-core.config.json, '
      + 'no use.baseURL in playwright.config.ts/.js, and no absolute page.goto() in the spec. '
      + 'Pass --base-url <url>.',
    );
  }

  const plan = buildRoutePlan({ files, specFiles, overrides: opts.routeOverrides, baseUrl: url });

  // Which calls to probe, on which routes. With targets (run-first mode)
  // only matching calls are kept, each on its failure-time URL when known.
  //
  // Matching is NEVER textual: the runtime failure string and the source
  // representation format differently (quote style, spacing, receiver
  // prefix). The failure's stack frames are the primary signal — the
  // structurally-matching call nearest the frame wins, or the single
  // locator call sitting exactly on the frame line — with structural
  // matching across the whole import graph as the fallback.
  const unmatchedTargets: HealTarget[] = [];
  const selected: Array<{ call: LocatorCall; routes: string[]; noRoute?: boolean; strict?: boolean }> = [];
  if (opts.targets) {
    const sigOfCall = new Map<LocatorCall, string>();
    for (const c of calls) sigOfCall.set(c, argsSignature(c.method, c.args));
    // Origins a trace URL may legitimately point at: the resolved base URL
    // and every goto()/--route target. Anything else — a feedback-widget
    // iframe, an auth provider — is not a page this suite tests.
    const allowedOrigins = new Set<string>();
    const addOrigin = (u: string): void => {
      try { allowedOrigins.add(new URL(u).origin); } catch { /* not a URL */ }
    };
    addOrigin(url);
    for (const gotos of plan.gotosByFile.values()) {
      for (const g of gotos) addOrigin(resolveRoute(url, g.route));
    }
    for (const route of plan.overrideByFile.values()) addOrigin(resolveRoute(url, route));
    const traceUrlProblem = (u: string): string | null => {
      // Hard rejections always apply: about:blank, chrome-error://, and
      // anything unparseable can never be the failure page.
      if (!/^https?:\/\//.test(u)) return `non-http page "${u}"`;
      try {
        const origin = new URL(u).origin;
        // The origin check needs an anchor. With no resolvable baseURL and
        // no absolute goto() target (base derived FROM the trace), there is
        // nothing to compare against — trust the main-frame URL.
        if (!baseFromTrace && !allowedOrigins.has(origin)) {
          return `third-party origin ${origin} (matches neither the base URL nor any goto() target)`;
        }
      } catch {
        return 'unparseable URL';
      }
      return null;
    };
    const trustedNoted = new Set<string>();
    const urlsByCall = new Map<LocatorCall, Set<string>>();
    const strictCalls = new Set<LocatorCall>();
    for (const target of opts.targets) {
      const sig = selectorSignature(target.selector);
      const structural = sig ? calls.filter((c) => sigOfCall.get(c) === sig) : [];
      let matches: LocatorCall[] = [];
      for (const frame of target.locations ?? []) {
        const frameFile = path.resolve(frame.file);
        const inFile = calls.filter((c) => path.resolve(c.file) === frameFile);
        if (inFile.length === 0) continue;
        const structuralInFile = structural.filter((c) => inFile.includes(c));
        if (structuralInFile.length > 0) {
          structuralInFile.sort((a, b) =>
            Math.abs(a.line - frame.line) - Math.abs(b.line - frame.line) || a.line - b.line);
          matches = [structuralInFile[0]!];
          break;
        }
        const atLine = inFile.filter((c) => c.line === frame.line);
        if (atLine.length === 1) { matches = atLine; break; }
      }
      if (matches.length === 0) matches = structural;
      if (matches.length === 0) { unmatchedTargets.push(target); continue; }
      // Sanity-check the trace URL before trusting it as the failure page.
      let targetUrl = target.url;
      if (targetUrl) {
        const problem = traceUrlProblem(targetUrl);
        if (problem) {
          console.error(`discarded trace URL ${targetUrl} for ${target.selector}: ${problem}; falling back to route inference`);
          targetUrl = undefined;
        } else if (baseFromTrace && !trustedNoted.has(targetUrl)) {
          trustedNoted.add(targetUrl);
          console.error(`using failure page from trace: ${targetUrl}`);
        }
      }
      for (const call of matches) {
        const set = urlsByCall.get(call) ?? new Set<string>();
        if (targetUrl) set.add(targetUrl);
        urlsByCall.set(call, set);
        if (target.strict) strictCalls.add(call);
      }
    }
    for (const call of calls) {
      const urls = urlsByCall.get(call);
      if (!urls) continue;
      const strict = strictCalls.has(call);
      if (urls.size > 0) {
        // 1. The trace told us the page the test was on when it failed.
        selected.push({ call, routes: [...urls], strict });
      } else if (hasExplicitRoute(plan, call.file, call.line) || opts.baseUrl) {
        // 2. No trace: a statically inferred route (or a base URL the user
        //    gave EXPLICITLY) is a legitimate place to probe.
        selected.push({ call, routes: routesForLocator(plan, call.file, call.line), strict });
      } else {
        // 3. Neither: probing anything would be a guess about where the
        //    failure happened. Refuse loudly instead (decision phase).
        selected.push({ call, routes: [], noRoute: true, strict });
      }
    }
  } else {
    for (const call of calls) {
      selected.push({ call, routes: routesForLocator(plan, call.file, call.line) });
    }
  }

  opts.onEvent?.({ type: 'scanned', total: selected.length, files: files.length });

  const healed: HealDetail[] = [];
  const unhealable: UnhealDetail[] = [];
  const locators: LocatorReport[] = [];
  let intact = 0;
  const editsByFile = new Map<string, Edit[]>();
  const relFile = (f: string): string => path.relative(process.cwd(), f).split(path.sep).join('/');

  // The user's own login function, loaded up front so a broken module
  // fails BEFORE any browser work.
  const authSetup = opts.authSetup ? await loadAuthSetup(opts.authSetup, process.cwd()) : null;

  // Storage state, in priority order: explicit (--storage-state flag or
  // qa-core.config.json auth.storageState), the playwright config's own
  // use.storageState, then conventional locations. Detection never fails a
  // run — with nothing found, probing is unauthenticated as always. Only
  // the file PATH is ever logged; the contents stay out of every output.
  let storageState = opts.storageState && fs.existsSync(opts.storageState) ? opts.storageState : undefined;
  if (!storageState && !opts.storageState) {
    let detected: string | null = null;
    if (resolved.configStorageState && fs.existsSync(resolved.configStorageState)) {
      detected = resolved.configStorageState;
    }
    if (!detected) {
      outer: for (const root of roots) {
        for (const conv of STORAGE_STATE_CONVENTIONS) {
          const p = path.join(root, conv);
          if (fs.existsSync(p)) { detected = p; break outer; }
        }
      }
    }
    if (detected) {
      storageState = detected;
      console.error(`using storage state from ${detected}`);
    }
  }
  // A saved session is used FIRST when present: it is fast and runs no
  // user code. A configured auth setup is held as the FALLBACK for the
  // expired-session case (see the route loop). Never the reverse — a
  // failing auth setup must never be papered over by stale cookies.
  let authMode: 'setup' | 'state' | null = storageState ? 'state' : authSetup ? 'setup' : null;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    // The probing context carries the resolved base URL, exactly like a
    // Playwright test context with use.baseURL: relative navigation in
    // auth-setup login helpers (page.goto("/")) — or anywhere else during
    // probing — resolves the same way it does in the user's tests.
    const context = await browser.newContext({
      ...(storageState ? { storageState } : {}),
      baseURL: url,
    });
    await installEvalShim(context);
    // Closed shadow roots are undetectable after the fact (el.shadowRoot is
    // null by design), so their CREATION is recorded: every new document
    // gets an attachShadow wrapper counting mode:'closed' attachments.
    // Not-found refusals on pages with closed roots can then say why the
    // probe may be blind instead of leaving the absence unexplained.
    await context.addInitScript({
      content: `(() => {
        if (window.__qaCoreClosedShadowRoots !== undefined) return;
        window.__qaCoreClosedShadowRoots = 0;
        const orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) {
          if (init && init.mode === 'closed') window.__qaCoreClosedShadowRoots++;
          return orig.call(this, init);
        };
      })();`,
    });
    const page = await context.newPage();

    // Run the user's login function against the probing page. A throw or a
    // timeout fails the whole run loudly — probing unauthenticated behind
    // the user's back is never an acceptable fallback. Only the label
    // (path#export) and pass/fail are logged, never credentials or cookies.
    const runAuthSetup = async (): Promise<void> => {
      try {
        await withTimeout(authSetup!.fn(page), opts.authSetupTimeout ?? 60000);
        console.error(`auth setup ${authSetup!.label} succeeded`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Relative navigation with no base URL on the context is a config
        // problem, not a login problem — say so. (The context always gets
        // the resolved base URL above, so this only fires if resolution
        // ever yields none on a future code path.)
        const hint = /Cannot navigate to invalid URL/i.test(msg) && !url
          ? '; your login function navigates to a relative URL but no baseURL could be resolved; pass --base-url'
          : '';
        throw new Error(`auth setup ${authSetup!.label} failed: ${msg}${hint}`);
      }
    };
    if (authSetup && authMode !== 'state') await runAuthSetup();

    const refuse = (call: LocatorCall, reason: string, ambiguous: boolean): void => {
      unhealable.push({ file: call.file, selector: call.raw, reason });
      locators.push({
        file: relFile(call.file), line: call.line, old: call.raw, new: null,
        level: call.level, ambiguous, status: 'refused', reason,
      });
      opts.onEvent?.({ type: 'unhealed', selector: call.raw, reason, file: relFile(call.file) });
    };
    const markIntact = (call: LocatorCall, ambiguous: boolean): void => {
      intact++;
      locators.push({
        file: relFile(call.file), line: call.line, old: call.raw, new: null,
        level: call.level, ambiguous, status: 'intact',
      });
      opts.onEvent?.({ type: 'intact', selector: call.raw });
    };

    // Build the full resolved outcome for a candidate locator: capture the
    // element's actual kind (for the kind guard), confirm it is the SAME
    // intended element, and emit the replacement call.
    const resolvedOutcome = async (
      call: LocatorCall,
      locator: Locator,
      level: CascadeLevel,
      arg: Parameters<typeof emitLocatorCall>[1],
      frameChain: string[] | undefined,
      confirmToken: string,
    ): Promise<RouteOutcome> => {
      const info = await locator.first().evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        href: el.hasAttribute('href'),
      })).catch(() => null);
      const same = await confirmSameElement(locator, confirmToken);
      let newRaw = emitLocatorCall(level, arg, false, frameChain);
      if (call.root === 'this.page') newRaw = 'this.' + newRaw;
      // Role correction: the original getByRole named its target EXACTLY
      // (exact:true) and the candidate carries that identical exact name at
      // role level — only the role differs (a link that became a button).
      // The name is the identity; the role is the corrected hypothesis.
      const roleCorrected = call.method === 'getByRole'
        && call.args.exact === true
        && level === 'role'
        && typeof arg === 'object'
        && arg.exact === true
        && !!call.args.name
        && arg.name === call.args.name;
      return {
        kind: 'resolved', newRaw, level,
        confirmed: same.confirmed, unstableMatch: same.unstableMatch,
        candidateKind: info ? kindOfElement(info) : null,
        confirmToken,
        mismatch: same.got,
        roleCorrected,
      };
    };

    // Fuzzy stage: scores the page's identifiers against the broken one by
    // edit distance. Runs only AFTER exact and suffix-stripped intent
    // matching both failed, so fuzzy matches always score lower than either.
    const fuzzyProbe = async (call: LocatorCall, source: string): Promise<RouteOutcome | null> => {
      let scanned: ScannedElement[];
      try {
        const scan = await scanIdentifiers(page, opts.settleMs ?? 2000);
        scanned = scan.elements;
        if (!scan.settled && !settleCapNoted) {
          settleCapNoted = true;
          console.error(`candidate collection may be incomplete: the page was still mutating after ${opts.settleMs ?? 2000}ms`);
        }
      } catch { return null; }
      const verdict = matchFuzzy(source, scanned);
      if (verdict.kind === 'none') return null;
      if (verdict.kind === 'near-miss') {
        return {
          kind: 'unresolved',
          closest: verdict.closest.map((c) => `${c.display} (${c.score.toFixed(2)})`).join(', '),
        };
      }
      if (verdict.kind === 'ambiguous') return { kind: 'ambiguous', closeMatches: verdict.displays };
      const cand = verdict.candidate as ScannedElement;
      const value = verdict.value;
      // Prefer the semantic ladder for the matched identifier, but only
      // when it lands on the SAME element the scan found.
      const ladder = await resolveIntent(page, { intent: humanize(value) });
      if (ladder && !ladder.ambiguous && (ladder.frameChain?.length ?? 0) === 0) {
        const identity = await ladder.locator.first().evaluate((el) => ({
          tag: el.tagName.toLowerCase(), id: el.id || null, name: el.getAttribute('name'),
        })).catch(() => null);
        const sameEl = identity != null
          && identity.tag === cand.tag
          && (cand.id ? identity.id === cand.id : identity.name === cand.name);
        if (sameEl) return resolvedOutcome(call, ladder.locator, ladder.level, ladder.arg, undefined, value);
      }
      // The ladder could not express the element; relocate it directly via
      // the attribute the fuzzy match came from.
      const attr = cand.attrOf[value] ?? (cand.id ? 'id' : cand.name ? 'name' : '');
      let level: CascadeLevel;
      let arg: string;
      switch (attr) {
        case 'id': {
          const id = cand.id ?? value;
          arg = /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/"/g, '\\"')}"]`;
          level = 'css';
          break;
        }
        case 'name':
          arg = `[name="${(cand.name ?? value).replace(/"/g, '\\"')}"]`;
          level = 'css';
          break;
        case 'aria-label':
        case 'label':
          arg = value;
          level = 'label';
          break;
        case 'placeholder':
          arg = value;
          level = 'placeholder';
          break;
        case 'data-testid':
          arg = value;
          level = 'testid';
          break;
        case 'data-test':
          arg = `[data-test="${value.replace(/"/g, '\\"')}"]`;
          level = 'css';
          break;
        case 'text':
          arg = value;
          level = 'text';
          break;
        default:
          return { kind: 'unresolved' };
      }
      const locator = level === 'label'
        ? page.getByLabel(arg)
        : level === 'placeholder'
          ? page.getByPlaceholder(arg)
          : level === 'testid'
            ? page.getByTestId(arg)
            : level === 'text'
              ? page.getByText(arg)
              : page.locator(arg);
      let n = 0;
      try { n = await locator.count(); } catch { n = 0; }
      if (n !== 1) return { kind: 'unresolved' };
      return resolvedOutcome(call, locator, level, arg, undefined, value);
    };

    let settleCapNoted = false;

    // css-tag-fix stage: a compound CSS selector stays excluded from
    // intent/fuzzy matching (its classes are styling, not identity), but a
    // tag token that is not a valid element name is recoverable evidence
    // of a pure typo ("buttons.btn.btn-primary"). Corrections one edit
    // from a known tag are probed; ONLY a single correction resolving to
    // EXACTLY ONE element (and passing the kind guard) is proposed — as
    // the corrected compound selector itself, never a reinvented locator.
    // Confirmation here is structural, not intent-based: the selector's
    // own classes/attributes still match and only the tag changed by one
    // edit, so a unique match IS the confirmation. Anything else (zero
    // matches, two+, competing corrections, a valid tag) returns null and
    // the normal refusal paths apply.
    const tagFixProbe = async (call: LocatorCall): Promise<RouteOutcome | null> => {
      if (call.level !== 'css' || !call.args.css) return null;
      const scope = scopeFor(page, call.frameChain);
      const unique: Array<{ css: string; locator: Locator }> = [];
      for (const corrected of tagTypoCorrections(call.args.css)) {
        const locator = scope.locator(corrected);
        let n = 0;
        try { n = await locator.count(); } catch { n = 0; }
        if (n === 1) unique.push({ css: corrected, locator });
      }
      if (unique.length !== 1) return null;
      const hit = unique[0]!;
      const info = await hit.locator.first().evaluate((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        href: el.hasAttribute('href'),
      })).catch(() => null);
      const candidateKind = info ? kindOfElement(info) : null;
      if (kindConflict(expectedKindsOf(call), candidateKind)) return null;
      let newRaw = emitLocatorCall(
        'css-tag-fix', hit.css, false,
        call.frameChain.length > 0 ? call.frameChain : undefined,
      );
      if (call.root === 'this.page') newRaw = 'this.' + newRaw;
      return {
        kind: 'resolved', newRaw, level: 'css-tag-fix',
        confirmed: true, unstableMatch: false,
        candidateKind, confirmToken: hit.css,
      };
    };

    // Compact identities of an ambiguous locator's matches, capped at 5.
    const describeMatches = async (matches: Locator): Promise<string[]> => {
      const out: string[] = [];
      let n = 0;
      try { n = await matches.count(); } catch { return out; }
      for (let i = 0; i < Math.min(n, 5); i++) {
        const d = await matches.nth(i).evaluate((el) => {
          const generatedId = (v: string): boolean =>
            /^[_:]?r[_:]?(?=[0-9a-z]*\d)[0-9a-z]+[_:.-]/i.test(v)
            || v.split(/[^A-Za-z0-9]+/).filter(Boolean)
              .every((w) => /^\d+$/.test(w) || (/^[0-9a-f]{4,}$/i.test(w) && /\d/.test(w)));
          if (el.id && !generatedId(el.id)) return '#' + el.id;
          const name = el.getAttribute('name');
          if (name && !generatedId(name)) return el.tagName.toLowerCase() + '[name="' + name + '"]';
          const aria = el.getAttribute('aria-label');
          if (aria) return el.tagName.toLowerCase() + ' "' + aria + '"';
          const labels = (el as HTMLInputElement).labels;
          const lt = labels && labels.length > 0
            ? (labels[0]!.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
          if (lt) return el.tagName.toLowerCase() + ' "' + lt + '"';
          const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 25);
          if (t) return el.tagName.toLowerCase() + ' "' + t + '"';
          return el.id ? '#' + el.id : el.tagName.toLowerCase();
        }).catch(() => null);
        if (d) out.push(d);
      }
      if (n > 5) out.push(`+${n - 5} more`);
      return out;
    };

    // Distinguishing descriptors for the elements a strict-failure locator
    // matches: what makes each one individually targetable. Classes shared
    // by every match are dropped — they cannot distinguish anything.
    const distinguishers = async (matches: Locator, n: number): Promise<string[]> => {
      const infos: Array<{ id: string; testid: string; classes: string[]; tag: string; type: string }> = [];
      for (let i = 0; i < Math.min(n, 5); i++) {
        const d = await matches.nth(i).evaluate((el) => ({
          id: el.id || '',
          testid: el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? '',
          classes: Array.from(el.classList),
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') ?? '',
        })).catch(() => null);
        if (d) infos.push(d);
      }
      const classCounts = new Map<string, number>();
      for (const d of infos) {
        for (const c of new Set(d.classes)) classCounts.set(c, (classCounts.get(c) ?? 0) + 1);
      }
      const out: string[] = [];
      for (const d of infos) {
        const own = d.classes.filter((c) => classCounts.get(c) === 1);
        out.push(d.id
          ? `#${d.id}`
          : d.testid
            ? `[data-testid="${d.testid}"]`
            : own.length > 0
              ? `.${own.join('.')}`
              : `${d.tag}${d.type ? `[type="${d.type}"]` : ''}`);
      }
      if (n > 5) out.push(`+${n - 5} more`);
      return out;
    };

    // Probe one locator against the CURRENT page (already on its route).
    const probeCall = async (call: LocatorCall, strict: boolean): Promise<RouteOutcome> => {
      // 1. Does the original locator still resolve here? Then it is intact —
      //    UNLESS the runtime failure was a strict mode violation, where a
      //    multi-match IS the failure: the positional disambiguator
      //    (.first()/.nth()) was deleted and cannot be guessed back.
      let count = 0;
      const original = buildLocator(page, call);
      try { count = await original.count(); } catch { count = 0; }
      if (strict && count >= 2) {
        return { kind: 'strict-multi', count, candidates: await distinguishers(original, count) };
      }
      if (count >= 1) return { kind: 'intact', count };

      // 2. Broken. A tag-typo'd compound CSS selector is tried FIRST: its
      //    structural evidence (same classes, tag one edit from a real
      //    element name, unique match) outranks anything the weak
      //    class-token intent below could suggest.
      const tagFixed = await tagFixProbe(call);
      if (tagFixed) return tagFixed;

      // 3. Re-resolve by semantic intent with the SAME ladder +
      //    healResolve, trying in order: the identity as written, a
      //    humanized form (separators/camelCase to spaces — semantic
      //    identities like getByRole names arrive raw), and a form with
      //    trailing auto-generated fragments stripped ("Email 1" → "Email").
      const token = intentToken(call);
      if (norm(token).length < 2) return { kind: 'no-identity' };
      const tokens = [token];
      const humanized = humanize(token);
      if (humanized && humanized !== token) tokens.push(humanized);
      const stripped = stripAutoSuffixes(humanized || token);
      if (stripped && norm(stripped).length >= 2 && !tokens.includes(stripped)) tokens.push(stripped);
      let sawAmbiguous = false;
      let ambiguousCandidates: string[] | null = null;
      for (const tk of tokens) {
        const resolved = await healResolve(page, { intent: tk });
        if (!resolved) continue;
        if (resolved.ambiguous) {
          sawAmbiguous = true;
          // Name what the intent matched, so the refusal is actionable.
          if (!ambiguousCandidates && resolved.allMatches) {
            ambiguousCandidates = await describeMatches(resolved.allMatches);
          }
          continue;
        }
        return resolvedOutcome(call, resolved.locator, resolved.level, resolved.arg, resolved.frameChain, tk);
      }

      // 4. Fuzzy stage for typo'd simple identifiers ("#Emai_l" → "#Email").
      //    Scores below the intent stages, still subject to the kind guard,
      //    ambiguity rules, and same-element confirmation.
      const source = fuzzySource(call);
      if (source && call.frameChain.length === 0) {
        const fz = await fuzzyProbe(call, source);
        if (fz) return fz;
      }
      return sawAmbiguous
        ? { kind: 'ambiguous', candidates: ambiguousCandidates ?? undefined }
        : { kind: 'unresolved' };
    };

    // Phase 1: probe every selected locator on every route it belongs to,
    // navigating to each distinct route exactly once (in first-use order).
    const tasks = selected.map((s) => ({
      call: s.call,
      routes: s.routes,
      noRoute: s.noRoute === true,
      strict: s.strict === true,
      outcomes: new Map<string, RouteOutcome>(),
    }));
    const routeOrder: string[] = [];
    for (const t of tasks) {
      for (const r of t.routes) if (!routeOrder.includes(r)) routeOrder.push(r);
    }
    // Routes whose page created at least one CLOSED shadow root: content
    // the probe (and Playwright) cannot inspect exists there.
    const closedRootRoutes = new Set<string>();
    // Origin + path of a URL, trailing slashes and query ignored: the shape
    // that changes when an app redirects (to /login, to an error page).
    const pageSpot = (u: string): string => {
      try {
        const x = new URL(u);
        return x.origin + x.pathname.replace(/\/+$/, '');
      } catch {
        return u;
      }
    };
    const looksLikeLogin = (u: string): boolean => {
      try {
        return /(^|\/)(log-?in|sign-?in|auth|sso)([/.]|$)/i.test(new URL(u).pathname);
      } catch {
        return false;
      }
    };
    for (const route of routeOrder) {
      await page.goto(route, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      let finalUrl = page.url();
      // Expired-session fallback: the saved state no longer authenticates
      // (redirected to a login-looking page) but the user's own login
      // function is configured — run it once and retry this route. Never
      // the reverse: a failing auth setup never falls back to a session.
      if (authSetup && authMode === 'state'
          && pageSpot(finalUrl) !== pageSpot(route) && looksLikeLogin(finalUrl)) {
        console.error('saved session expired; falling back to auth setup');
        await runAuthSetup();
        authMode = 'setup';
        await page.goto(route, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle').catch(() => undefined);
        finalUrl = page.url();
      }
      // Redirect awareness: a page that redirected away is NOT the target,
      // and probing it as if it were invites wrong heals. Say what
      // happened, diagnose auth when it looks like auth, and skip probing.
      if (pageSpot(finalUrl) !== pageSpot(route)) {
        const reqLabel = routeLabel(route);
        const sameOrigin = pageSpot(finalUrl).startsWith(new URL(route).origin);
        const landLabel = sameOrigin ? routeLabel(finalUrl) : finalUrl;
        console.error(`requested ${reqLabel}, landed on ${landLabel} (redirected)`);
        if (authMode === 'setup') {
          console.error(`auth setup ran but ${reqLabel} still redirected to ${landLabel}; the login function may have failed silently or the session did not persist`);
        } else if (authMode === 'state') {
          console.error(`storage state was applied but ${reqLabel} still redirected to ${landLabel}; the saved session may be expired. Re-generate it and retry.`);
        } else if (looksLikeLogin(finalUrl)) {
          console.error('the page may require authentication; pass --storage-state <path>');
        }
        for (const t of tasks) {
          if (t.routes.includes(route)) t.outcomes.set(route, { kind: 'redirected', to: landLabel });
        }
        continue;
      }
      opts.onEvent?.({ type: 'opened_page', url: route });
      const closedRoots = await page.evaluate(
        () => (window as unknown as { __qaCoreClosedShadowRoots?: number }).__qaCoreClosedShadowRoots ?? 0,
      ).catch(() => 0);
      if (closedRoots > 0) closedRootRoutes.add(route);
      for (const t of tasks) {
        if (!t.routes.includes(route)) continue;
        t.outcomes.set(route, await probeCall(t.call, t.strict));
      }
    }

    // Phase 2: verdicts, in scan order. A locator heals only when every
    // route it was re-resolved on agrees on the SAME replacement; refusals
    // say WHERE the locator was looked for.
    for (const t of tasks) {
      const call = t.call;
      // Unknowable failure page: never silently probe the wrong one.
      if (t.noRoute) {
        refuse(call, `could not determine the page where ${call.raw} failed (custom browser setup produces no trace); re-run with --route <file>=<route> or --base-url`, false);
        continue;
      }
      const entries = t.routes.map((r) => ({ route: r, o: t.outcomes.get(r)! }));
      const intactEntries = entries.filter((e) => e.o.kind === 'intact');
      if (intactEntries.length > 0) {
        markIntact(call, intactEntries.some((e) => e.o.kind === 'intact' && e.o.count > 1));
        continue;
      }

      opts.onEvent?.({ type: 'healing', selector: call.raw, file: relFile(call.file) });
      // Strict-mode multi-match: the original test disambiguated by
      // position (.first()/.nth()) and that call was deleted — information
      // that cannot be recovered from the page. A guessed position would
      // pass the re-run while silently changing WHICH element the test
      // verifies (a self-certifying wrong heal), so this refuses and
      // teaches, naming what distinguishes the matched elements.
      const strictMulti = entries.map((e) => e.o).find((o) => o.kind === 'strict-multi');
      if (strictMulti && strictMulti.kind === 'strict-multi') {
        refuse(call,
          `locator matches ${strictMulti.count} elements identical by accessible name; `
          + 'the original disambiguator (.first()/.nth()) cannot be recovered safely. '
          + 'Add a positional call back, or target by a distinguishing attribute '
          + `(candidates: ${strictMulti.candidates.join(' / ')})`,
          true);
        continue;
      }
      if (opts.maxHeals != null && healed.length >= opts.maxHeals) {
        refuse(call, `maxHealsPerRun (${opts.maxHeals}) reached; heal skipped`, false);
        continue;
      }
      if (entries.every((e) => e.o.kind === 'no-identity')) {
        refuse(call, withCompoundHint(call, 'no semantic identity (nameless / opaque selector) to re-resolve or confirm'), false);
        continue;
      }
      // Every route redirected away: the target page was never reachable,
      // so probing evidence does not exist. Never treat the landing page
      // (usually a login screen) as if it were the target.
      if (entries.length > 0 && entries.every((e) => e.o.kind === 'redirected')) {
        const first = entries[0]!;
        const to = first.o.kind === 'redirected' ? first.o.to : '';
        refuse(call, `route ${routeLabel(first.route)} redirected to ${to}; the target page could not be probed`, false);
        continue;
      }
      // Genuine ambiguity: several elements matched the intent on a route.
      // Fuzzy ambiguity names the close matches it refused to pick between.
      const ambiguousEntries = entries.filter((e) => e.o.kind === 'ambiguous');
      if (ambiguousEntries.length > 0) {
        const at = ambiguousEntries.map((e) => routeLabel(e.route)).join(', ');
        const closeMatches = [...new Set(ambiguousEntries.flatMap((e) =>
          e.o.kind === 'ambiguous' ? (e.o.closeMatches ?? []) : []))];
        const named = [...new Set(ambiguousEntries.flatMap((e) =>
          e.o.kind === 'ambiguous' ? (e.o.candidates ?? []) : []))];
        refuse(call, closeMatches.length > 0
          ? `ambiguous on route ${at}: several close matches (${closeMatches.join(', ')}), refusing to guess`
          : named.length > 0
            ? `ambiguous on route ${at}: several elements match the intent (candidates: ${named.join(', ')}), refusing to guess`
            : `ambiguous on route ${at}: several elements match the intent, refusing to guess`, true);
        continue;
      }
      const resolvedEntries = entries.flatMap((e) =>
        e.o.kind === 'resolved' ? [{ route: e.route, o: e.o }] : []);
      // Not found anywhere the locator is used: say which routes were tried,
      // then pick the most honest explanation available. A fuzzy near-miss
      // is named; a selector token like "toast" or "result" is positive
      // evidence of state dependence; with neither, the reason hedges — a
      // confident explanation for a plain missing element would be made up.
      if (resolvedEntries.length === 0) {
        const labels = t.routes.map(routeLabel);
        const where = labels.length === 1 ? `route ${labels[0]}` : `routes ${labels.join(', ')}`;
        const closest = entries
          .map((e) => (e.o.kind === 'unresolved' ? e.o.closest : undefined))
          .find((c) => c != null);
        const hint = stateDependencyHint(call);
        // Nothing matched AND the page holds content the probe cannot see:
        // say so, or the absence reads as "the element is gone" when it may
        // simply be sealed away.
        const withClosedNote = (reason: string): string =>
          t.routes.some((r) => closedRootRoutes.has(r))
            ? `${reason.replace(/\.$/, '')}; this page contains closed shadow roots the probe cannot inspect`
            : reason;
        // A dashed leading tag REPLACES the generic hedge: it may be a
        // spec-legal custom element or a typo, and only the user can say
        // which — but the closest valid tag makes the typo case one edit
        // away from fixed. Dashed tags are never auto-healed.
        const dashHint = dashedTagHint(call);
        refuse(call, withClosedNote(closest
          ? `not found on ${where}: closest candidates below the confidence threshold: ${closest}`
          : hint
            ? withCompoundHint(call, `not found on ${where}: element may be state-dependent (selector token "${hint}" suggests it appears only after user actions); static healing cannot verify it`)
            : dashHint
              ? `not found on ${where}: ${dashHint}`
              : withCompoundHint(call, `not found on ${where}: no matching or similar element on the probed page. The element may have been removed, renamed beyond recognition, or may only appear after user actions.`)), false);
        continue;
      }
      // A shared page object probed on several routes must resolve to the
      // SAME replacement everywhere it was found; disagreement means we
      // cannot know which element was meant.
      const distinctRaw = [...new Set(resolvedEntries.map((e) => e.o.newRaw))];
      if (distinctRaw.length > 1) {
        const detail = resolvedEntries.map((e) => `${routeLabel(e.route)} → ${e.o.newRaw}`).join('; ');
        refuse(call, `candidates disagree across routes (${detail}); refusing to guess`, false);
        continue;
      }
      // Kind guard: the original selector said what kind of element it
      // meant; a candidate of a conflicting kind is a wrong heal, refuse.
      // Exception: a role-corrected getByRole heal (exact name identical,
      // only the role changed) — there the OLD role is the broken part,
      // and holding the candidate to its kind would veto every role fix.
      const expectedKinds = expectedKindsOf(call);
      const clash = resolvedEntries.find((e) =>
        !e.o.roleCorrected && kindConflict(expectedKinds, e.o.candidateKind));
      if (clash) {
        refuse(call, `kind mismatch: expected ${expectedKinds.join(' or ')}, candidate is ${clash.o.candidateKind}`, false);
        continue;
      }
      // A heal landing on a level the config excludes is refused, not applied.
      // A css-tag-fix output IS a plain css locator; selectorPreference
      // judges it as "css".
      const level = resolvedEntries[0]!.o.level;
      const prefLevel: CascadeLevel = level === 'css-tag-fix' ? 'css' : level;
      if (opts.allowedLevels && !opts.allowedLevels.includes(prefLevel)) {
        refuse(call, `healed to level "${level}", which selectorPreference excludes`, false);
        continue;
      }
      // Every route's match must have confirmed as the same intended element.
      const unconfirmed = resolvedEntries.filter((e) => !e.o.confirmed);
      if (unconfirmed.length > 0) {
        const first = unconfirmed[0]!.o;
        refuse(
          call,
          unconfirmed.some((e) => e.o.unstableMatch)
            ? 'element identity attributes are unstable; cannot confirm the match'
            : first.mismatch
              ? `re-resolved element differs: expected an element matching "${first.confirmToken}" (from ${call.raw}), got ${first.mismatch}; not healing`
              : 're-resolved to a different element, not healing (would be wrong)',
          false,
        );
        continue;
      }

      const newRaw = distinctRaw[0]!;
      if (newRaw === call.raw) {
        // Re-resolved to the same call it already was, nothing to change.
        markIntact(call, false);
        continue;
      }
      const list = editsByFile.get(call.file) ?? [];
      list.push({ line: call.line, startCol: call.startCol, endLine: call.endLine, endCol: call.endCol, newRaw });
      editsByFile.set(call.file, list);
      healed.push({ file: call.file, line: call.line, old: call.raw, new: newRaw, level });
      locators.push({
        file: relFile(call.file), line: call.line, old: call.raw, new: newRaw,
        level, ambiguous: false, status: 'healed',
      });
      opts.onEvent?.({ type: 'healed', old: call.raw, new: newRaw, level, file: relFile(call.file) });
    }
  } finally {
    await browser?.close();
  }

  const filesWritten: string[] = [];
  if (write) {
    for (const [file, edits] of editsByFile) {
      const original = files.find((f) => f.path === file)!.src;
      fs.writeFileSync(file, applyEdits(original, edits));
      filesWritten.push(file);
    }
  }

  opts.onEvent?.({
    type: 'done', healed: healed.length, unhealed: unhealable.length,
    intact, total: selected.length, files: filesWritten,
  });

  const specWritten = specPaths.find((sp) => filesWritten.includes(sp));
  return {
    healedPath: specWritten ?? filesWritten[0] ?? null,
    filesWritten, scanned: selected.length, intact, healed, unhealable, total: selected.length,
    locators,
    specFiles: Object.fromEntries(specFiles),
    unmatchedTargets,
  };
}
