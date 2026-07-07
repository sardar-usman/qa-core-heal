import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { emitLocatorCall } from './selectors.js';
import { healResolve } from './heal-resolve.js';
import { installEvalShim } from './eval-shim.js';
/* ─────────────────────────── parsing ─────────────────────────── */
const LOCATOR_METHODS = [
    'getByRole', 'getByLabel', 'getByPlaceholder', 'getByText',
    'getByAltText', 'getByTitle', 'getByTestId', 'locator',
];
/** Read a JS string literal starting at s[i] (a quote). Returns its value and end index. */
function readString(s, i) {
    const quote = s[i];
    if (quote !== '"' && quote !== "'" && quote !== '`')
        return null;
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
        if (c === quote)
            return { value: out, end: j + 1 };
        out += c;
        j++;
    }
    return null;
}
/** Index of the ')' matching the '(' at `open`, skipping string literals. -1 if unbalanced. */
function matchParen(s, open) {
    let depth = 0;
    for (let j = open; j < s.length; j++) {
        const c = s[j];
        if (c === '"' || c === "'" || c === '`') {
            const r = readString(s, j);
            if (!r)
                return -1;
            j = r.end - 1;
            continue;
        }
        if (c === '(')
            depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0)
                return j;
        }
    }
    return -1;
}
/** First string literal anywhere in a fragment. */
function firstString(s) {
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '"' || s[i] === "'" || s[i] === '`') {
            const r = readString(s, i);
            if (r)
                return r.value;
        }
    }
    return null;
}
/** Value of a `<key>: "..."` string option, with or without a quoted key (JSON emits `"name":`). */
function namedString(s, key) {
    const m = s.match(new RegExp(`["']?\\b${key}\\b["']?\\s*:\\s*`));
    if (!m || m.index == null)
        return null;
    const at = m.index + m[0].length;
    const r = readString(s, at);
    return r ? r.value : null;
}
function levelOf(method, args) {
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
function parseArgs(method, argsRaw) {
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
            if (s.startsWith('xpath='))
                return { xpath: s.slice('xpath='.length) };
            if (s.startsWith('//') || s.startsWith('./') || s.startsWith('(//'))
                return { xpath: s };
            return { css: s };
        }
    }
}
/** Extract every locator chain in a file: page[.frameLocator(...)].getByX(...) / .locator(...). */
function parseLocatorCalls(src, file) {
    const calls = [];
    const lines = src.split('\n');
    const rootRe = /(?<![\w.$])(this\.page|page)\b/g;
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        let rm;
        rootRe.lastIndex = 0;
        while ((rm = rootRe.exec(line)) !== null) {
            const root = rm[1];
            let pos = rm.index + root.length;
            const frameChain = [];
            let matched = null;
            let open = -1;
            // Consume any .frameLocator("...") prefixes, then the terminal locator method.
            for (;;) {
                if (line.startsWith('.frameLocator(', pos)) {
                    const fo = pos + '.frameLocator'.length;
                    const fc = matchParen(line, fo);
                    if (fc < 0)
                        break;
                    const inner = firstString(line.slice(fo + 1, fc));
                    if (inner != null)
                        frameChain.push(inner);
                    pos = fc + 1;
                    continue;
                }
                for (const m of LOCATOR_METHODS) {
                    if (line.startsWith('.' + m + '(', pos)) {
                        matched = m;
                        open = pos + 1 + m.length;
                        break;
                    }
                }
                break;
            }
            if (!matched || open < 0)
                continue;
            const close = matchParen(line, open);
            if (close < 0)
                continue;
            const argsRaw = line.slice(open + 1, close);
            const args = parseArgs(matched, argsRaw);
            calls.push({
                file, line: li + 1, startCol: rm.index, endCol: close + 1,
                raw: line.slice(rm.index, close + 1), root, method: matched,
                level: levelOf(matched, args), frameChain, args,
            });
        }
    }
    return calls;
}
/** The spec plus any relative-imported page-object files that exist on disk. */
function gatherFiles(specPath, specSrc, followImports, pageObjectDirs) {
    const files = [{ path: specPath, src: specSrc }];
    const dir = path.dirname(specPath);
    const seen = new Set([specPath]);
    if (followImports) {
        for (const m of specSrc.matchAll(/import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
            const spec = m[1];
            if (!spec.startsWith('.'))
                continue; // package import, not a local page object
            const resolved = resolveImport(dir, spec);
            if (resolved && !seen.has(resolved)) {
                seen.add(resolved);
                files.push({ path: resolved, src: fs.readFileSync(resolved, 'utf8') });
            }
        }
    }
    // Extra page-object directories from config. Scanned flat (not recursive),
    // sorted for a deterministic scan order, deduped against imported files.
    for (const d of pageObjectDirs ?? []) {
        let names = [];
        try {
            names = fs.readdirSync(d);
        }
        catch {
            continue;
        }
        for (const name of names.sort()) {
            if (!/\.(ts|js)$/.test(name))
                continue;
            const p = path.resolve(d, name);
            if (seen.has(p))
                continue;
            try {
                if (!fs.statSync(p).isFile())
                    continue;
            }
            catch {
                continue;
            }
            seen.add(p);
            files.push({ path: p, src: fs.readFileSync(p, 'utf8') });
        }
    }
    return files;
}
/** Resolve a relative import to a real file, trying the common extensions. */
function resolveImport(fromDir, spec) {
    const base = path.resolve(fromDir, spec);
    const candidates = [
        base, `${base}.ts`, `${base}.js`,
        base.replace(/\.js$/, '.ts'), base.replace(/\.ts$/, '.js'),
        path.join(base, 'index.ts'), path.join(base, 'index.js'),
    ];
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isFile())
                return c;
        }
        catch { /* not this one */ }
    }
    return null;
}
/** The URL the spec targets: an explicit override, else a goto, else a page-object url. */
function findTargetUrl(files, baseUrl) {
    if (baseUrl)
        return baseUrl;
    for (const f of files) {
        const g = f.src.match(/\.goto\(\s*["'`](https?:\/\/[^"'`]+)["'`]/);
        if (g)
            return g[1];
    }
    for (const f of files) {
        const u = f.src.match(/\burl\s*[:=]\s*["'`](https?:\/\/[^"'`]+)["'`]/);
        if (u)
            return u[1];
    }
    return null;
}
/* ─────────────────── live probing + confirmation ─────────────────── */
function scopeFor(page, frameChain) {
    let scope = page;
    for (const f of frameChain)
        scope = scope.frameLocator(f);
    return scope;
}
/** Rebuild the actual Playwright locator so we can ask the live page if it still resolves. */
function buildLocator(page, call) {
    const scope = scopeFor(page, call.frameChain);
    const a = call.args;
    const role = (a.role ?? '');
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
function intentToken(call) {
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
function tokenFromCss(css) {
    const attr = css.match(/\[(?:data-test(?:id)?|name|aria-label|placeholder|title|alt)\s*=\s*["']?([^"'\]]+)/i);
    if (attr)
        return attr[1].replace(/[-_]+/g, ' ').trim();
    const idOrClass = css.match(/[#.]([A-Za-z][\w-]{1,})/);
    if (idOrClass)
        return idOrClass[1].replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return '';
}
function norm(s) {
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
/** Semantic strings carried by a live element: accessible name sources + text + id. */
async function elementSemantics(locator) {
    return locator.first().evaluate((el) => {
        const out = [];
        const attrs = ['aria-label', 'placeholder', 'name', 'alt', 'title', 'value', 'data-testid', 'data-test'];
        for (let i = 0; i < attrs.length; i++) {
            const v = el.getAttribute(attrs[i]);
            if (v)
                out.push(v);
        }
        const inp = el;
        if (typeof inp.value === 'string' && inp.value)
            out.push(inp.value);
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t)
            out.push(t);
        if (el.id)
            out.push(el.id);
        return out;
    }).catch(() => []);
}
/**
 * Confirm the re-resolved element is the SAME intended element: its accessible
 * name / text / label must still carry the original token. This is the guard
 * that makes a wrong heal (to a different element) fail instead of shipping.
 */
async function confirmSameElement(locator, token) {
    const nt = norm(token);
    if (nt.length < 2)
        return false; // nothing specific enough to confirm against
    const sem = await elementSemantics(locator);
    return sem.some((s) => {
        const ns = norm(s);
        if (!ns)
            return false;
        return ns.includes(nt) || (ns.length >= 3 && nt.includes(ns));
    });
}
function applyEdits(src, edits) {
    const lines = src.split('\n');
    const byLine = new Map();
    for (const e of edits) {
        const list = byLine.get(e.line) ?? [];
        list.push(e);
        byLine.set(e.line, list);
    }
    for (const [ln, list] of byLine) {
        list.sort((a, b) => b.startCol - a.startCol); // right-to-left keeps offsets valid
        let line = lines[ln - 1] ?? '';
        for (const e of list)
            line = line.slice(0, e.startCol) + e.newRaw + line.slice(e.endCol);
        lines[ln - 1] = line;
    }
    return lines.join('\n');
}
/* ─────────────────────────── main ─────────────────────────── */
export async function heal(opts) {
    const specPath = path.resolve(opts.specPath);
    if (!fs.existsSync(specPath))
        throw new Error(`Spec not found: ${specPath}`);
    const write = opts.write !== false;
    const specSrc = fs.readFileSync(specPath, 'utf8');
    const files = gatherFiles(specPath, specSrc, opts.followImports !== false, opts.pageObjectDirs);
    const calls = files.flatMap((f) => parseLocatorCalls(f.src, f.path));
    const url = findTargetUrl(files, opts.baseUrl);
    if (!url) {
        throw new Error('Could not determine the target URL from the spec. Pass --base-url <url>.');
    }
    opts.onEvent?.({ type: 'scanned', total: calls.length, files: files.length });
    const healed = [];
    const unhealable = [];
    const locators = [];
    let intact = 0;
    const editsByFile = new Map();
    const relFile = (f) => path.relative(process.cwd(), f).split(path.sep).join('/');
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext(opts.storageState && fs.existsSync(opts.storageState)
            ? { storageState: opts.storageState }
            : {});
        await installEvalShim(context);
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForLoadState('networkidle').catch(() => undefined);
        opts.onEvent?.({ type: 'opened_page', url });
        const refuse = (call, reason, ambiguous) => {
            unhealable.push({ file: call.file, selector: call.raw, reason });
            locators.push({
                file: relFile(call.file), line: call.line, old: call.raw, new: null,
                level: call.level, ambiguous, status: 'refused', reason,
            });
            opts.onEvent?.({ type: 'unhealed', selector: call.raw, reason, file: relFile(call.file) });
        };
        const markIntact = (call, ambiguous) => {
            intact++;
            locators.push({
                file: relFile(call.file), line: call.line, old: call.raw, new: null,
                level: call.level, ambiguous, status: 'intact',
            });
            opts.onEvent?.({ type: 'intact', selector: call.raw });
        };
        for (const call of calls) {
            // 1. Does the original locator still resolve? If so, leave it untouched.
            let count = 0;
            try {
                count = await buildLocator(page, call).count();
            }
            catch {
                count = 0;
            }
            if (count >= 1) {
                markIntact(call, count > 1);
                continue;
            }
            // 2. Broken. Re-resolve by semantic intent with the SAME ladder + healResolve.
            opts.onEvent?.({ type: 'healing', selector: call.raw });
            if (opts.maxHeals != null && healed.length >= opts.maxHeals) {
                refuse(call, `maxHealsPerRun (${opts.maxHeals}) reached; heal skipped`, false);
                continue;
            }
            const token = intentToken(call);
            if (norm(token).length < 2) {
                refuse(call, 'no semantic identity (nameless / opaque selector) to re-resolve or confirm', false);
                continue;
            }
            const resolved = await healResolve(page, { intent: token });
            if (!resolved) {
                refuse(call, 'could not be re-resolved on the live page', false);
                continue;
            }
            // 3. Refuse an ambiguous match, we cannot know which element was meant.
            if (resolved.ambiguous) {
                refuse(call, 'ambiguous: several elements match the intent, refusing to guess', true);
                continue;
            }
            // 3b. A heal landing on a level the config excludes is refused, not applied.
            if (opts.allowedLevels && !opts.allowedLevels.includes(resolved.level)) {
                refuse(call, `healed to level "${resolved.level}", which selectorPreference excludes`, false);
                continue;
            }
            // 4. Confirm it is the SAME intended element, not just any loose match.
            const same = await confirmSameElement(resolved.locator, token);
            if (!same) {
                refuse(call, 're-resolved to a different element, not healing (would be wrong)', false);
                continue;
            }
            // 5. Emit the healed locator with the shared emitter, preserving the root.
            let newRaw = emitLocatorCall(resolved.level, resolved.arg, false, resolved.frameChain);
            if (call.root === 'this.page')
                newRaw = 'this.' + newRaw;
            if (newRaw === call.raw) {
                // Re-resolved to the same call it already was, nothing to change.
                markIntact(call, false);
                continue;
            }
            const list = editsByFile.get(call.file) ?? [];
            list.push({ line: call.line, startCol: call.startCol, endCol: call.endCol, newRaw });
            editsByFile.set(call.file, list);
            healed.push({ file: call.file, line: call.line, old: call.raw, new: newRaw, level: resolved.level });
            locators.push({
                file: relFile(call.file), line: call.line, old: call.raw, new: newRaw,
                level: resolved.level, ambiguous: false, status: 'healed',
            });
            opts.onEvent?.({ type: 'healed', old: call.raw, new: newRaw, level: resolved.level, file: relFile(call.file) });
        }
    }
    finally {
        await browser?.close();
    }
    const filesWritten = [];
    if (write) {
        for (const [file, edits] of editsByFile) {
            const original = files.find((f) => f.path === file).src;
            fs.writeFileSync(file, applyEdits(original, edits));
            filesWritten.push(file);
        }
    }
    opts.onEvent?.({
        type: 'done', healed: healed.length, unhealed: unhealable.length,
        intact, total: calls.length, files: filesWritten,
    });
    return {
        healedPath: filesWritten.includes(specPath) ? specPath : (filesWritten[0] ?? null),
        filesWritten, scanned: calls.length, intact, healed, unhealable, total: calls.length,
        locators,
    };
}
