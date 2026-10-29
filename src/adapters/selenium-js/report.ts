import fs from 'node:fs';
import path from 'node:path';
import type { NeutralTestResult } from '../types.js';

/**
 * Mocha's JSON reporter writes `stats` and one entry per test with
 * `fullTitle`, `file`, and `err`. The exit code is the failure count, so
 * heal reads this file and ignores the exit code.
 * https://mochajs.org/#json
 */
export interface MochaTest {
  title?: string;
  fullTitle?: string;
  file?: string;
  err?: { message?: string; name?: string; stack?: string } | Record<string, never>;
}

export interface MochaReport {
  stats?: { tests?: number; failures?: number };
  tests?: MochaTest[];
  /** Mocha's JSON reporter stores failed tests and failed hooks here, not a count. */
  failures?: MochaTest[];
  message?: string;
}

export function readMochaReport(file: string): MochaReport | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as MochaReport;
  } catch {
    return null;
  }
}

/**
 * A `before` hook failure is not a test: Mocha leaves `tests` empty and
 * writes the error on `failures`. The first line is what heal should show.
 * https://mochajs.org/#json
 */
export function hookFailureText(report: MochaReport): string {
  const failures = Array.isArray(report.failures) ? report.failures : [];
  const lines = failures.map((test) => {
    const err = test.err ?? {};
    const message = 'message' in err ? String(err.message ?? '') : '';
    const stack = 'stack' in err ? String(err.stack ?? '').split('\n')[0] ?? '' : '';
    const detail = (message || stack).replace(/\s+/g, ' ').trim().slice(0, 500);
    const title = test.fullTitle || test.title || 'hook';
    return detail ? `${title}: ${detail}` : title;
  }).filter(Boolean);
  return lines.slice(0, 2).join(' | ');
}

export function testsFromMocha(report: MochaReport, specPath: string, captureDir: string): NeutralTestResult[] {
  return (report.tests ?? []).map((test) => {
    const title = test.title ?? '';
    const full = test.fullTitle ?? title;
    const titlePath = full.includes(' ') && title && full.endsWith(title)
      ? [...full.slice(0, full.length - title.length).trim().split(' ').filter(Boolean), title]
      : [title || full];
    const err = test.err ?? {};
    const message = 'message' in err ? String(err.message ?? '') : '';
    const stack = 'stack' in err ? String(err.stack ?? '') : '';
    const errorText = [message, stack].filter(Boolean).join('\n');
    const failed = message.length > 0 || ('name' in err && err.name);
    const line = frameLine(stack, test.file ?? specPath);
    return {
      titlePath,
      file: test.file ?? specPath,
      line,
      state: failed ? 'failed' as const : 'passed' as const,
      errorText,
      attempts: 1,
      title,
      ok: !failed,
      tracePath: null,
      locations: line > 0 ? [{ file: test.file ?? specPath, line }] : [],
      status: failed ? 'failed' : 'passed',
      capturePath: captureFile(captureDir),
    };
  });
}

function frameLine(stack: string, file: string): number {
  const base = path.basename(file);
  const match = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\d+`).exec(stack);
  return match ? Number(match[1]) : 0;
}

function captureFile(dir: string): string | null {
  const file = path.join(dir, 'capture.json');
  return fs.existsSync(file) ? file : null;
}
