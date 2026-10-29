import fs from 'node:fs';
import path from 'node:path';
import type { NeutralTestResult } from '../types.js';
import { classifyCypressFailure, cypressFrames, refusalForCypressStart } from './classify.js';

interface CypressTest {
  title?: string[];
  state?: string;
  displayError?: string | null;
  attempts?: unknown[];
}

interface CypressRun {
  failures?: number;
  message?: string;
  rejected?: boolean;
  runs?: Array<{ spec?: { relative?: string; absolute?: string }; tests?: CypressTest[] }>;
  config?: { includeShadowDom?: boolean; version?: string; baseUrl?: string | null };
}

export function readCypressResult(value: unknown): CypressRun | null {
  if (!value || typeof value !== 'object') return null;
  return value as CypressRun;
}

export function testsFromCypress(result: CypressRun, specPath: string, captureDir: string): NeutralTestResult[] {
  const out: NeutralTestResult[] = [];
  for (const run of result.runs ?? []) {
    const file = run.spec?.relative || run.spec?.absolute || specPath;
    for (const test of run.tests ?? []) {
      const titlePath = Array.isArray(test.title) ? test.title.map(String) : [];
      const title = titlePath[titlePath.length - 1] ?? '';
      const errorText = test.displayError ?? '';
      const frames = cypressFrames(errorText);
      const line = frames.frames[0]?.line ?? 0;
      const state = test.state === 'passed' ? 'passed' as const : 'failed' as const;
      out.push({
        titlePath,
        file,
        line,
        state,
        errorText,
        attempts: Array.isArray(test.attempts) && test.attempts.length > 0 ? test.attempts.length : 1,
        title,
        ok: state === 'passed',
        tracePath: null,
        locations: frames.frames.map((frame) => ({ file: frame.file, line: frame.line })),
        status: test.state ?? 'unknown',
        capturePath: captureFor(captureDir, titlePath.join(' ')),
      });
    }
  }
  return out;
}

function captureFor(dir: string, title: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const name = title.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'test';
  const file = path.join(dir, `${name}.json`);
  return fs.existsSync(file) ? file : null;
}

export function startFailure(result: CypressRun): { code: 'spec-not-found' | 'navigation-or-network' | 'timeout'; text: string } | null {
  if (result.runs && result.runs.length > 0) return null;
  return refusalForCypressStart(result.message ?? 'Cypress could not start.');
}

export { classifyCypressFailure };
