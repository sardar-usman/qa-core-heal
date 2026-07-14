import fs from 'node:fs';
import path from 'node:path';

export interface QaCoreHealConfig {
  baseUrl?: string;
  testDir?: string;
  selectorPreference?: string[];
  pageObjects?: { enabled?: boolean; dir?: string };
  auth?: { storageState?: string };
  /** "file#exportName" of a login function run before probing. */
  authSetup?: string;
  heal?: { dryRunByDefault?: boolean; maxHealsPerRun?: number; verifyAfterApply?: boolean };
  audit?: { logPath?: string };
}

export interface LoadedConfig { config: QaCoreHealConfig; dir: string; path: string }

/**
 * Load qa-core.config.json from the explicit path, else the working directory.
 * Absent file with no explicit path means flag-only behavior, so return null.
 * Relative paths inside the config resolve against the config file's directory.
 */
export function loadConfig(explicitPath?: string): LoadedConfig | null {
  const p = explicitPath ? path.resolve(explicitPath) : path.resolve('qa-core.config.json');
  if (!fs.existsSync(p)) {
    if (explicitPath) throw new Error(`Config file not found: ${p}`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${p}: ${(e as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${p} must contain a single JSON object.`);
  }
  return { config: parsed as QaCoreHealConfig, dir: path.dirname(p), path: p };
}
