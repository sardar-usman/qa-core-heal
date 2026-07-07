import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Demo flow:
 *   1. Run the suite with its deliberately broken locators (failures expected).
 *   2. Run the heal CLI in dry-run mode to show the proposed fixes.
 * Serves the static page locally, so no internet is needed.
 */
const exampleDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageDir = path.dirname(exampleDir);
const cliJs = path.join(packageDir, 'dist', 'cli.js');
if (!fs.existsSync(cliJs)) {
  console.error('dist/cli.js not found. Run "npm run build" first (or "npm run demo", which builds).');
  process.exit(1);
}

async function waitForServer(url) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('demo server did not start on 4173');
}

const server = spawn('node', [path.join(exampleDir, 'serve.mjs')], { stdio: 'ignore' });
try {
  await waitForServer('http://127.0.0.1:4173/');

  console.log('STEP 1: run the suite with its broken locators (failures expected)\n');
  const t = spawnSync('npx', ['playwright', 'test'], { cwd: exampleDir, stdio: 'inherit' });
  console.log(`\nplaywright exited with code ${t.status} (the failures are the point)\n`);

  console.log('STEP 2: heal in dry-run mode, proposed fixes only\n');
  const h = spawnSync('node', [cliJs, '--dry-run'], {
    cwd: exampleDir,
    stdio: 'inherit',
  });
  process.exitCode = h.status === 0 ? 0 : 1;
} finally {
  server.kill();
}
