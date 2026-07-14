import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Reads use.baseURL from the target project's own Playwright config by
 * actually importing the module, exactly the way Playwright evaluates it:
 * defineConfig() runs, env vars resolve, computed values compute. Nothing
 * here parses config text.
 *
 * The import happens in a CHILD Node process launched with --no-warnings,
 * so the noise Node prints when loading TypeScript (ExperimentalWarning:
 * Type Stripping) or a typeless package.json (MODULE_TYPELESS_PACKAGE_JSON)
 * never reaches the CLI's output. The child also isolates us from configs
 * that throw.
 *
 * TypeScript configs need Node's native type stripping, available from
 * 22.6 (behind a flag until 22.18 / 23.6). On older Node the .ts path is
 * gated: the loader skips it and the CLI exits with an actionable message
 * when the config was the only way to learn the base URL. Plain .js/.mjs/
 * .cjs configs load on any supported Node.
 */

const CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
] as const;

/** Path of the Playwright config directly inside `dir`, or null. */
export function findPlaywrightConfig(dir: string): string | null {
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* not this one */ }
  }
  return null;
}

function versionParts(version: string): [number, number] {
  const m = version.replace(/^v/, '').split('.');
  return [Number(m[0] ?? 0), Number(m[1] ?? 0)];
}

/** Native TypeScript type stripping exists from Node 22.6. */
export function supportsTypeStripping(version: string = process.versions.node): boolean {
  const [major, minor] = versionParts(version);
  return major > 22 || (major === 22 && minor >= 6);
}

/**
 * Between 22.6–22.17 and 23.0–23.5 type stripping exists but sits behind
 * --experimental-strip-types; from 22.18 / 23.6 it is on by default and the
 * flag is unnecessary.
 */
export function needsStripFlag(version: string = process.versions.node): boolean {
  const [major, minor] = versionParts(version);
  if (major === 22) return minor >= 6 && minor < 18;
  if (major === 23) return minor < 6;
  return false;
}

/** The exact message the CLI exits with when a .ts config needs newer Node. */
export function typeStrippingGateMessage(version: string = process.versions.node): string {
  return `qa-core-heal requires Node 22.6+ to read TypeScript configs. `
    + `Detected v${version.replace(/^v/, '')}. Workaround: pass --base-url and --route flags.`;
}

/**
 * The ESM-forcing retry hook: serves .ts files as stripped ES modules
 * regardless of the package's "type" field. Some Nodes treat a .ts file in
 * a typeless/commonjs package as CJS, where its import statements throw
 * "Cannot use import statement outside a module" — exactly what
 * Playwright's own loader tolerates and we must too.
 *
 * After stripping, every named import is rewritten to a namespace import
 * plus destructuring. Type stripping removes annotations but does NOT
 * elide type-only import SPECIFIERS written without the `import type`
 * keyword ("import { defineConfig, ReporterDescription } from ..."), so
 * the stripped module would request a named export that does not exist at
 * runtime. Destructuring a missing export yields undefined — harmless,
 * because a type identifier is unused after stripping.
 */
const HOOK_SOURCE = `
import { stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const rewriteNamedImports = (src) => {
  let n = 0;
  return src.replace(
    /(^|\\n)([ \\t]*)import\\s+(?:([A-Za-z_$][\\w$]*)\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*(['"][^'"]+['"])[ \\t]*;?/g,
    (whole, pre, indent, defaultName, specs, spec) => {
      const ns = '__qa_ns' + (n++);
      const fields = specs.split(',')
        .map((s) => s.replace(/\\s+/g, ' ').trim())
        .filter((s) => s && !s.startsWith('type '))
        .map((s) => {
          const aliased = s.match(/^(.+?) as (.+)$/);
          return aliased ? aliased[1].trim() + ': ' + aliased[2].trim() : s;
        });
      let out = pre + indent + 'import * as ' + ns + ' from ' + spec + ';';
      if (defaultName) out += ' const ' + defaultName + ' = ' + ns + '.default;';
      if (fields.length) out += ' const { ' + fields.join(', ') + ' } = ' + ns + ';';
      return out;
    },
  );
};

export async function load(url, context, nextLoad) {
  if (new URL(url).pathname.endsWith('.ts')) {
    const src = fs.readFileSync(fileURLToPath(url), 'utf8');
    return {
      format: 'module',
      source: rewriteNamedImports(stripTypeScriptTypes(src)),
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
`;

