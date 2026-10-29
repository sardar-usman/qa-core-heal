/**
 * Child process. It loads Cypress from the project and writes `cypress.run()`
 * to a file. Heal reads that file, not Cypress stdout.
 *
 * https://docs.cypress.io/app/references/module-api
 * https://docs.cypress.io/app/references/configuration
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

interface ChildSpec {
  projectRoot: string;
  spec: string;
  resultFile: string;
  screenshotsFolder: string;
  videosFolder: string;
  downloadsFolder: string;
  captureDir: string;
  supportFile?: string;
  browser?: string;
}

async function main(): Promise<void> {
  const spec = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as ChildSpec;
  const write = (value: unknown): void => {
    fs.mkdirSync(path.dirname(spec.resultFile), { recursive: true });
    fs.writeFileSync(spec.resultFile, JSON.stringify(value));
  };
  let cypress: { run: (opts: unknown) => Promise<unknown> };
  try {
    cypress = createRequire(path.join(spec.projectRoot, 'package.json'))('cypress') as { run: (opts: unknown) => Promise<unknown> };
  } catch (error) {
    write({
      failures: 1,
      message: `Could not load cypress from this project (${(error as Error).message}). Install cypress in the project and run npx cypress install.`,
    });
    return;
  }
  const config: Record<string, unknown> = {
    retries: 0,
    video: false,
    screenshotOnRunFailure: false,
    trashAssetsBeforeRuns: false,
    screenshotsFolder: spec.screenshotsFolder,
    videosFolder: spec.videosFolder,
    downloadsFolder: spec.downloadsFolder,
  };
  if (spec.supportFile) config.supportFile = spec.supportFile;
  try {
    const result = await cypress.run({
      project: spec.projectRoot,
      spec: spec.spec,
      testingType: 'e2e',
      quiet: true,
      config,
      expose: { qaCoreHealCapture: spec.captureDir },
      ...(spec.browser ? { browser: spec.browser } : {}),
    });
    write(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /binary is missing|Cypress executable not found/i.test(message)
      ? `${message} Run npx cypress install.`
      : message;
    write({ failures: 1, message: missing, rejected: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
