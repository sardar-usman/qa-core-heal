import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { HOOK_URL } from './playwright-config.js';

/**
 * --auth-setup: explicit authenticated probing via the user's OWN login
 * code. The user points at a module + export ("utils/common.ts#login");
 * heal loads it and calls `await fn(page)` on a fresh page in the probing
 * context. This deliberately does NOT parse or re-execute beforeAll /
 * beforeEach hooks — setup code can seed data or trigger side effects, and
 * only the user can say what is safe to re-run.
 *
 * Loading uses the same TypeScript machinery as the config loader — a
 * CJS-compatible require shim resolved against the module's own location,
 * and the ESM-forcing retry hook for .ts files in typeless/commonjs
 * packages — but IN-PROCESS, because the function needs our live Page.
 *
 * Security: nothing here reads or logs credentials, cookie values, or
 * storage contents. Only file paths, export names, and pass/fail are ever
 * reported.
 */

export interface AuthSetup {
  fn: (page: Page) => Promise<void>;
  /** "utils/common.ts#login" — for messages; never contains secrets. */
  label: string;
}

function describeError(e: unknown): string {
  return e instanceof Error && e.name && e.message
    ? `${e.name}: ${e.message.split('\n')[0]}`
    : String(e);
}

/**
 * The config loader suppresses Node's TypeScript-loading noise by running
 * in a child process with --no-warnings; this loader is in-process (the
 * login function needs our live page), so the same warnings must be
 * filtered here. Drops ONLY the known loader noise — Type Stripping /
 * stripTypeScriptTypes experimental warnings, the typeless-package reparse
 * warning, and the "To load an ES module..." hint — for the duration of
 * the load; everything else passes through. Returns the restore function.
 */
function suppressLoaderWarnings(): () => void {
  const original = process.emitWarning.bind(process);
  const isLoaderNoise = (message: string, code?: string): boolean =>
    /Type Stripping|stripTypeScriptTypes/i.test(message)
    || /To load an ES module/.test(message)
    || code === 'MODULE_TYPELESS_PACKAGE_JSON';
  const filtered: typeof process.emitWarning = (warning, ...rest) => {
    const message = typeof warning === 'string' ? warning : (warning as Error)?.message ?? '';
    const opt = rest[0] as { code?: string } | string | undefined;
    const code = (typeof opt === 'object' && opt ? opt.code : undefined)
      ?? (typeof rest[1] === 'string' ? rest[1] : undefined)
      ?? (warning as { code?: string })?.code;
    if (isLoaderNoise(message, code)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = filtered;
  return () => { process.emitWarning = original; };
}

/**
 * Resolve "file#exportName" (default export when #export is omitted) into
 * a callable. Throws with a labeled, actionable message on every failure —
 * a broken auth setup must never degrade into an unauthenticated probe.
 */
export async function loadAuthSetup(spec: string, baseDir: string): Promise<AuthSetup> {
  const hash = spec.lastIndexOf('#');
  const filePart = hash > 0 ? spec.slice(0, hash) : spec;
  const exportName = hash > 0 ? spec.slice(hash + 1) : 'default';
  const label = `${filePart}#${exportName}`;
  const abs = path.resolve(baseDir, filePart);
  if (!fs.existsSync(abs)) {
    throw new Error(`auth setup module not found: ${abs}`);
  }
  // CJS interop for ESM-parsed modules that call require(...), resolved
  // against the user's module so their node_modules win.
  (globalThis as { require?: NodeJS.Require }).require = createRequire(abs);
  let mod: Record<string, unknown>;
  const restoreWarnings = suppressLoaderWarnings();
  try {
    try {
      mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
    } catch (e1) {
      if (!abs.endsWith('.ts')) {
        throw new Error(`auth setup ${label} failed to load: ${describeError(e1)}`);
      }
      try {
        const { register } = await import('node:module');
        register(HOOK_URL);
        mod = (await import(pathToFileURL(abs).href + '?qa-auth-esm-retry')) as Record<string, unknown>;
      } catch (e2) {
        throw new Error(
          `auth setup ${label} failed to load: import failed (${describeError(e1)}); ESM retry failed (${describeError(e2)})`,
        );
      }
    }
  } finally {
    restoreWarnings();
  }
  const candidate = mod[exportName] ?? (exportName === 'default' ? mod.default : undefined);
  if (typeof candidate !== 'function') {
    throw new Error(`auth setup ${label}: export "${exportName}" is not a function`);
  }
  return { fn: candidate as AuthSetup['fn'], label };
}

/** Reject after `ms` so a hanging login can never stall the run forever. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}
