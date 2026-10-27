import fs from 'node:fs';
import path from 'node:path';

/** Nearest directory at or above the spec that holds a package.json. */
export function projectRootFor(specPath: string): string {
  let dir = path.dirname(specPath);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(specPath);
    dir = parent;
  }
}
