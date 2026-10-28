import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { killProcessTree, setProcessTableReader } = await import(path.join(repoRoot, 'dist', 'process-guard.js'));

/**
 * The reader returns null, which is the stand-in for a host with no /proc.
 * The fallback must still kill the child group and a browser group under it,
 * and it must leave an unrelated process alone.
 */

const LEADER = `
const { spawn } = require('child_process');
const same = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
const own = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
process.stdout.write(JSON.stringify({ same: same.pid, own: own.pid }) + '\\n');
setInterval(() => {}, 1000);
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stop(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

test('without /proc the fallback kills the child group and descendant groups', async () => {
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  decoy.unref();
  const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const leader = spawn(process.execPath, ['-e', LEADER], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let kids = { same: 0, own: 0 };
  try {
    kids = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('leader did not report pids')), 5000);
      leader.stdout.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        resolve(JSON.parse(buf.slice(0, nl)));
      });
      leader.on('exit', () => {
        clearTimeout(timer);
        reject(new Error(`leader exited early: ${buf}`));
      });
    });
    setProcessTableReader(() => null);
    killProcessTree(leader.pid);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(leader.pid), false, 'leader');
    assert.equal(alive(kids.same), false, 'same-group worker');
    assert.equal(alive(kids.own), false, 'own-group browser');
    assert.equal(alive(decoy.pid), true, 'unrelated process group');
    assert.equal(alive(sibling.pid), true, 'sibling in this process group');
  } finally {
    setProcessTableReader(null);
    for (const pid of [leader.pid, kids.same, kids.own, decoy.pid, sibling.pid]) stop(pid);
  }
});
