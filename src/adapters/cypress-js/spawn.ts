import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree, trackOutputDir, untrackChildGroup, watchChildGroup } from '../../process-guard.js';
import type { ChildRun } from '../types.js';
import { attachCapture } from './capture.js';
import { injectOnly } from './select.js';

export interface CypressSpawnRequest {
  projectRoot: string;
  specPath: string;
  title?: string | null;
  line?: number;
  browser?: string;
  timeoutMs?: number | (() => number | undefined);
  observe?: (run: ChildRun) => void;
}

export interface CypressSpawnResult {
  run: ChildRun;
  result: unknown;
  captureDir: string;
  timedOut: boolean;
}

function sampleTimeout(timeoutMs?: number | (() => number | undefined)): number | undefined {
  if (timeoutMs === undefined) return undefined;
  const value = typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value <= 0 ? 0 : value;
}

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  const skip = new Set(['node_modules', '.git', '.qa-core', 'screenshots', 'videos', 'downloads']);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function readConfigText(root: string): string | null {
  for (const name of ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs', 'cypress.config.cjs']) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  return null;
}

export async function runCypressInScratch(request: CypressSpawnRequest): Promise<CypressSpawnResult> {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-out-'));
  trackOutputDir(outRoot);
  fs.mkdirSync(path.join(request.projectRoot, '.qa-core'), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(request.projectRoot, '.qa-core', 'scratch-'));
  const captureDir = path.join(outRoot, 'capture');
  fs.mkdirSync(captureDir, { recursive: true });
  for (const name of ['screenshots', 'videos', 'downloads']) fs.mkdirSync(path.join(outRoot, name), { recursive: true });
  const empty = (message: string, timedOut = false): CypressSpawnResult => ({
    run: { status: null, stdout: '', stderr: message, command: 'cypress.run', ...(timedOut ? { timedOut: true } : {}) },
    result: { failures: 1, message },
    captureDir,
    timedOut,
  });
  try {
    copyTree(request.projectRoot, scratch);
    const rel = path.relative(request.projectRoot, request.specPath);
    const scratchSpec = path.join(scratch, rel);
    if (request.title && request.line && request.line > 0 && fs.existsSync(scratchSpec)) {
      const edited = injectOnly(fs.readFileSync(scratchSpec, 'utf8'), request.title, request.line);
      if (edited.injected) fs.writeFileSync(scratchSpec, edited.source);
    }
    const support = attachCapture(scratch, readConfigText(scratch));
    const specFile = path.join(outRoot, 'child-spec.json');
    const resultFile = path.join(outRoot, 'result.json');
    const childSpec = {
      projectRoot: scratch,
      spec: scratchSpec,
      resultFile,
      screenshotsFolder: path.join(outRoot, 'screenshots'),
      videosFolder: path.join(outRoot, 'videos'),
      downloadsFolder: path.join(outRoot, 'downloads'),
      captureDir,
      ...(support.supportFile ? { supportFile: support.supportFile } : {}),
      ...(request.browser ? { browser: request.browser } : {}),
    };
    fs.writeFileSync(specFile, JSON.stringify(childSpec));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = path.join(here, 'run-child.js');
    const run = await spawnChild(process.execPath, [script, specFile], scratch, sampleTimeout(request.timeoutMs));
    request.observe?.(run);
    let result: unknown = null;
    if (fs.existsSync(resultFile)) {
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as unknown; } catch { result = null; }
    }
    return { run, result, captureDir, timedOut: run.timedOut === true };
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function spawnChild(command: string, args: string[], cwd: string, timeoutMs: number | undefined): Promise<ChildRun> {
  const shown = [command, ...args].join(' ');
  if (timeoutMs === 0) {
    return Promise.resolve({
      status: null, stdout: '', stderr: '', command: shown, timedOut: true,
      error: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const pid = child.pid;
    watchChildGroup(child);
    const stop = (): void => {
      if (!pid || process.platform === 'win32') {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        return;
      }
      killProcessTree(pid);
    };
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = timeoutMs !== undefined ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : undefined;
    const finish = (status: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pid) untrackChildGroup(pid);
      resolve({
        status, stdout, stderr, command: shown,
        ...(error ? { error } : {}),
        ...(timedOut ? { timedOut: true, error: error ?? Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }) } : {}),
      });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (status) => finish(status));
  });
}
