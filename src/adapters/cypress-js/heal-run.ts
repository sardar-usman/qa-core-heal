import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { Edit, HealOptions, HealPlanEntry, HealResult, HealTarget, LocatorReport } from '../../heal.js';
import { matchFuzzy, type FuzzyCandidate } from '../../fuzzy.js';
import type { ProbeQuery } from '../types.js';
import { emitContains, emitGet, emitRole } from './emit.js';
import { parseCypressCalls, configHasShadow, type CypressCall, type CypressQuote } from './parse.js';
import { countCypressQuery } from './unique.js';
import { CYPRESS_GET_BY_ROLE_MIN, cypressVersion, versionAtLeast } from './version.js';
import { testIdAttributeFrom } from './capture.js';
import { testAtLine } from './list-tests.js';
import { projectRootFor } from '../../project-root.js';

/**
 * Heal Cypress literals against the captured page. There is no fresh load.
 * The probe is Playwright Chromium with JavaScript disabled.
 */
export async function healCypress(opts: HealOptions): Promise<HealResult> {
  const specs = (opts.specPaths ?? (opts.specPath ? [opts.specPath] : [])).map((file) => path.resolve(file));
  const files = specs.filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  const calls = files.flatMap((file) => parseCypressCalls(fs.readFileSync(file, 'utf8'), file));
  const shadow = files.some((file) => configHasShadow(fs.readFileSync(file, 'utf8')));
  const root = projectRootFor(files[0] ?? process.cwd());
  const version = cypressVersion(root);
  const testId = testIdAttributeFrom(readProjectConfig(root));
  const roleOk = version != null && versionAtLeast(version, CYPRESS_GET_BY_ROLE_MIN);
  const targets = opts.targets ?? [];
  const locators: LocatorReport[] = [];
  const planEdits = new Map<string, { src: string; edits: Edit[] }>();
  const ensure = (file: string): { src: string; edits: Edit[] } => {
    const found = planEdits.get(file);
    if (found) return found;
    const src = fs.readFileSync(file, 'utf8');
    const entry = { src, edits: [] as Edit[] };
    planEdits.set(file, entry);
    return entry;
  };

  if (shadow) {
    for (const call of calls) locators.push(refused(call, 'includeShadowDom is not supported.'));
    return resultOf(locators, [], specs);
  }

  const capture = readCapture(targets);
  if (!capture) {
    const chosen = targets.length > 0 ? calls.filter((call) => matchesTarget(call, targets)) : calls;
    for (const call of chosen.length > 0 ? chosen : calls) {
      locators.push(refused(call, 'Heal has no captured page for this failure, so it will not load a fresh page.'));
    }
    if (locators.length === 0) locators.push(emptyRefusal('Heal has no captured page for this failure, so it will not load a fresh page.'));
    return resultOf(locators, [], specs);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const url = route.request().url().split('#')[0];
      if (url === capture.url.split('#')[0]) {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: capture.html });
      }
      return route.abort();
    });
    await page.goto(capture.url, { waitUntil: 'commit' }).catch(() => undefined);
    const sources = new Map<string, string>();
    const sourceOf = (file: string): string => {
      const found = sources.get(file);
      if (found !== undefined) return found;
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      sources.set(file, text);
      return text;
    };
    const pool = calls.filter((call) => inFailedTest(call, targets, sourceOf));
    for (const call of pool) {
      if (call.unsafe) {
        locators.push(refused(call, call.unsafe));
        continue;
      }
      const query = queryOf(call);
      const count = query ? await countCypressQuery(page, query) : 0;
      if (count === 1) {
        locators.push(intact(call));
        continue;
      }
      if (count > 1) {
        locators.push(refused(call, 'More than one element matches, so heal will not guess.', true));
        continue;
      }
      const proposal = await propose(page, call, roleOk, testId);
      if (proposal && 'ambiguous' in proposal) {
        locators.push(refused(call, 'More than one candidate matches, so heal will not guess.', true));
        continue;
      }
      if (!proposal) {
        locators.push(refused(call, 'not found on the captured page.'));
        continue;
      }
      const entry = ensure(call.file);
      entry.edits.push({
        line: call.line,
        startCol: call.startCol,
        endLine: call.endLine,
        endCol: call.endCol,
        newRaw: proposal.code,
      });
      locators.push({
        file: rel(call.file),
        line: call.line,
        old: call.raw,
        new: proposal.code,
        level: proposal.level,
        ambiguous: false,
        status: 'healed',
        occurrences: 1,
        occurrenceLines: [call.line],
      });
    }
  } finally {
    await browser.close();
  }

  const plan: HealPlanEntry[] = [...planEdits.entries()].map(([file, entry]) => ({ file, src: entry.src, edits: entry.edits }));
  return resultOf(locators, plan, specs);
}

