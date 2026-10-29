import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { killProcessTree, trackOutputDir, untrackChildGroup, watchChildGroup } from '../../process-guard.js';
import { escapeRegex } from '../../selectors.js';
import type { ChildRun } from '../types.js';
import { grepPatternFor } from './list-tests.js';
import { hasRemoteSession } from './parse.js';
import { readMochaReport, type MochaReport } from './report.js';
import { MOCHA_MIN, SELENIUM_MIN, mochaVersion, seleniumVersion, versionAtLeast } from './version.js';

/**
 * Run the project's Mocha in its own process group.
 * A positional spec is merged with a `.mocharc` spec list, so the grep is
 * anchored and the report is checked for exactly one test in the target file.
 * https://mochajs.org/#command-line-usage
 * https://mochajs.org/#configuring-mocha-nodejs
 */

export interface SeleniumSpawnRequest {
  projectRoot: string;
  specPath: string;
  titlePath?: string[];
  title?: string | null;
  /** 1-based line of the `it` call, used to build Mocha's full title. */
  line?: number;
  timeoutMs?: number | (() => number | undefined);
  observe?: (run: ChildRun) => void;
  /** Dry run: the scratch copy stays in the system temp directory. */
  preview?: boolean;
}

export interface SeleniumSpawnResult {
  run: ChildRun;
  report: MochaReport | null;
  captureDir: string;
  timedOut: boolean;
  failureDetail: string;
}

