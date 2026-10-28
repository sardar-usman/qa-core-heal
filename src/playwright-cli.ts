import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { killProcessTree, trackChildGroup, untrackChildGroup } from './process-guard.js';
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
  /** True when the child was stopped because it ran past timeoutMs. */
  timedOut?: boolean;
}

interface ChildSpec {
  command: string;
  args: string[];
  cwd: string;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  shell?: boolean;
}

/**
 * Run one child and wait for it. The child leads its own process group on
 * Unix so a timeout, or a SIGINT/SIGTERM delivered to heal, can stop the
 * workers and browsers together with the child. The wait is asynchronous
 * so those signals are delivered while the child is still running.
 */
function runChild(spec: ChildSpec): Promise<PlaywrightRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const pid = child.pid;
    if (pid && process.platform !== 'win32') trackChildGroup(pid);
    const stopGroup = (): void => {
      if (!pid || process.platform === 'win32') {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        return;
      }
      // The child group, and browser groups it started, are stopped together.
      killProcessTree(pid);
    };
    const take = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') stdout += text;
      else stderr += text;
      if (!overflow && (stdout.length > spec.maxBuffer || stderr.length > spec.maxBuffer)) {
        overflow = true;
        stopGroup();
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => take('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => take('stderr', chunk));
    const timer = spec.timeoutMs !== undefined
      ? setTimeout(() => { timedOut = true; stopGroup(); }, spec.timeoutMs)
      : undefined;
    const finish = (status: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pid) untrackChildGroup(pid);
      let err = error;
      if (overflow && !err) err = Object.assign(new Error('stdout maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      if (timedOut && !err) err = Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' });
      resolve({
        status, stdout, stderr,
        command: [spec.command, ...spec.args].join(' '),
        ...(err ? { error: err } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (status) => finish(status));
  });
}

export function runPlaywrightCli(
  root: string,
  args: string[],
  maxBuffer: number,
  env?: NodeJS.ProcessEnv,
  /** Optional wall-clock limit for the child. Unset means no limit, as before. */
  timeoutMs?: number,
): Promise<PlaywrightRunResult> {
  const base = { cwd: root, maxBuffer, env, timeoutMs };
  let cliJs: string | null = null;
  try {
    cliJs = createRequire(path.join(root, 'package.json')).resolve('@playwright/test/cli');
  } catch { /* not installed under this root; npx may still find it */ }
  if (cliJs) return runChild({ ...base, command: process.execPath, args: [cliJs, ...args] });
  // The weaker, PATH-dependent path is in use. Say so exactly once. The
  // direct local-CLI path above must never print this.
  if (!npxFallbackNoted) {
    npxFallbackNoted = true;
    console.error('using npx fallback: local Playwright CLI not resolved');
  }
  return runChild({
    ...base,
    command: 'npx',
    args: ['playwright', ...args],
    shell: process.platform === 'win32',
  });
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