export const HOOK_URL = 'data:text/javascript,' + encodeURIComponent(HOOK_SOURCE);

/**
 * Runs in the child process (--input-type=module, so top-level await
 * works). argv[1] is the config path, argv[2] an optional --project name.
 * The single line of stdout is JSON:
 *   { baseUrl: string|null, error: string|null,
 *     disagreement: Array<{name, baseURL}>|null }
 *
 * Before importing, two pieces of Playwright-loader parity:
 *   - a CJS-compatible require is exposed on globalThis, resolved against
 *     the CONFIG's own location, so ESM-parsed configs that call
 *     require("dotenv").config() work exactly as they do under Playwright;
 *   - .env next to the config is loaded as a fallback WITHOUT overriding
 *     env vars that are already set (most configs load dotenv themselves,
 *     which the require shim makes work — this covers the ones that rely
 *     on Playwright-adjacent tooling to have loaded it).
 *
 * Genuinely-CJS configs (.cjs, or .js with no import/export syntax in a
 * non-module package) are loaded via that require directly instead of
 * import(), so `module.exports = ...` works without any ESM wrapping.
 */
const LOADER_SCRIPT = `
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const configPath = process.argv[1];
const projectName = process.argv[2] || null;
globalThis.require = createRequire(configPath);

try {
  const envFile = path.join(path.dirname(configPath), '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\\n')) {
      const m = line.match(/^\\s*(?:export\\s+)?([\\w.]+)\\s*=\\s*(.*?)\\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
} catch { /* a malformed .env never blocks the load */ }

const describeError = (e) => (e && e.name && e.message ? e.name + ': ' + e.message.split('\\n')[0] : String(e));

let cfg = null;
let error = null;
{
  const looksEsm = /^[ \\t]*(import|export)\\b/m.test(fs.readFileSync(configPath, 'utf8'));
  let mod = null;
  let importError = null;
  // 1. Always try native import() first (the require shim above makes
  //    ESM configs calling require(...) work).
  try {
    mod = await import(pathToFileURL(configPath).href);
  } catch (e) {
    importError = e;
  }
  // 2. .ts that failed to import: retry with the ESM-forcing hook (the
  //    query buster skips the cached failed evaluation).
  if (!mod && configPath.endsWith('.ts')) {
    try {
      const { register } = await import('node:module');
      register(${JSON.stringify(HOOK_URL)});
      mod = await import(pathToFileURL(configPath).href + '?qa-core-esm-retry');
    } catch (e) {
      error = 'import failed (' + describeError(importError) + '); ESM retry failed (' + describeError(e) + ')';
    }
  }
  // 3. Genuinely-CJS file (no import/export syntax): load via require.
  if (!mod && !looksEsm) {
    try {
      mod = { default: globalThis.require(configPath) };
      error = null;
    } catch (e) {
      error = 'import failed (' + describeError(importError) + '); require fallback failed (' + describeError(e) + ')';
    }
  }
  if (!mod && !error) error = describeError(importError);
  if (mod) {
    cfg = mod.default ?? mod;
    if (cfg && cfg.__esModule && cfg.default) cfg = cfg.default;
  }
}

const pick = (c) =>
  (c && typeof c === 'object' && c.use && typeof c.use.baseURL === 'string' && c.use.baseURL)
    ? c.use.baseURL : null;
const pickState = (c) =>
  (c && typeof c === 'object' && c.use && typeof c.use.storageState === 'string' && c.use.storageState)
    ? c.use.storageState : null;
let baseUrl = null;
let disagreement = null;
let storageState = null;
if (cfg && typeof cfg === 'object') {
  baseUrl = pick(cfg);
  storageState = pickState(cfg);
  if (!storageState && Array.isArray(cfg.projects)) {
    const states = [...new Set(cfg.projects.map(pickState).filter(Boolean))];
    if (states.length === 1) storageState = states[0];
  }
  if (!baseUrl && Array.isArray(cfg.projects)) {
    if (projectName) {
      const p = cfg.projects.find((p) => p && p.name === projectName);
      baseUrl = pick(p);
      if (!baseUrl && !error) error = 'project "' + projectName + '" not found or has no use.baseURL';
    } else {
      const named = cfg.projects
        .map((p) => ({ name: (p && p.name) || '(unnamed)', baseURL: pick(p) }))
        .filter((p) => p.baseURL);
      const urls = [...new Set(named.map((p) => p.baseURL))];
      if (urls.length === 1) baseUrl = urls[0];
      else if (urls.length > 1) disagreement = named;
    }
  }
}
// fd 3, not stdout: user configs (and libraries like dotenv) may write to
// stdout while loading, which must never corrupt the result channel.
fs.writeSync(3, JSON.stringify({ baseUrl, error, disagreement, storageState }));
`;

