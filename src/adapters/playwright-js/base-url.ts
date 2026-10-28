import path from 'node:path';
import { resolvePlaywrightConfig } from './config.js';

/**
 * The base URL the spec targets, in priority order:
 *   1. an explicit override (--base-url flag or qa-core.config.json baseUrl)
 *   2. use.baseURL from the project's own playwright.config.ts/.js, actually
 *      imported (defineConfig and env vars evaluate; no text scraping)
 *   3. the first absolute URL in a page.goto() call in the scanned files
 *   4. an absolute page-object `url` property
 * Only when all of these fail does the CLI ask for --base-url.
 */
export async function resolveBaseUrl(
  files: Array<{ src: string }>,
  roots: string[],
  baseUrl: string | undefined,
  project?: string,
  playwrightConfig?: string,
): Promise<{ url: string | null; configStorageState: string | null }> {
  let configStorageState: string | null = null;
  let url: string | null = baseUrl ?? null;
  const consider = async (dir: string, explicit?: string): Promise<void> => {
    if (url && configStorageState) return;
    const res = await resolvePlaywrightConfig(dir, project, explicit);
    if (!res) return;
    if (!configStorageState && res.storageState) configStorageState = res.storageState;
    if (url) return;
    if (res.baseUrl) { url = res.baseUrl; return; }
    const name = path.basename(res.configPath);
    if (res.loadError) {
      console.error(`${name} failed to load (${res.loadError}); falling back to goto() scan / --base-url — probing quality is reduced without the config (routes, baseURL, and storage state may be missing)`);
    } else if (res.disagreement) {
      const list = res.disagreement.map((p) => `${p.name}: ${p.baseURL}`).join(', ');
      console.error(`${name} defines projects with different baseURLs (${list}); pass --project <name> or --base-url`);
    }
  };
  if (playwrightConfig) await consider(path.dirname(playwrightConfig), playwrightConfig);
  for (const root of roots) {
    await consider(root);
  }
  if (!url) {
    for (const f of files) {
      const g = f.src.match(/\.goto\(\s*["'`](https?:\/\/[^"'`]+)["'`]/);
      if (g) { url = g[1]!; break; }
    }
  }
  if (!url) {
    for (const f of files) {
      const u = f.src.match(/\burl\s*[:=]\s*["'`](https?:\/\/[^"'`]+)["'`]/);
      if (u) { url = u[1]!; break; }
    }
  }
  return { url, configStorageState };
}
