import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { Edit, HealOptions, HealPlanEntry, HealResult, HealTarget, LocatorReport } from '../../heal.js';
import { matchFuzzy, type FuzzyCandidate } from '../../fuzzy.js';
import type { ProbeQuery } from '../types.js';
import { emitBy } from './emit.js';
import { parseSeleniumCalls, type SeleniumCall, type SeleniumQuote } from './parse.js';
import { testAtLine } from './list-tests.js';
import { countSeleniumQuery, seleniumMatchStamps } from './unique.js';

/**
 * Heal literal By calls against the captured page. There is no fresh load.
 * The probe is Playwright Chromium with JavaScript disabled.
 */
export async function healSelenium(opts: HealOptions): Promise<HealResult> {
  const specs = (opts.specPaths ?? (opts.specPath ? [opts.specPath] : [])).map((file) => path.resolve(file));
  const files = specs.filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  const calls = files.flatMap((file) => parseSeleniumCalls(fs.readFileSync(file, 'utf8'), file));
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
      const count = query ? await countSeleniumQuery(page, query) : 0;
      if (count === 1) {
        locators.push(intact(call));
        continue;
      }
      if (count > 1) {
        locators.push(refused(call, 'More than one element matches, so heal will not guess.', true));
        continue;
      }
      const proposal = await propose(page, call);
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
        line: call.line, startCol: call.startCol, endLine: call.endLine, endCol: call.endCol, newRaw: proposal.code,
      });
      locators.push({
        file: rel(call.file), line: call.line, old: call.raw, new: proposal.code, level: proposal.level,
        ambiguous: false, status: 'healed', occurrences: 1, occurrenceLines: [call.line],
      });
    }
  } finally {
    await browser.close();
  }
  const plan: HealPlanEntry[] = [...planEdits.entries()].map(([file, entry]) => ({ file, src: entry.src, edits: entry.edits }));
  return resultOf(locators, plan, specs);
}

async function propose(page: Page, call: SeleniumCall): Promise<{ code: string; level: 'testid' | 'css' | 'text' } | { ambiguous: true } | null> {
  const quote = call.quote;
  const elements = await scan(page);
  const source = identityOf(call);
  const candidates: FuzzyCandidate[] = elements.map((el) => ({ display: el.display, values: el.values, attrOf: el.attrOf }));
  const verdict = source ? matchFuzzy(source, candidates) : { kind: 'none' as const };
  if (verdict.kind === 'ambiguous') return { ambiguous: true };
  if (verdict.kind !== 'match') return null;
  const value = verdict.value;
  const attr = verdict.candidate.attrOf?.[value];
  const scanned = elements.find((el) => el.display === verdict.candidate.display);
  if (attr === 'id' && scanned?.id) {
    const query = { kind: 'css' as const, selector: `[id="${cssAttr(scanned.id)}"]` };
    if (await countSeleniumQuery(page, query) !== 1) return null;
    if (!await sameElement(page, query, scanned.stamp)) return null;
    return { code: emitBy('id', scanned.id, quote), level: 'css' };
  }
  if (attr === 'name' && scanned?.name) {
    const query = { kind: 'css' as const, selector: `[name="${cssAttr(scanned.name)}"]` };
    if (await countSeleniumQuery(page, query) !== 1) return null;
    if (!await sameElement(page, query, scanned.stamp)) return null;
    return { code: emitBy('name', scanned.name, quote), level: 'css' };
  }
  if (attr === 'data-test' || attr === 'data-testid' || attr === 'data-cy') {
    const selector = `[${attr}="${cssAttr(value)}"]`;
    const query = { kind: 'css' as const, selector };
    if (await countSeleniumQuery(page, query) !== 1) return null;
    if (!await sameElement(page, query, scanned?.stamp)) return null;
    return { code: emitBy('css', selector, quote), level: 'testid' };
  }
  if (attr === 'text' && scanned?.tag === 'a') {
    const query = { kind: 'text' as const, text: value, exact: true };
    if (await countSeleniumQuery(page, query) !== 1) return null;
    if (!await sameElement(page, query, scanned.stamp)) return null;
    return { code: emitBy('linkText', value, quote), level: 'text' };
  }
  if (attr === 'id' || attr === 'name' || attr === 'data-test') return null;
  return null;
}

interface Scanned {
  display: string;
  values: string[];
  attrOf: Record<string, string>;
  tag: string;
  id: string | null;
  name: string | null;
  stamp: string;
}

