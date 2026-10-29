import fs from 'node:fs';
import path from 'node:path';
import { FRAMEWORK_IDS, type DetectHit, type FrameworkId } from './types.js';
import { enabledAdapters, getAdapter, registeredAdapters, useAdapter } from './index.js';
import { seleniumRunnerBlock } from './selenium-js/index.js';

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
  | { ok: true; id: FrameworkId; reason: string }
  | { ok: false; message: string };

function supportedNow(): string {
  const enabled = enabledAdapters().map((adapter) => adapter.id);
  return enabled.length > 0 ? enabled.join(', ') : 'playwright-js';
}

function plannedIds(): string {
  const enabled = new Set(enabledAdapters().map((adapter) => adapter.id));
  return FRAMEWORK_IDS.filter((id) => !enabled.has(id)).join(', ');
}
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

function runnable(id: FrameworkId): boolean {
  const adapter = getAdapter(id);
  return adapter != null && adapter.enabled;
}

function hitsFromRoot(root: string): DetectHit[] {
  const hits: DetectHit[] = [];
  for (const adapter of registeredAdapters()) {
    const hit = adapter.detect(root);
    if (hit) hits.push(hit);
  }
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
      if (!getAdapter('selenium-js') && (pkg.dependencies?.['selenium-webdriver'] != null || pkg.devDependencies?.['selenium-webdriver'] != null)) {
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
  if (runnable(only.id)) return { ok: true, id: only.id, reason: only.reason };
  return { ok: false, message: planned(only.id) };
}

/**
 * Choose the adapter for this command. On success the active adapter is
 * the enabled framework detection chose. On failure nothing is selected
 * and nothing is run.
 */
export function detectFramework(input: { root: string; flag?: string; configPath?: string | null }): Detection {
  if (input.flag !== undefined) {
    const flag = input.flag.trim();
    if (!FRAMEWORK_IDS.includes(flag as FrameworkId)) {
      return { ok: false, message: `Unknown framework "${flag}". Supported now: ${supportedNow()}. Planned: ${plannedIds()}.` };
    }
    const id = flag as FrameworkId;
    if (id === 'selenium-js') {
      const blocked = seleniumRunnerBlock(input.root);
      if (blocked) return { ok: false, message: blocked };
    }
    if (!runnable(id)) return { ok: false, message: planned(id) };
    useAdapter(id);
    return { ok: true, id, reason: 'flag' };
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
  if (decision.ok && decision.reason === 'fallback') {
    const blocked = seleniumRunnerBlock(input.root);
    if (blocked) return { ok: false, message: blocked };
  }
  if (decision.ok) useAdapter(decision.id);
  return decision;
}
