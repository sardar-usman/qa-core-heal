/**
 * Per-locator page context (routes).
 *
 * A spec suite rarely lives on one page: each test navigates somewhere with
 * page.goto(), and page objects hold locators for the route of whichever
 * specs import them. Probing every locator against the base URL homepage
 * makes locators on other routes look broken (or ambiguous against the
 * homepage's unrelated elements) — the exact failure this module removes.
 *
 * Route inference, per file:
 *   1. an explicit --route <file>=<route> override
 *   2. the file's own page.goto() calls: a locator uses the nearest goto
 *      above it, else the file's first goto (page-object constructors sit
 *      above the class's goto method)
 *   3. a page object with no goto inherits the routes of EVERY spec that
 *      imports it — its locators are probed on each of those routes
 *   4. otherwise the base URL itself
 * Relative routes are joined with the resolved base URL.
 */

export interface GotoCall {
  /** 1-indexed line of the .goto( call. */
  line: number;
  route: string;
}

export interface RouteOverride {
  /** Absolute path or path suffix (e.g. "pages/login-page.ts"). */
  file: string;
  route: string;
}

interface PlanFile { path: string; src: string }

export interface RoutePlanInput {
  files: PlanFile[];
  /** Spec path -> paths of every file gathered for that spec (spec first). */
  specFiles: Map<string, string[]>;
  overrides?: RouteOverride[];
  /** Resolved absolute base URL; relative routes join against it. */
  baseUrl: string;
}

export interface RoutePlan {
  gotosByFile: Map<string, GotoCall[]>;
  overrideByFile: Map<string, string>;
  /** File path -> routes inherited from importing specs (POMs without gotos). */
  inheritedByFile: Map<string, string[]>;
  baseUrl: string;
}

/** Read a JS string literal starting at src[i] (a quote); value + end index. */
function readString(src: string, i: number): { value: string; end: number } | null {
  const quote = src[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let out = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { out += src[j + 1] ?? ''; j += 2; continue; }
    if (c === quote) return { value: out, end: j + 1 };
    out += c;
    j++;
  }
  return null;
}

/**
 * Every page.goto() in a file, in order. A literal argument is taken as-is;
 * an identifier argument (goto(this.url)) resolves against the first `url`
 * string property in the same file, the common page-object shape.
 */