async function propose(page: Page, call: CypressCall, roleOk: boolean, testId: string): Promise<{ code: string; level: 'testid' | 'role' | 'text' | 'css' } | { ambiguous: true } | null> {
  const quote = call.quote;
  const elements = await scan(page, testId);
  const source = identityOf(call);
  const byDisplay = new Map(elements.map((el) => [el.display, el]));
  const candidates: FuzzyCandidate[] = elements.map((el) => ({
    display: el.display,
    values: el.values,
    attrOf: el.attrOf,
  }));
  const verdict = source ? matchFuzzy(source, candidates) : { kind: 'none' as const };
  if (verdict.kind === 'ambiguous') return { ambiguous: true };
  if (verdict.kind !== 'match') return null;
  const value = verdict.value;
  const attr = verdict.candidate.attrOf?.[value];
  const scanned = byDisplay.get(verdict.candidate.display);
  if (attr === testId || attr === 'data-cy' || attr === 'data-test' || attr === 'data-testid') {
    const selector = `[${attr}="${cssAttr(value)}"]`;
    if (await countCypressQuery(page, { kind: 'css', selector }) !== 1) return null;
    if (!await sameElement(page, { kind: 'css', selector }, value)) return null;
    return { code: emitGet(selector, quote), level: 'testid' };
  }
  if (roleOk && (attr === 'text' || attr === 'aria-label') && scanned?.role) {
    const roleQuery = { kind: 'role' as const, role: scanned.role, name: value, exact: true };
    if (await countCypressQuery(page, roleQuery) === 1 && await sameElement(page, roleQuery, value)) {
      return { code: emitRole(scanned.role, value, quote), level: 'role' };
    }
  }
  if (attr === 'text' || attr === 'aria-label') {
    const selector = scanned?.tag || '*';
    const textQuery = { kind: 'text' as const, text: value, selector };
    if (await countCypressQuery(page, textQuery) === 1 && await sameElement(page, textQuery, value)) {
      return { code: emitContains(selector, value, quote), level: 'text' };
    }
  }
  if (attr === 'id' && scanned?.id) {
    const selector = `#${cssIdent(scanned.id)}`;
    if (await countCypressQuery(page, { kind: 'css', selector }) !== 1) return null;
    if (await sameElement(page, { kind: 'css', selector }, value)) return { code: emitGet(selector, quote), level: 'css' };
  }
  if (attr === 'name' && scanned?.name) {
    const selector = `[name="${cssAttr(scanned.name)}"]`;
    if (await countCypressQuery(page, { kind: 'css', selector }) !== 1) return null;
    if (await sameElement(page, { kind: 'css', selector }, value)) return { code: emitGet(selector, quote), level: 'css' };
  }
  return null;
}

interface Scanned {
  display: string;
  values: string[];
  attrOf: Record<string, string>;
  tag: string;
  id: string | null;
  name: string | null;
  role: string | null;
  type: string | null;
  href: boolean;
  stamp: string;
}

