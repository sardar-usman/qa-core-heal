import fs from 'node:fs';
import path from 'node:path';
import { findPlaywrightConfig } from './playwright-js/config.js';
import { FRAMEWORK_IDS, type DetectHit, type FrameworkId } from './types.js';
import { useAdapter } from './index.js';

/**
 * Framework detection. It reads files only. It never runs a framework,
 * a package manager, or Python.
 *
 * Order:
 *   1. The --framework flag, which overrides every other signal.
 *   2. project.configPath in a findings file, when the name is recognised.
 *   3. Marker files in the project root.
 * When nothing matches, the command uses playwright-js and says nothing.
 */

export type Detection =
  | { ok: true; id: 'playwright-js'; reason: string }
  | { ok: false; message: string };

const ACCEPTED = FRAMEWORK_IDS.join(', ');
const PYTHON_CONFIGS = new Set(['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py']);
const CYPRESS_CONFIGS = ['cypress.config.ts', 'cypress.config.js', 'cypress.config.mjs', 'cypress.config.cjs'];
const PYTHON_PROJECT_FILES = ['pytest.ini', 'pyproject.toml', 'conftest.py'];

function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function importsModule(text: string, name: string): boolean {
  return new RegExp(`(?:^|\\n)\\s*(?:import|from)\\s+${name}\\b`).test(text);
}

function planned(id: FrameworkId): string {
  return `${id} is planned and is not supported yet. Nothing was run.`;
}

function pythonUnspecified(label: string): string {
  return `A Python config was found (${label}). playwright-py and selenium-py are planned and are not supported yet. Nothing was run.`;
}

function twoMatch(hits: DetectHit[]): string {
  const list = hits.map((h) => `${h.id} (${h.reason})`).join(', ');
  return `More than one framework was found: ${list}. Pass --framework to choose one. Nothing was run.`;
}

function dedupe(hits: DetectHit[]): DetectHit[] {
  const seen = new Set<FrameworkId>();
  const out: DetectHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(hit);
  }
  return out;
}

function pythonHits(file: string, label: string): DetectHit[] | 'unspecified' {
  const text = readText(file);
  const hits: DetectHit[] = [];
  if (text && importsModule(text, 'playwright')) hits.push({ id: 'playwright-py', reason: label });
  if (text && importsModule(text, 'selenium')) hits.push({ id: 'selenium-py', reason: label });
  if (hits.length > 0) return hits;
  return 'unspecified';
}

/** Frameworks named by a findings project.configPath. Empty when the name is not a known config. */
function hitsFromConfigPath(configPath: string, root: string): DetectHit[] | 'unspecified' | null {
  const base = path.basename(configPath);
  if (/^playwright\.config\./.test(base)) {
    return [{ id: 'playwright-js', reason: `project.configPath ${configPath}` }];
  }
  if (/^cypress\.config\./.test(base)) {
    return [{ id: 'cypress-js', reason: `project.configPath ${configPath}` }];
  }
  if (PYTHON_CONFIGS.has(base)) {
    return pythonHits(path.resolve(root, configPath), `project.configPath ${configPath}`);
  }
  return null;
}

function hitsFromRoot(root: string): DetectHit[] {
  const hits: DetectHit[] = [];
  const playwright = findPlaywrightConfig(root);
  if (playwright) hits.push({ id: 'playwright-js', reason: path.basename(playwright) });
  for (const name of CYPRESS_CONFIGS) {
    if (isFile(path.join(root, name))) {
      hits.push({ id: 'cypress-js', reason: name });
      break;
    }
  }
  const pkgText = readText(path.join(root, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      if (pkg.dependencies?.['selenium-webdriver'] != null || pkg.devDependencies?.['selenium-webdriver'] != null) {
        hits.push({ id: 'selenium-js', reason: 'package.json' });
      }
    } catch { /* a package.json that is not JSON is not a Selenium marker */ }
  }
  for (const name of PYTHON_PROJECT_FILES) {
    const file = path.join(root, name);
    if (!isFile(file)) continue;
    const text = readText(file);
    if (!text) continue;
    if (importsModule(text, 'playwright')) hits.push({ id: 'playwright-py', reason: name });
    if (importsModule(text, 'selenium')) hits.push({ id: 'selenium-py', reason: name });
  }
  return dedupe(hits);
}

function decide(hits: DetectHit[]): Detection {
  if (hits.length === 0) return { ok: true, id: 'playwright-js', reason: 'fallback' };
  if (hits.length > 1) return { ok: false, message: twoMatch(hits) };
  const only = hits[0]!;
  if (only.id === 'playwright-js') return { ok: true, id: 'playwright-js', reason: only.reason };
  return { ok: false, message: planned(only.id) };
}

/**
 * Choose the adapter for this command. On success the registry's active
 * adapter is playwright-js. On failure nothing is selected and nothing is run.
 */
export function detectFramework(input: { root: string; flag?: string; configPath?: string | null }): Detection {
  const flag = input.flag?.trim();
  if (flag) {
    if (!FRAMEWORK_IDS.includes(flag as FrameworkId)) {
      return { ok: false, message: `Unknown framework "${flag}". Accepted values: ${ACCEPTED}.` };
    }
    const id = flag as FrameworkId;
    if (id !== 'playwright-js') return { ok: false, message: planned(id) };
    useAdapter('playwright-js');
    return { ok: true, id: 'playwright-js', reason: 'flag' };
  }
  if (input.configPath) {
    const fromConfig = hitsFromConfigPath(input.configPath, input.root);
    if (fromConfig === 'unspecified') {
      return { ok: false, message: pythonUnspecified(path.basename(input.configPath)) };
    }
    if (fromConfig) {
      const decision = decide(dedupe(fromConfig));
      if (decision.ok) useAdapter(decision.id);
      return decision;
    }
  }
  const decision = decide(hitsFromRoot(input.root));
  if (decision.ok) useAdapter(decision.id);
  return decision;
}
