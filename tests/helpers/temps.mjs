import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Records temp folders the tests create and removes them on the way out.
 *
 * Prefixes: `.tmp-test-` (projects inside the repo) and `qa-core-heal-`
 * (counters and markers in the system temp folder). A stable peer-version
 * cache is created with mkdirSync, not mkdtempSync, so this sweep leaves it.
 */

const watched = ['.tmp-test-', 'qa-core-heal-'];
const made = new Set();
const orig = fs.mkdtempSync;
let suiteRoot = null;

/**
 * A private temp directory for this test process. Playwright children
 * inherit TMPDIR, so their browser profiles are not in the shared temp
 * folder and another suite cannot delete them.
 */
export function installSuiteTmp() {
  if (suiteRoot) return suiteRoot;
  const parent = os.tmpdir();
  suiteRoot = orig.call(fs, path.join(parent, 'qa-core-heal-suite-'));
  process.env.TMPDIR = suiteRoot;
  process.env.TMP = suiteRoot;
  process.env.TEMP = suiteRoot;
  made.add(suiteRoot);
  return suiteRoot;
}

fs.mkdtempSync = function mkdtempSyncPatched(prefix, options) {
  const dir = orig.call(fs, prefix, options);
  const text = String(prefix);
  if (watched.some((p) => text.includes(p))) made.add(dir);
  return dir;
};

export function sweepTemps() {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* already gone */ }
    made.delete(dir);
  }
}

export function chromiumProfiles() {
  const root = suiteRoot ?? os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names
    .filter((n) => n.startsWith('playwright_chromiumdev_profile-'))
    .map((n) => path.join(root, n));
}

export function removeNewChromiumProfiles(before) {
  if (!suiteRoot) return;
  const known = new Set(before);
  for (const p of chromiumProfiles()) {
    if (known.has(p)) continue;
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 }); } catch { /* live or already gone */ }
  }
}

process.on('exit', sweepTemps);