async function scan(page: Page, testId: string): Promise<Scanned[]> {
  return page.evaluate((preferred) => {
    const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const out: Scanned[] = [];
    let serial = 0;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const tag = el.tagName.toLowerCase();
      const id = el.id || null;
      const name = el.getAttribute('name');
      const role = el.getAttribute('role') || nativeRole(el);
      const type = el.getAttribute('type');
      const text = collapse(el.textContent ?? '');
      const label = el.getAttribute('aria-label');
      const values: string[] = [];
      const attrOf: Record<string, string> = {};
      const add = (value: string | null, attr: string): void => {
        if (!value) return;
        const clean = collapse(value);
        if (!clean || values.includes(clean)) return;
        values.push(clean);
        attrOf[clean] = attr;
      };
      const stamp = String(serial++);
      el.setAttribute('data-qa-core-n', stamp);
      add(el.getAttribute(preferred), preferred);
      if (preferred !== 'data-cy') add(el.getAttribute('data-cy'), 'data-cy');
      if (preferred !== 'data-test') add(el.getAttribute('data-test'), 'data-test');
      if (preferred !== 'data-testid') add(el.getAttribute('data-testid'), 'data-testid');
      add(id, 'id');
      add(name, 'name');
      add(label, 'aria-label');
      if (text && text.length < 80) add(text, 'text');
      if (values.length === 0) continue;
      out.push({
        display: id ? `#${id}` : values[0]!,
        values,
        attrOf,
        tag,
        id,
        name,
        role,
        type,
        href: el.hasAttribute('href'),
        stamp,
      });
    }
    return out;

    function nativeRole(el: Element): string | null {
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
        return 'textbox';
      }
      return null;
    }
  }, testId);
}

function identityOf(call: CypressCall): string {
  if (call.text) return call.text;
  if (call.name) return call.name;
  if (call.css) {
    const attr = /\[(?:data-[\w-]+|name|id)\s*=\s*["']([^"']+)["']\]/.exec(call.css);
    if (attr) return attr[1]!;
    const id = /^#([A-Za-z_][\w-]*)$/.exec(call.css);
    if (id) return id[1]!;
    return call.css;
  }
  return call.role ?? '';
}

function queryOf(call: CypressCall): ProbeQuery | null {
  if (call.kind === 'get' && call.css) return { kind: 'css', selector: call.css };
  if (call.kind === 'contains' && call.text) return { kind: 'text', text: call.text, selector: call.selector };
  if (call.kind === 'getByRole' && call.role) return { kind: 'role', role: call.role, name: call.name, exact: true };
  return null;
}

function matchesTarget(call: CypressCall, targets: HealTarget[]): boolean {
  return targets.some((target) => {
    const selector = target.selector.replace(/\s+/g, '');
    const raw = call.raw.replace(/\s+/g, '');
    if (raw.includes(selector)) return true;
    if (call.css && selector.includes(call.css)) return true;
    return Boolean(call.text) && selector.includes(call.text!);
  });
}

function readCapture(targets: HealTarget[]): { url: string; html: string } | null {
  const fromTarget = targets.find((target) => target.url);
  const files = captureFiles();
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { url?: string; html?: string; title?: string };
      if (typeof parsed.url !== 'string' || typeof parsed.html !== 'string') continue;
      if (!fromTarget || parsed.url === fromTarget.url || files.length === 1) return { url: parsed.url, html: parsed.html };
    } catch { /* skip a bad capture */ }
  }
  return files.length === 1 ? readOne(files[0]!) : null;
}

function readOne(file: string): { url: string; html: string } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { url?: string; html?: string };
    if (typeof parsed.url === 'string' && typeof parsed.html === 'string') return { url: parsed.url, html: parsed.html };
  } catch { /* ignore */ }
  return null;
}

