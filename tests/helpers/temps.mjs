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

fs.mkdtempSync = function mkdtempSyncPatched(prefix, options) {
  const dir = orig.call(fs, prefix, options);
  const text = String(prefix);
  if (watched.some((p) => text.includes(p))) made.add(dir);
  return dir;
};

export function sweepTemps() {
  for (const dir of made) {
    fs.rmSync(dir, { recursive: true, force: true });
    made.delete(dir);
  }
}

export function chromiumProfiles() {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return []; }
  return names
    .filter((n) => n.startsWith('playwright_chromiumdev_profile-'))
    .map((n) => path.join(os.tmpdir(), n));
}

export function removeNewChromiumProfiles(before) {
  const known = new Set(before);
  for (const p of chromiumProfiles()) {
    if (!known.has(p)) fs.rmSync(p, { recursive: true, force: true });
  }
}

process.on('exit', sweepTemps);