export function parseGotos(src: string): GotoCall[] {
  const out: GotoCall[] = [];
  const re = /\.goto\(\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const argAt = m.index + m[0].length;
    const line = src.slice(0, m.index).split('\n').length;
    const lit = readString(src, argAt);
    if (lit) {
      out.push({ line, route: lit.value });
      continue;
    }
    const prop = src.match(/\burl\s*[:=]\s*["'`]([^"'`]+)["'`]/);
    if (prop) out.push({ line, route: prop[1]! });
  }
  return out;
}

/** Route governing a locator at `line`: nearest goto above, else the first. */
export function routeForLine(gotos: GotoCall[], line: number): string | null {
  if (gotos.length === 0) return null;
  let best: GotoCall | null = null;
  for (const g of gotos) {
    if (g.line <= line && (!best || g.line > best.line)) best = g;
  }
  return (best ?? gotos[0]!).route;
}

/**
 * Strip trailing auto-generated-looking words (bare numbers, hex blobs)
 * from an intent token, so "#Email_1" can retry as "Email" after "Email 1"
 * finds nothing. Returns null when nothing was stripped, or when stripping
 * would leave nothing distinctive.
 */
export function stripAutoSuffixes(token: string): string | null {
  const words = token.trim().split(/\s+/);
  const generated = (w: string): boolean => /^\d+$/.test(w) || (/^[0-9a-f]{4,}$/i.test(w) && /\d/.test(w));
  let end = words.length;
  while (end > 0 && generated(words[end - 1]!)) end--;
  if (end === 0) return null;
  if (end === words.length) {
    // No whole word stripped: a trailing digit glued to the last word is
    // the same auto-suffix pattern ("search1" → "search"), as long as the
    // alpha part is long enough to be an identity on its own.
    const last = words[words.length - 1]!;
    const m = last.match(/^([A-Za-z]{3,})\d+$/);
    if (m) return [...words.slice(0, -1), m[1]!].join(' ');
    return null;
  }
  return words.slice(0, end).join(' ');
}

function pathSuffixMatches(filePath: string, pattern: string): boolean {
  const norm = (p: string): string => p.split('\\').join('/');
  const f = norm(filePath);
  const pat = norm(pattern);
  return f === pat || f.endsWith('/' + pat);
}

export function buildRoutePlan(input: RoutePlanInput): RoutePlan {
  const overrideByFile = new Map<string, string>();
  for (const f of input.files) {
    const o = (input.overrides ?? []).find((ov) => pathSuffixMatches(f.path, ov.file));
    if (o) overrideByFile.set(f.path, o.route);
  }

  const gotosByFile = new Map<string, GotoCall[]>();
  for (const f of input.files) gotosByFile.set(f.path, parseGotos(f.src));

  // A spec's primary route: its override, its first goto, else the first
  // override/goto found in the files it gathers (page objects, import
  // order). Null when NOTHING carries a route signal — the bare base-URL
  // fallback must not masquerade as an inherited route.
  const specPrimary = new Map<string, string | null>();
  for (const [spec, filePaths] of input.specFiles) {
    let route: string | undefined;
    for (const p of filePaths) {
      route = overrideByFile.get(p) ?? gotosByFile.get(p)?.[0]?.route;
      if (route) break;
    }
    specPrimary.set(spec, route ?? null);
  }

  // Files with no goto of their own (shared page objects) inherit the
  // primary route of every spec that gathers them.
  const inheritedByFile = new Map<string, string[]>();
  for (const f of input.files) {
    if (overrideByFile.has(f.path) || (gotosByFile.get(f.path)?.length ?? 0) > 0) continue;
    const routes: string[] = [];
    for (const [spec, filePaths] of input.specFiles) {
      if (!filePaths.includes(f.path)) continue;
      const r = specPrimary.get(spec);
      if (r && !routes.includes(r)) routes.push(r);
    }
    inheritedByFile.set(f.path, routes);
  }

  return { gotosByFile, overrideByFile, inheritedByFile, baseUrl: input.baseUrl };
}

/** Join a route (possibly relative) with the plan's base URL. */
export function resolveRoute(baseUrl: string, route: string): string {
  try { return new URL(route, baseUrl).href; } catch { return baseUrl; }
}

/** Resolved absolute URLs a locator at file:line must be probed on. */
export function routesForLocator(plan: RoutePlan, filePath: string, line: number): string[] {
  const override = plan.overrideByFile.get(filePath);
  if (override) return [resolveRoute(plan.baseUrl, override)];
  const own = routeForLine(plan.gotosByFile.get(filePath) ?? [], line);
  if (own) return [resolveRoute(plan.baseUrl, own)];
  const inherited = plan.inheritedByFile.get(filePath) ?? [];
  if (inherited.length > 0) {
    const out: string[] = [];
    for (const r of inherited) {
      const abs = resolveRoute(plan.baseUrl, r);
      if (!out.includes(abs)) out.push(abs);
    }
    return out;
  }
  return [resolveRoute(plan.baseUrl, '')];
}

/**
 * True when the locator's file has a REAL route signal — an override, its
 * own goto, or routes inherited from importing specs — as opposed to the
 * bare base-URL fallback, which is a guess about where the element lives.
 */
export function hasExplicitRoute(plan: RoutePlan, filePath: string, line: number): boolean {
  if (plan.overrideByFile.has(filePath)) return true;
  if (routeForLine(plan.gotosByFile.get(filePath) ?? [], line) !== null) return true;
  return (plan.inheritedByFile.get(filePath) ?? []).length > 0;
}

/** Human-readable route for refusal messages: the path part of the URL. */
export function routeLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
