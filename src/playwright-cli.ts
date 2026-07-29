import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { escapeRegex } from './selectors.js';

/**
 * A file/directory path in the form Playwright's CLI can actually match.
 * Playwright compares file filters against FORWARD-SLASH paths on every
 * platform and treats them as regex fragments, so a win32 path like
 * "tests\systematic\1-dynamic-ids.spec.js" can never match: the
 * backslashes are wrong separators AND "\1" is a backreference. Empirical
 * findings (pinned by tests): backslash filters match 0 tests, raw
 * bracket dirs ("tests/[id]/…") match 0 (char class), raw paren dirs
 * ("(group)") match 0 (regex group) — while regex-ESCAPED forward-slash
 * filters match all of them, and escaping is harmless on ordinary paths.
 * Internal fs work keeps native separators; ONLY what crosses into the
 * Playwright child goes through this.
 */
export function toCliFileFilter(p: string): string {
  return escapeRegex(p.replaceAll('\\', '/'));
}

/**
 * Cross-platform Playwright child runs.
 *
 * The obvious `spawnSync('npx', ['playwright', ...])` is POSIX-shaped
 * three ways: on Windows the binary is npx.cmd (bare 'npx' ENOENTs
 * without a shell); shell:true hands the argv to cmd.exe, which mangles
 * it (a --grep pattern like "title a|title b" becomes a PIPE, paths with
 * spaces lose their grouping); and it depends on PATH at all. Instead
 * the LOCAL @playwright/test CLI entry is resolved from the project root
 * and run with our own node executable: argv passes through verbatim on
 * every platform — no shim, no shell, no PATH. npx (via a shell on
 * Windows) remains only as a fallback when resolution fails. Env, when
 * given, travels via the spawn options object, never a "VAR=value cmd"
 * prefix string; the JSON report is read from the child's stdout, so no
 * temp-file path exists to get platform-specific.
 */

/** The fallback note prints once per process: repeated child runs in the
 *  same invocation (main run + verify re-runs) need only one warning. */
let npxFallbackNoted = false;

export interface PlaywrightRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The exact command attempted, for error reporting. */
  command: string;
  /** The spawn-level error (ENOENT and friends), when the child never ran. */
  error?: Error;
}

export function runPlaywrightCli(
  root: string,
  args: string[],
  maxBuffer: number,
  env?: NodeJS.ProcessEnv,
): PlaywrightRunResult {
  const opts = {
    cwd: root,
    encoding: 'utf8' as const,
    maxBuffer,
    ...(env ? { env } : {}),
  };
  let cliJs: string | null = null;
  try {
    cliJs = createRequire(path.join(root, 'package.json')).resolve('@playwright/test/cli');
  } catch { /* not installed under this root; npx may still find it */ }
  if (cliJs) {
    const r = spawnSync(process.execPath, [cliJs, ...args], opts);
    return {
      status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
      command: [process.execPath, cliJs, ...args].join(' '),
      error: r.error,
    };
  }
  // The weaker, PATH-dependent path is in use — say so exactly once. The
  // direct local-CLI path above must never print this.
  if (!npxFallbackNoted) {
    npxFallbackNoted = true;
    console.error('using npx fallback: local Playwright CLI not resolved');
  }
  const r = spawnSync('npx', ['playwright', ...args], {
    ...opts,
    shell: process.platform === 'win32',
  });
  return {
    status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
    command: ['npx', 'playwright', ...args].join(' '),
    error: r.error,
  };
}

/**
 * The full story of a failed child run: the exact command, the spawn
 * error code or exit status, and the stderr tail. A bare "could not run"
 * with no cause is a forbidden message shape.
 */
export function describeFailedRun(run: PlaywrightRunResult): string {
  const cause = run.error
    ? `spawn failed: ${(run.error as NodeJS.ErrnoException).code ?? run.error.message}`
    : `exit status ${run.status}`;
  const tail = (run.stderr ?? '').trim().split('\n').slice(-5).join('\n').trim();
  return `command: ${run.command}; ${cause}${tail ? `; stderr tail:\n${tail}` : ''}`;
}