const LOADER_TIMEOUT_MS = 15000;

export interface PlaywrightConfigResolution {
  configPath: string;
  baseUrl: string | null;
  /** Set when the config EXISTS but could not be evaluated: absence != failure. */
  loadError?: string;
  /** Set when projects define different baseURLs and no --project was given. */
  disagreement?: Array<{ name: string; baseURL: string }>;
  /** use.storageState (top-level, or agreed across projects), absolute. */
  storageState?: string;
}

/**
 * Evaluate the Playwright config found in `dir` (in a warning-suppressed
 * child process). Returns null only when there IS no config file; a config
 * that fails to load reports loadError so callers can warn instead of
 * silently claiming there was no baseURL.
 */
export async function resolvePlaywrightConfig(
  dir: string,
  project?: string,
): Promise<PlaywrightConfigResolution | null> {
  const configPath = findPlaywrightConfig(dir);
  if (!configPath) return null;
  const isTs = configPath.endsWith('.ts');
  if (isTs && !supportsTypeStripping()) return { configPath, baseUrl: null };
  const args = ['--no-warnings'];
  if (isTs && needsStripFlag()) args.push('--experimental-strip-types');
  args.push('--input-type=module', '-e', LOADER_SCRIPT, configPath);
  if (project) args.push(project);
  return new Promise((resolve) => {
    // stdout/stderr are discarded: loading a user config may print (dotenv
    // tips, conditional reporters). The result travels on fd 3.
    const child = spawn(process.execPath, args, {
      cwd: dir, stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    let out = '';
    let done = false;
    const finish = (value: PlaywrightConfigResolution): void => {
      if (!done) { done = true; resolve(value); }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ configPath, baseUrl: null, loadError: `timed out after ${LOADER_TIMEOUT_MS}ms` });
    }, LOADER_TIMEOUT_MS);
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (e: Error) => {
      clearTimeout(timer);
      finish({ configPath, baseUrl: null, loadError: e.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as {
          baseUrl?: unknown; error?: unknown; storageState?: unknown;
          disagreement?: Array<{ name: string; baseURL: string }> | null;
        };
        finish({
          configPath,
          baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : null,
          loadError: typeof parsed.error === 'string' ? parsed.error : undefined,
          disagreement: parsed.disagreement ?? undefined,
          storageState: typeof parsed.storageState === 'string' && parsed.storageState
            ? path.resolve(dir, parsed.storageState)
            : undefined,
        });
      } catch {
        finish({ configPath, baseUrl: null, loadError: 'loader produced no result' });
      }
    });
  });
}

/** Back-compat convenience: just the baseURL, or null. */
export async function resolvePlaywrightBaseUrl(dir: string): Promise<string | null> {
  const res = await resolvePlaywrightConfig(dir);
  return res?.baseUrl ?? null;
}