const HOOK = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const dir = process.env.QA_CORE_HEAL_CAPTURE;
const root = process.env.QA_CORE_HEAL_PROJECT;
if (dir && root) {
  try {
    const { WebDriver } = createRequire(path.join(root, 'package.json'))('selenium-webdriver');
    const record = async (driver) => {
      const url = await driver.getCurrentUrl();
      const html = await driver.getPageSource();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ url, html }));
    };
    const origFind = WebDriver.prototype.findElement;
    WebDriver.prototype.findElement = function (...args) {
      const result = origFind.apply(this, args);
      const driver = this;
      if (result && typeof result.then === 'function') {
        const origThen = result.then.bind(result);
        result.then = function (ok, fail) {
          return origThen(ok, async (err) => {
            try { await record(driver); } catch { /* keep the original error */ }
            if (typeof fail === 'function') return fail(err);
            throw err;
          });
        };
        result.catch = function (fail) { return result.then(undefined, fail); };
      }
      return result;
    };
    const origWait = WebDriver.prototype.wait;
    WebDriver.prototype.wait = function (...args) {
      const result = origWait.apply(this, args);
      const driver = this;
      return Promise.resolve(result).catch(async (err) => {
        try { await record(driver); } catch { /* keep the original error */ }
        throw err;
      });
    };
  } catch { /* the project has no selenium-webdriver; Mocha still runs */ }
}
`;

function sampleTimeout(timeoutMs?: number | (() => number | undefined)): number | undefined {
  if (timeoutMs === undefined) return undefined;
  const value = typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value <= 0 ? 0 : value;
}

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  const skip = new Set(['node_modules', '.git', '.qa-core']);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function grepFor(source: string, titlePath: string[] | undefined, title: string | null | undefined, line?: number): string | null {
  const parsed = grepPatternFor(source, title, line);
  if (parsed) return parsed;
  const parts = (titlePath ?? []).filter((part) => part.length > 0);
  const text = parts.length > 0 ? parts.join(' ') : (title ?? '');
  if (!text) return null;
  // A one-part path may be only the test title. A suffix still matches Mocha's full title.
  // https://mochajs.org/#-grep-regexp-g-regexp
  return parts.length > 1 ? `^${escapeRegex(text)}$` : `${escapeRegex(text)}$`;
}

function sameFile(reported: string, expected: string, cwd: string): boolean {
  const abs = path.isAbsolute(reported) ? reported : path.resolve(cwd, reported);
  try {
    return fs.realpathSync(abs) === fs.realpathSync(expected);
  } catch {
    return path.basename(reported) === path.basename(expected);
  }
}

export async function runSeleniumInScratch(request: SeleniumSpawnRequest): Promise<SeleniumSpawnResult> {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-heal-out-'));
  trackOutputDir(outRoot);
  const captureDir = path.join(outRoot, 'capture');
  fs.mkdirSync(captureDir, { recursive: true });
  const empty = (message: string, timedOut = false): SeleniumSpawnResult => ({
    run: { status: 1, stdout: '', stderr: message, command: 'mocha', ...(timedOut ? { timedOut: true } : {}) },
    report: null,
    captureDir,
    timedOut,
    failureDetail: message,
  });
  const specText = fs.existsSync(request.specPath) ? fs.readFileSync(request.specPath, 'utf8') : '';
  if (process.env.SELENIUM_REMOTE_URL || hasRemoteSession(specText)) {
    return empty('Remote Selenium sessions are not supported. Nothing was run.');
  }
  const selenium = seleniumVersion(request.projectRoot);
  const mocha = mochaVersion(request.projectRoot);
  if (!selenium || !mocha) {
    return empty('selenium-webdriver and mocha must be installed in this project. Nothing was run.');
  }
  if (!versionAtLeast(selenium, SELENIUM_MIN)) {
    return empty(`selenium-webdriver ${selenium} is older than ${SELENIUM_MIN}, which this heal needs. Nothing was run.`);
  }
  if (!versionAtLeast(mocha, MOCHA_MIN)) {
    return empty(`Mocha ${mocha} is older than ${MOCHA_MIN}, which this heal needs. Nothing was run.`);
  }
  // The scratch stays inside the project so Node can see hoisted packages in a
  // parent node_modules. A dry run still removes the folder when heal created it.
  const qaCore = path.join(request.projectRoot, '.qa-core');
  const createdQaCore = !fs.existsSync(qaCore);
  fs.mkdirSync(qaCore, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(qaCore, 'scratch-'));
  trackOutputDir(scratch);
  try {
    copyTree(request.projectRoot, scratch);
    const modules = path.join(request.projectRoot, 'node_modules');
    const link = path.join(scratch, 'node_modules');
    if (fs.existsSync(modules) && !fs.existsSync(link)) fs.symlinkSync(modules, link);
    const rel = path.relative(request.projectRoot, request.specPath);
    const specArg = rel.split(path.sep).join('/');
    const scratchSpec = path.join(scratch, rel);
    let mochaBin: string;
    try {
      mochaBin = createRequire(path.join(request.projectRoot, 'package.json')).resolve('mocha/bin/mocha.js');
    } catch {
      return empty('Mocha is not installed in this project. Nothing was run.');
    }
    const resultFile = path.join(outRoot, 'mocha.json');
    const hook = path.join(outRoot, 'capture-hook.cjs');
    fs.writeFileSync(hook, HOOK);
    // Positional path is relative to the scratch cwd. An absolute path is merged
    // with `.mocharc` `spec` and can miss the file when it sits under a dot directory.
    // https://mochajs.org/#configuring-mocha-nodejs
    const args = [mochaBin, specArg, '--reporter', 'json', '--reporter-option', `output=${resultFile}`, '--retries', '0', '--require', hook];
    const specSource = fs.existsSync(scratchSpec) ? fs.readFileSync(scratchSpec, 'utf8') : specText;
    const grep = grepFor(specSource, request.titlePath, request.title, request.line);
    if (grep) args.push('--grep', grep);
    const childEnv: NodeJS.ProcessEnv = { ...process.env, QA_CORE_HEAL_CAPTURE: captureDir, QA_CORE_HEAL_PROJECT: request.projectRoot };
    delete childEnv.MOCHA_OPTIONS;
    const run = await spawnChild(process.execPath, args, scratch, sampleTimeout(request.timeoutMs), childEnv);
    request.observe?.(run);
    if (run.timedOut) return { run, report: null, captureDir, timedOut: true, failureDetail: 'The Mocha run timed out.' };
    const report = readMochaReport(resultFile);
    if (!report) return { run, report: null, captureDir, timedOut: false, failureDetail: run.stderr || 'Mocha did not write a JSON report.' };
    const tests = report.tests ?? [];
    if (grep && tests.length !== 1) {
      const note = `${run.stderr ?? ''}\n${run.stdout ?? ''}`.trim().split('\n').slice(-12).join('\n').slice(0, 800);
      const stats = report.stats?.tests;
      const seen = tests.map((test) => test.fullTitle ?? test.title ?? '').filter(Boolean).slice(0, 5).join('; ');
      return {
        run, report, captureDir, timedOut: false,
        failureDetail: `The Mocha run reported ${tests.length} tests, but exactly one was expected. grep ${grep}. spec ${specArg}.${stats !== undefined ? ` stats.tests=${stats}.` : ''}${seen ? ` titles ${seen}.` : ''}${note ? ` ${note}` : ''}`,
      };
    }
    if (grep && tests[0] && !sameFile(tests[0].file ?? scratchSpec, scratchSpec, scratch)) {
      return { run, report, captureDir, timedOut: false, failureDetail: 'The Mocha run reported a test from a different file. Nothing was changed.' };
    }
    return { run, report, captureDir, timedOut: false, failureDetail: '' };
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    if (createdQaCore) {
      try {
        if (fs.readdirSync(qaCore).length === 0) fs.rmdirSync(qaCore);
      } catch { /* a folder heal did not create stays */ }
    }
  }
}

function spawnChild(command: string, args: string[], cwd: string, timeoutMs: number | undefined, env: NodeJS.ProcessEnv): Promise<ChildRun> {
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
      env,
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