function captureFiles(): string[] {
  const root = path.join(process.cwd(), '.qa-core');
  // Captures live in the temp folder recorded on the test. Also search recent temp names is not done.
  // The runner stores the directory on the process via CYPRESS_CAPTURE_DIR.
  const dir = captureDir;
  if (dir && fs.existsSync(dir)) return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
  if (!fs.existsSync(root)) return [];
  return [];
}

let captureDir: string | null = null;

export function setCaptureDir(dir: string): void {
  captureDir = dir;
}

function refused(call: CypressCall, reason: string, ambiguous = false): LocatorReport {
  return {
    file: rel(call.file), line: call.line, old: call.raw, new: null, level: 'css',
    ambiguous, status: 'refused', reason,
  };
}

function emptyRefusal(reason: string): LocatorReport {
  return { file: '', line: 1, old: '', new: null, level: 'css', ambiguous: false, status: 'refused', reason };
}

function intact(call: CypressCall): LocatorReport {
  return { file: rel(call.file), line: call.line, old: call.raw, new: null, level: 'css', ambiguous: false, status: 'intact' };
}

function rel(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

function resultOf(locators: LocatorReport[], plan: HealPlanEntry[], specs: string[]): HealResult {
  const healed = locators.filter((item) => item.status === 'healed').map((item) => ({
    file: path.resolve(item.file),
    line: item.line,
    old: item.old,
    new: item.new ?? '',
    level: item.level,
    occurrences: 1,
    occurrenceLines: [item.line],
  }));
  return {
    healedPath: null,
    filesWritten: [],
    scanned: locators.length,
    intact: locators.filter((item) => item.status === 'intact').length,
    healed,
    unhealable: locators.filter((item) => item.status === 'refused').map((item) => ({ file: item.file, selector: item.old, reason: item.reason ?? '' })),
    total: locators.length,
    locators,
    specFiles: Object.fromEntries(specs.map((spec) => [spec, [spec]])),
    unmatchedTargets: [],
    fileErrors: [],
    plan,
  };
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cssIdent(value: string): string {
  if (/^[A-Za-z_][\w-]*$/.test(value)) return value;
  return value.replace(/([^A-Za-z0-9_-])/g, '\\$1');
}

function locatorFor(page: Page, query: ProbeQuery) {
  if (query.kind === 'css') return page.locator(query.selector);
  if (query.kind === 'testId') return page.locator(`[data-test="${query.value.replace(/"/g, '\\"')}"]`);
  if (query.kind === 'text') {
    const root = query.selector && query.selector !== '*' ? page.locator(query.selector) : page.locator('body');
    return root.getByText(query.text, { exact: true });
  }
  if (query.kind === 'role') return page.getByRole(query.role as 'button', { name: query.name ?? '', exact: true });
  return null;
}

/** The candidate locator must carry `token` under the core same-element check. */
async function sameElement(page: Page, query: ProbeQuery, token: string): Promise<boolean> {
  const locator = locatorFor(page, query);
  if (!locator) return false;
  const { activeAdapter } = await import('../index.js');
  const result = await activeAdapter().confirmSameElement(locator, token);
  return result.confirmed;
}

function inFailedTest(
  call: CypressCall,
  targets: HealTarget[],
  sourceOf: (file: string) => string,
): boolean {
  const owner = testAtLine(sourceOf(call.file), call.line);
  if (!owner || owner.skip) return false;
  if (targets.length === 0) return false;
  const named = targets.some((target) => !target.test || target.test === owner.title);
  if (!named) return false;
  const spanned = targets.every((target) => {
    if (!target.testSpan || target.test !== owner.title) return true;
    return call.line >= target.testSpan.startLine && call.line < target.testSpan.endLine;
  });
  if (!spanned) return false;
  if (call.unsafe) return true;
  return matchesTarget(call, targets);
}

function readProjectConfig(root: string): string | null {
  for (const name of ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs', 'cypress.config.cjs']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return null;
}

export type { CypressQuote };