async function scan(page: Page): Promise<Scanned[]> {
  return page.evaluate(() => {
    const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();
    const out: Scanned[] = [];
    let serial = 0;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const tag = el.tagName.toLowerCase();
      const id = el.id || null;
      const name = el.getAttribute('name');
      const text = collapse(el.textContent ?? '');
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
      add(el.getAttribute('data-test'), 'data-test');
      add(el.getAttribute('data-testid'), 'data-testid');
      add(el.getAttribute('data-cy'), 'data-cy');
      add(id, 'id');
      add(name, 'name');
      if (tag === 'a' && text && text.length < 80) add(text, 'text');
      if (values.length === 0) continue;
      out.push({ display: id ? `#${id}` : values[0]!, values, attrOf, tag, id, name, stamp });
    }
    return out;
  });
}

function identityOf(call: SeleniumCall): string {
  if (!call.value) return '';
  if (call.strategy === 'css') {
    const attr = /\[(?:data-[\w-]+|name|id)\s*=\s*["']([^"']+)["']\]/.exec(call.value);
    if (attr) return attr[1]!;
    const id = /^#([A-Za-z_][\w-]*)$/.exec(call.value);
    if (id) return id[1]!;
  }
  return call.value;
}

function queryOf(call: SeleniumCall): ProbeQuery | null {
  if (!call.strategy || call.value == null) return null;
  if (call.strategy === 'css') return { kind: 'css', selector: call.value };
  if (call.strategy === 'id') return { kind: 'css', selector: `[id="${cssAttr(call.value)}"]` };
  if (call.strategy === 'name') return { kind: 'css', selector: `[name="${cssAttr(call.value)}"]` };
  if (call.strategy === 'xpath') return { kind: 'xpath', expression: call.value };
  if (call.strategy === 'linkText') return { kind: 'text', text: call.value, exact: true };
  if (call.strategy === 'partialLinkText') return { kind: 'text', text: call.value, exact: false };
  return null;
}

async function sameElement(page: Page, query: ProbeQuery, stamp: string | undefined): Promise<boolean> {
  if (!stamp) return false;
  const stamps = await seleniumMatchStamps(page, query);
  return stamps.length === 1 && stamps[0] === stamp;
}

function inFailedTest(call: SeleniumCall, targets: HealTarget[], sourceOf: (file: string) => string): boolean {
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

function matchesTarget(call: SeleniumCall, targets: HealTarget[]): boolean {
  return targets.some((target) => {
    const selector = target.selector.replace(/\s+/g, '');
    const raw = call.raw.replace(/\s+/g, '');
    return raw.includes(selector) || selector.includes(call.value ?? '___none___') || selector.includes(raw);
  });
}

let captureDir: string | null = null;

export function setSeleniumCaptureDir(dir: string): void {
  captureDir = dir;
}

function readCapture(targets: HealTarget[]): { url: string; html: string } | null {
  const dir = captureDir;
  if (!dir || !fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { url?: string; html?: string };
      if (typeof parsed.url === 'string' && typeof parsed.html === 'string') {
        const wanted = targets.find((target) => target.url);
        if (!wanted || parsed.url === wanted.url || files.length === 1) return { url: parsed.url, html: parsed.html };
      }
    } catch { /* skip */ }
  }
  return null;
}

function refused(call: SeleniumCall, reason: string, ambiguous = false): LocatorReport {
  return { file: rel(call.file), line: call.line, old: call.raw, new: null, level: 'css', ambiguous, status: 'refused', reason };
}

function emptyRefusal(reason: string): LocatorReport {
  return { file: '', line: 1, old: '', new: null, level: 'css', ambiguous: false, status: 'refused', reason };
}

function intact(call: SeleniumCall): LocatorReport {
  return { file: rel(call.file), line: call.line, old: call.raw, new: null, level: 'css', ambiguous: false, status: 'intact' };
}

function rel(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}

function resultOf(locators: LocatorReport[], plan: HealPlanEntry[], specs: string[]): HealResult {
  const healed = locators.filter((item) => item.status === 'healed').map((item) => ({
    file: path.resolve(item.file), line: item.line, old: item.old, new: item.new ?? '', level: item.level,
    occurrences: 1, occurrenceLines: [item.line],
  }));
  return {
    healedPath: null, filesWritten: [], scanned: locators.length,
    intact: locators.filter((item) => item.status === 'intact').length,
    healed,
    unhealable: locators.filter((item) => item.status === 'refused').map((item) => ({ file: item.file, selector: item.old, reason: item.reason ?? '' })),
    total: locators.length, locators,
    specFiles: Object.fromEntries(specs.map((spec) => [spec, [spec]])),
    unmatchedTargets: [], fileErrors: [], plan,
  };
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export type { SeleniumQuote };
