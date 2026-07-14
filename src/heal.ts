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
}

interface LocatorCall {
  file: string;
  line: number;      // 1-indexed
  startCol: number;  // 0-indexed within the line
  endCol: number;    // exclusive
  raw: string;       // the `page...getByX(...)` text, no trailing .first()/.click()
  root: string;      // 'page' or 'this.page'
  method: LocatorMethod;
  level: CascadeLevel;
  frameChain: string[];
  args: LocatorArgs;
  /** Rest of the line after the call: the API chained on it (".fill(...)"). */
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

function parseArgs(method: LocatorMethod, argsRaw: string): LocatorArgs {
  const first = firstString(argsRaw);
  switch (method) {
    case 'getByRole':
      return { role: first ?? '', name: namedString(argsRaw, 'name') ?? undefined, exact: /["']?\bexact\b["']?\s*:\s*true\b/.test(argsRaw) };
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

/** Extract every locator chain in a file: page[.frameLocator(...)].getByX(...) / .locator(...). */
function parseLocatorCalls(src: string, file: string): LocatorCall[] {
  const calls: LocatorCall[] = [];
  const lines = src.split('\n');
  const rootRe = /(?<![\w.$])(this\.page|page)\b/g;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    let rm: RegExpExecArray | null;
    rootRe.lastIndex = 0;
    while ((rm = rootRe.exec(line)) !== null) {
      const root = rm[1]!;
      let pos = rm.index + root.length;
      const frameChain: string[] = [];
      let matched: LocatorMethod | null = null;
      let open = -1;
      // Consume any .frameLocator("...") prefixes, then the terminal locator method.
      for (;;) {
        if (line.startsWith('.frameLocator(', pos)) {
          const fo = pos + '.frameLocator'.length;
          const fc = matchParen(line, fo);
          if (fc < 0) break;
          const inner = firstString(line.slice(fo + 1, fc));
          if (inner != null) frameChain.push(inner);
          pos = fc + 1;
          continue;
        }
        for (const m of LOCATOR_METHODS) {
          if (line.startsWith('.' + m + '(', pos)) { matched = m; open = pos + 1 + m.length; break; }
        }
        break;
      }
      if (!matched || open < 0) continue;
      const close = matchParen(line, open);
      if (close < 0) continue;
      const argsRaw = line.slice(open + 1, close);
      const args = parseArgs(matched, argsRaw);
      calls.push({
        file, line: li + 1, startCol: rm.index, endCol: close + 1,
        raw: line.slice(rm.index, close + 1), root, method: matched,
        level: levelOf(matched, args), frameChain, args,
        trailing: line.slice(close + 1),
      });
    }
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
    case 'getByRole': return a.name ? scope.getByRole(role, { name: a.name, exact: a.exact }) : scope.getByRole(role);
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
    case 'css': return tokenFromCss(a.css ?? '');
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

/** Stable logical identity of an element: what it IS, not which node. */
interface Fingerprint {
  tag: string; id: string; name: string; testid: string; type: string;
  role: string; ariaLabel: string; placeholder: string; text: string;
  labelText: string;
  box: { x: number; y: number; w: number; h: number } | null;
}

/** Read the fingerprint via a FRESH locator query; retries ride out a node
 *  being replaced mid-read (SPA re-renders swap nodes; locators re-query). */
async function readFingerprint(locator: ReturnType<typeof buildLocator>): Promise<Fingerprint | null> {
  for (let i = 0; i < 3; i++) {
    try {
      return await locator.first().evaluate((el) => {
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

/** Same logical element: identity fields equal, geometry within tolerance. */
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
  const matches = (s: string): boolean => {
    const ns = norm(s);
    if (ns && (ns.includes(nt) || (ns.length >= 3 && nt.includes(ns)))) return true;
    const ss = normSep(s);
    return !!ss && (ss.includes(st) || (ss.length >= 3 && st.includes(ss)));
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

interface Edit { line: number; startCol: number; endCol: number; newRaw: string }

function applyEdits(src: string, edits: Edit[]): string {
  const lines = src.split('\n');
  const byLine = new Map<number, Edit[]>();
  for (const e of edits) {
    const list = byLine.get(e.line) ?? [];
    list.push(e);
    byLine.set(e.line, list);
  }
  for (const [ln, list] of byLine) {
    list.sort((a, b) => b.startCol - a.startCol); // right-to-left keeps offsets valid
    let line = lines[ln - 1] ?? '';
    for (const e of list) line = line.slice(0, e.startCol) + e.newRaw + line.slice(e.endCol);
    lines[ln - 1] = line;
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
    case 'css': {
      const m = (a.css ?? '').trim().match(/^[#.]([A-Za-z_][\w-]*)$/);
      return m ? m[1]! : (a.hasText || null);
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
    const labelFor = new Map<string, string>();
    for (const l of Array.from(document.querySelectorAll('label[for]'))) {
      const t = (l.textContent ?? '').replace(/\s+/g, ' ').trim();
      const f = l.getAttribute('for');
      if (t && f && !labelFor.has(f)) labelFor.set(f, t);
    }
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
    const attrEls = Array.from(
      document.querySelectorAll('[id], [name], [aria-label], [data-testid], [data-test], [placeholder]'),
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
    const textEls = Array.from(document.querySelectorAll('body *')).slice(0, 4000);
    let textCount = 0;
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

/* ─────────────────────────── main ─────────────────────────── */

/** Outcome of probing one locator on one route. */
type RouteOutcome =
  | { kind: 'intact'; count: number }
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
  const selected: Array<{ call: LocatorCall; routes: string[]; noRoute?: boolean }> = [];
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
      }
    }
    for (const call of calls) {
      const urls = urlsByCall.get(call);
      if (!urls) continue;
      if (urls.size > 0) {
        // 1. The trace told us the page the test was on when it failed.
        selected.push({ call, routes: [...urls] });
      } else if (hasExplicitRoute(plan, call.file, call.line) || opts.baseUrl) {
        // 2. No trace: a statically inferred route (or a base URL the user
        //    gave EXPLICITLY) is a legitimate place to probe.
        selected.push({ call, routes: routesForLocator(plan, call.file, call.line) });
      } else {
        // 3. Neither: probing anything would be a guess about where the
        //    failure happened. Refuse loudly instead (decision phase).
        selected.push({ call, routes: [], noRoute: true });
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

  // The user's own login function beats every storage-state source: it is
  // the explicit statement of how this app authenticates. Loaded up front
  // so a broken module fails BEFORE any browser work.
  const authSetup = opts.authSetup ? await loadAuthSetup(opts.authSetup, process.cwd()) : null;

  // Storage state, in priority order: explicit (--storage-state flag or
  // qa-core.config.json auth.storageState), the playwright config's own
  // use.storageState, then conventional locations. Detection never fails a
  // run — with nothing found, probing is unauthenticated as always. Only
  // the file PATH is ever logged; the contents stay out of every output.
  let storageState = opts.storageState && fs.existsSync(opts.storageState) ? opts.storageState : undefined;
  if (authSetup) {
    if (opts.storageState) {
      console.error(`--auth-setup takes precedence over --storage-state; ignoring ${opts.storageState}`);
    }
    storageState = undefined;
  } else if (!storageState && !opts.storageState) {
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
  const authMode: 'setup' | 'state' | null = authSetup ? 'setup' : storageState ? 'state' : null;

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
    const page = await context.newPage();

    // Run the user's login function against the probing page. A throw or a
    // timeout fails the whole run loudly — probing unauthenticated behind
    // the user's back is never an acceptable fallback. Only the label
    // (path#export) and pass/fail are logged, never credentials or cookies.
    if (authSetup) {
      try {
        await withTimeout(authSetup.fn(page), opts.authSetupTimeout ?? 60000);
        console.error(`auth setup ${authSetup.label} succeeded`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Relative navigation with no base URL on the context is a config
        // problem, not a login problem — say so. (The context always gets
        // the resolved base URL above, so this only fires if resolution
        // ever yields none on a future code path.)
        const hint = /Cannot navigate to invalid URL/i.test(msg) && !url
          ? '; your login function navigates to a relative URL but no baseURL could be resolved; pass --base-url'
          : '';
        throw new Error(`auth setup ${authSetup.label} failed: ${msg}${hint}`);
      }
    }

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
      return {
        kind: 'resolved', newRaw, level,
        confirmed: same.confirmed, unstableMatch: same.unstableMatch,
        candidateKind: info ? kindOfElement(info) : null,
        confirmToken,
        mismatch: same.got,
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

    // Probe one locator against the CURRENT page (already on its route).
    const probeCall = async (call: LocatorCall): Promise<RouteOutcome> => {
      // 1. Does the original locator still resolve here? Then it is intact.
      let count = 0;
      try { count = await buildLocator(page, call).count(); } catch { count = 0; }
      if (count >= 1) return { kind: 'intact', count };

      // 2. Broken. Re-resolve by semantic intent with the SAME ladder +
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

      // 3. Fuzzy stage for typo'd simple identifiers ("#Emai_l" → "#Email").
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
      outcomes: new Map<string, RouteOutcome>(),
    }));
    const routeOrder: string[] = [];
    for (const t of tasks) {
      for (const r of t.routes) if (!routeOrder.includes(r)) routeOrder.push(r);
    }
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
      const finalUrl = page.url();
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
      for (const t of tasks) {
        if (!t.routes.includes(route)) continue;
        t.outcomes.set(route, await probeCall(t.call));
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
      if (opts.maxHeals != null && healed.length >= opts.maxHeals) {
        refuse(call, `maxHealsPerRun (${opts.maxHeals}) reached; heal skipped`, false);
        continue;
      }
      if (entries.every((e) => e.o.kind === 'no-identity')) {
        refuse(call, 'no semantic identity (nameless / opaque selector) to re-resolve or confirm', false);
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
        refuse(call, closest
          ? `not found on ${where}: closest candidates below the confidence threshold: ${closest}`
          : hint
            ? `not found on ${where}: element may be state-dependent (selector token "${hint}" suggests it appears only after user actions); static healing cannot verify it`
            : `not found on ${where}: no matching or similar element on the probed page. The element may have been removed, renamed beyond recognition, or may only appear after user actions.`, false);
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
      const expectedKinds = expectedKindsOf(call);
      const clash = resolvedEntries.find((e) => kindConflict(expectedKinds, e.o.candidateKind));
      if (clash) {
        refuse(call, `kind mismatch: expected ${expectedKinds.join(' or ')}, candidate is ${clash.o.candidateKind}`, false);
        continue;
      }
      // A heal landing on a level the config excludes is refused, not applied.
      const level = resolvedEntries[0]!.o.level;
      if (opts.allowedLevels && !opts.allowedLevels.includes(level)) {
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
      list.push({ line: call.line, startCol: call.startCol, endCol: call.endCol, newRaw });
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
