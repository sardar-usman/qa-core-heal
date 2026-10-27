import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromiumProfiles, installSuiteTmp, removeNewChromiumProfiles } from './helpers/temps.mjs';

const sharedTmp = os.tmpdir();

test('profile cleanup deletes only this suite and does not throw', () => {
  const suite = installSuiteTmp();
  const outside = path.join(sharedTmp, `playwright_chromiumdev_profile-other-${process.pid}`);
  const inside = path.join(suite, 'playwright_chromiumdev_profile-mine');
  fs.mkdirSync(path.join(outside, 'Default', 'Code Cache'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'Default', 'Code Cache', 'x'), '1');
  try {
    const before = chromiumProfiles();
    fs.mkdirSync(inside);
    assert.doesNotThrow(() => removeNewChromiumProfiles(before));
    assert.equal(fs.existsSync(inside), false);
    assert.equal(fs.existsSync(outside), true);
    assert.equal(chromiumProfiles().some((p) => !p.startsWith(suite)), false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
