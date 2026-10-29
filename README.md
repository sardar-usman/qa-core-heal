# qa-core-heal

qa-core-heal runs your failing Playwright tests, reads the failure evidence, and repairs broken locators. It refuses to guess: every heal is verified against the live page and re-tested, every refusal explains itself.

```text
$ npx qa-core-heal tests/quantity.spec.ts

▸ Running tests/quantity.spec.ts to find failures
  1 of 1 test(s) failing

  → sets the quantity — locator failure: locator('#quantiy')  (page: http://127.0.0.1:4188/)

Proposed heals (1):

  tests/quantity.spec.ts:6
    - page.locator('#quantiy')
    + page.getByRole("textbox", {"name":"quantity"})

Apply 1 heal(s)? [y/N] y
▸ Verifying: re-running 1 previously failing test(s)
  ✓ re-run passed
```

No LLM, no API key. The engine is deterministic: same page, same broken locator, same replacement, every time.

## Quick Start

```sh
npm i -D qa-core-heal
npx playwright install chromium   # once, if you don't already have it
npx qa-core-heal tests/login.spec.ts
```

Zero config. The CLI runs the spec with Playwright first; if everything passes it prints `All tests passing. Nothing to heal.` and exits, with no scanning, no probing, and no browser. On failures, this is the full shape of a run:

```text
▸ Running tests/login.spec.ts to find failures
  1 of 1 test(s) failing

  → sets the quantity — locator failure: locator('#quantiy')  (page: http://127.0.0.1:4188/)

▸ Probing 1 failing locator(s) on their failure page(s)
  · opened http://127.0.0.1:4188/

  tests/login.spec.ts:
    → broken: page.locator('#quantiy')
    ✓ healed to page.getByRole("textbox", {"name":"quantity"})  (level=role)

Proposed heals (1):

  tests/login.spec.ts:6
    - page.locator('#quantiy')
    + page.getByRole("textbox", {"name":"quantity"})

Apply 1 heal(s)? [y/N] y
▸ Applying heals
▸ Verifying: re-running 1 previously failing test(s)
  ✓ re-run passed
▸ Audit log: 1 entry appended to .qa-core/heal-log.jsonl
Done. 0 intact · 1 healed · 0 refused (1 failing locator(s) probed).
```

Run → classify → probe → propose → apply → re-run → audit. Only the previously failing tests are re-run to verify, and every applied heal lands in `.qa-core/heal-log.jsonl` with a verified flag. Failures that are not locator problems are never healed:

```text
  ✗ shows the done status — not a locator problem, healing won't fix this
      Error: expect(locator).toHaveText(expected) failed
```

The page each test was on when it failed comes from the Playwright trace, so a locator that breaks three clicks deep heals on the page it actually broke on, not on your homepage. Base URL, routes, and page objects (imports followed recursively) are all resolved from your project as-is: your `playwright.config.ts` is imported the way Playwright imports it, `defineConfig`, env vars, `require("dotenv")` and all.

## Authenticated Apps

An unauthenticated probe of a protected page gets redirected to your login screen. qa-core-heal detects that instead of probing the wrong page:

```text
requested /accounts, landed on /login (redirected)
the page may require authentication; pass --storage-state <path>
```

Three ways up the ladder:

**1. Point it at the login function your tests already use (recommended).**

```sh
npx qa-core-heal tests/accounts.spec.ts --auth-setup "utils/common.ts#login"
```

(The quotes matter in zsh, because `#` starts a comment otherwise.) The module loads with the same TypeScript machinery as your config, and `await login(page)` runs on a fresh page in the probing context, with your project's baseURL set, so relative `page.goto("/")` works exactly as in your tests. One login, many probes: the session lives in the probing context for the whole run. For every run, put it in `qa-core.config.json`:

```json
{ "authSetup": "utils/common.ts#login" }
```

A login that throws or hangs (60s default, `--auth-setup-timeout <seconds>`) fails the whole run loudly with `auth setup utils/common.ts#login failed: <error>`, never a silent unauthenticated probe. It deliberately does NOT parse or re-run your `beforeAll`/`beforeEach` hooks: setup code can seed data or trigger side effects, and only you can say what is safe to re-run.

**2. Saved sessions: `--storage-state <path>`.**

Playwright's storage-state file (or `auth.storageState` in qa-core.config.json). This is the right fit for CI and the standard save-auth pattern: a setup script that logs in once and writes `context.storageState({ path: '.auth/state.json' })`. With neither flag set, heal auto-detects: `use.storageState` from your playwright config, then `.auth/state.json` / `playwright/.auth/user.json` if present, announcing `using storage state from <path>`. Detection finding nothing just probes unauthenticated. When both are configured, the saved session is used first (it is fast and runs no user code), and an expired session automatically falls back to your login function (`saved session expired; falling back to auth setup`), never the reverse. Without an auth setup configured, an expired session is diagnosed, not papered over:

```text
storage state was applied but /accounts still redirected to /login; the saved
session may be expired. Re-generate it and retry.
```

And when `--auth-setup` ran but the redirect still happens: `auth setup ran but /accounts still redirected to /login; the login function may have failed silently or the session did not persist`.

**A login page at /.** SauceDemo's login page is the site root (`/`). Heal treats a redirect to `/` the same way it treats a redirect to `/login`, and it prints `the page may require authentication; pass --storage-state <path>`. A SauceDemo session lasts only a short time, so save a fresh login to `.auth/state.json` before the heal run. Heal auto-detects that file. Keep the session out of git (`.auth/` is already in `.gitignore`).

**3. Security.**

> The tool never reads or stores credentials. It executes only the login code you explicitly name, and nothing else in your setup files. Sessions stay in memory for the duration of the run. Logs and audit entries carry file paths, export names, and pass/fail results, never credentials, cookie values, or storage-state contents. Keep session files out of version control: add `.auth/` to your `.gitignore`.

## How It Decides

**Failure classification is evidence-based.** A failure is a locator problem only when the evidence says so: a `locator.<action>:` / `expect.<matcher>:` prefix, a call-log `waiting for locator(...)` line, an `element(s) not found`, a strict mode violation. The evidence can be anywhere in the error, even when the top-level message is a test timeout or "Target page, context or browser has been closed". A count/existence assertion (`toHaveCount`, `toBeVisible`, `toBeAttached`, `toBeInViewport`) that failed with ZERO elements found is locator evidence too: nothing matched, which is the definition of a broken locator. A locator that RESOLVED to one or more real elements whose value or count merely mismatched is an app problem: `not a locator problem, healing won't fix this` (`toHaveCount(1)` finding 2 is a wrong count, not a wrong selector). A click timeout whose target resolved but where another element `intercepts pointer events` gets the UX-defect verdict, and the interceptor is named from the call log, because an overlay eating clicks may be blocking real users too. Navigation errors, thrown app errors, and timeouts with no pending locator action are reported, never healed.

**The heal ladder.** Broken locators re-resolve by semantic intent through Playwright's own preference order: role with accessible name, label, placeholder, text, alt, title, testid, then CSS/XPath, with a fuzzy stage below all of that for typo'd identifiers (`#Emai_l` → `#Email`, a `getByRole` name `"Ema_il_2"` → `"Email"`), scored by edit distance and whole-word token containment (a name mutation "search1" matches the field whose accessible name contains "search" as a word), and only accepted when exactly one candidate clears the bar.

**Shadow DOM.** Candidate collection recurses into every open shadow root (nested roots included), gathering the same identity evidence as light DOM. Playwright locators pierce open roots natively, and the healer sees what the locators see. A locator whose target moved into an open shadow root heals like any other. Closed shadow roots are inaccessible to Playwright and to the probe alike; when a page contains them and nothing matched, the refusal says so: `this page contains closed shadow roots the probe cannot inspect`.

**Compound CSS selectors.** A selector like `.btn.btn-primary` names styling, not identity, so compound selectors stay excluded from intent and fuzzy matching; their refusals say why and point at `getByRole` / `data-testid`. The one recoverable case is a tag-token typo: when the leading tag of a compound selector is not a valid HTML/SVG element name (`buttons.btn.btn-primary`), corrections one edit away from a real tag are probed, and if exactly one correction resolves to exactly one element (and passes the kind guard), the heal is the corrected compound selector itself (`page.locator("button.btn.btn-primary")`, level `css-tag-fix`), never a reinvented locator. Two matches, zero matches, or a valid tag still refuse.

**The kind guard.** The original selector says what KIND of element it meant: `#register-button` is a button, a `.fill()` target is a text input. A candidate of a conflicting kind is refused, however well the name matched:

```text
kind mismatch: expected button, candidate is link
```

The one exception: a `getByRole` with `exact: true` that re-resolves to an element carrying the IDENTICAL exact name under a different role. There the exact accessible name is the identity and the role is the broken part, so the role is corrected (link → button) instead of vetoed.

**Ambiguity refuses, with names, but exact identity wins real ties.** Nothing is ever picked from a set:

```text
ambiguous on route /: several close matches (#contact-email, #backup-email), refusing to guess
ambiguous on route /: several elements match the intent (candidates: #alpha, #beta, #gamma), refusing to guess
```

When several candidates clear the fuzzy band, exact equality of the broken identifier with a candidate's id / name / data-testid outranks token containment: `.content` heals to `#content` even with `#footer-content` on the page, which was never a tie. Two candidates both exact-equal after normalization (`#search_box` vs `#searchBox`) still refuse with both named.

**Deleted positional disambiguators refuse and teach.** A strict-mode failure whose locator matches several elements means a `.first()`/`.nth()` was deleted, and the page cannot give that information back. A guessed position would pass the re-run while silently changing what the test verifies, so the refusal names what distinguishes the matches instead:

```text
locator matches 3 elements identical by accessible name; the original disambiguator
(.first()/.nth()) cannot be recovered safely. Add a positional call back, or target
by a distinguishing attribute (candidates: .plan-basic / .plan-pro / .plan-max)
```

**Same-element confirmation.** Before a heal is proposed, the candidate must still carry the original locator's identity. Confirmation compares logical fingerprints (tag, key attributes, accessible-name sources, geometry) across fresh reads, so a React re-render that replaces every DOM node cannot fail a correct heal; pages that mutate identity attributes faster than a probe can read them get a deterministic instability refusal instead of a guess. Identity matching is spelling-blind: glued, snake_case, kebab-case, camelCase, and spaced forms are the same identifier, so `.ajaxButton` confirms against an element whose id is `ajaxButton`. When the fingerprint genuinely differs, the refusal says what differed:

```text
re-resolved element differs: expected an element matching "search panel 42"
(from page.locator('#search-panel-42')), got input[id="global-lookup"][type="search"] at (169, 100); not healing
```

**The principle: refusal over wrong heal.** A wrong locator that passes today is worse than a red test you can see. Every refusal states its reason (not found on which route, closest candidates below the confidence threshold, possibly state-dependent, redirected to login), so you always know what to do next.

## Modes and Flags

**Default (run-first).** As above: run the tests, heal only what actually failed for locator reasons, on the page it failed on, then re-verify.

**`--scan`.** The static probe: no test execution; every locator in the spec and its page objects probed on its inferred route, reported intact / healed / refused. For locator audits and suites too expensive to run. It cannot see pages only reached mid-test; the run-first default can, which is why a locator `--scan` honestly refuses can heal in the default mode.

**CI.** `--yes` / `-y` applies without prompting. In a non-interactive context the CLI never prompts. Exit codes: **0** heals applied, all tests passing, nothing to heal, or `--dry-run`; **1** error, or a heal was reverted because its verify re-run still failed; **2** heals available but not applied; the diff is still printed, so a pipeline can surface it.

**Failed verification reverts the heal.** A heal whose verify re-run still fails is undone (the file goes back byte-identical) and announced as `heal reverted: re-run still failing after heal`, and the audit keeps the whole history (`applied: true, verified: false, reverted: true`); `--json` verdicts carry `reverted`. Granularity: in run-first mode, when the combined re-run fails, each previously failing test is re-run individually and only the heals whose tests still fail are reverted (heals whose tests pass stay, individually verified); in `--scan` mode there is no per-test signal, so a heal is reverted when any spec owning its file still fails.

| Flag | What it does |
| --- | --- |
| `-h, --help` | usage, every flag, one example |
| `-v, --version` | print the version |
| `--scan` | static probe: every locator on its inferred route, no test execution |
| `--apply` | write approved heals to source files (always previews the diff first) |
| `--dry-run` | full classification and proposal, print the exact diff, never write, skip the verify re-run (`dry run: no files changed, heal not verified`) |
| `-y, --yes` | auto-approve the apply prompt for **evidence-based heals only**. It will never cover suggestion-level changes (no flag in this build accepts them) |
| `--json` | one machine-readable JSON object on stdout, byte-stable (schemaVersion 1, below) |
| `--output <path>` | additionally write the human report to a file; stdout unchanged |
| `--verbose` | detailed progress on stderr: probe steps, candidate scoring, child commands executed |
| `--debug` | implies `--verbose`; adds stack traces and raw child stdout/stderr |
| `--config <file>` | use this qa-core config file instead of the default lookup; missing or invalid errors with the full story |
| `--playwright-config <path>` | Playwright config for a spec run, passed through as `--config`. Same path rules as a findings `configPath`. Not with `--findings` |
| `--framework <id>` | framework to use. Supported now: `playwright-js`. Planned: `cypress-js`, `selenium-js`, `playwright-py`, `selenium-py`. The flag overrides detection |
| `--base-url <url>` | override base URL resolution (config → goto scan) |
| `--project <name>` | pick a Playwright project when their baseURLs disagree |
| `--route <file>=<route>` | override route inference per file (repeatable) |
| `--storage-state <path>` | probe with a saved Playwright session |
| `--auth-setup <file>#<export>` | probe after running your login function (`file:export` also works, with no quotes needed in zsh) |
| `--auth-setup-timeout <seconds>` | login timeout, default 60 |
| `--settle-ms <ms>` | cap on the mutation-quiet settle before candidate collection (default 2000) |
| `--audit-log <path>` | append applied heals to this JSONL file |
| `--no-trace` | skip tracing (custom browser setups); failure URLs come from route inference |
| `--verify` / `--no-verify` | re-run previously failing tests after applying (default on); `--no-verify` skips the re-run |
| `--max-heals <n>` | cap heals per run |
| `--no-color` | disable ANSI colors; the `NO_COLOR` env var is honored automatically |
| `--test <title>` | run and heal exactly one test of one spec file. Give a title, or `"Describe › title"`. Needs the spec file path. Not with `--scan` |
| `--findings <file>` | read a heal findings file (contract version 1) instead of a spec path. Needs `--results` |
| `--results <file>` | where `--findings` writes the heal results file. Needs `--findings` |
| `--run-timeout <seconds>` | total time for every Playwright run in one command. Works with `--findings` or `--test`. In findings mode the default is now 10 minutes for the whole command. In 0.4.1 it was 10 minutes for each run. A long findings run may now stop with `timeout`. Raise the limit with this flag |
| `--shadow-runs <n>` | scratch re-runs that must all pass before a findings proposal is verified (default 3, with `--findings`) |

**The `--json` contract (schemaVersion 1).** The payload always carries `schemaVersion: 1`, a `verdicts` array (one entry per probed locator and per non-locator failure, each with `spec`, `testTitle`, `classification` (`locator` / `non-locator`), `message`, `healApplied`, `before`, `after`, `verified`), and a `summary` of `{ heals, refusals, nonLocator, errors }`, alongside the original per-locator fields. Errors also emit valid JSON with the failure story in `error`. schemaVersion 1 is the compatibility contract: existing fields will not change meaning or disappear within it; additions may appear. Exit codes are unchanged by `--json`.

## Frameworks

Version 0.6 runs Playwright and Cypress tests written in JavaScript or TypeScript. The adapter ids are `playwright-js` and `cypress-js`.

Detection looks at files only. It does not run a framework, a package manager, or Python. The order is:

1. `--framework` wins, including when two frameworks are present.
2. In a findings file, `project.configPath` names the framework when the file name is recognised.
3. Otherwise heal looks at the project root for `playwright.config.*`, `cypress.config.*`, `selenium-webdriver` in `package.json` dependencies or devDependencies, and Python config files that import `playwright` or `selenium`.

When nothing matches, heal uses `playwright-js` and prints nothing about it. When two frameworks match and you do not pass `--framework`, heal stops with exit code 2, names what matched, and writes nothing. When the only match is a framework this version does not run, heal stops with exit code 2 and writes nothing. `capabilities` and `capabilities --json` are answered before that check, with no `--framework` flag, the same way 0.4.2 always answered. `--verbose` prints one line, `[verbose] framework <id> (<reason>)`.

Selenium and Python adapters are planned. This version does not run them.

## Cypress

Cypress healing uses the same rules as Playwright: one matching element, or no change. The failing page is taken from the test that just failed. Heal does not open the app again.

`cy.get` with a CSS literal, `cy.contains` with a literal, and `cy.getByRole` with a literal role and name can be healed. `cy.getByRole` is written only when the installed Cypress is 16.2.0 or newer. Cypress older than 15.10.0 is refused.

A test id heal uses the `testIdAttribute` string in the Cypress config when the project sets one. Otherwise heal uses `data-test`. Cypress's own configuration reference does not define `testIdAttribute`; projects set it when they follow the `data-cy`, `data-test`, or `data-testid` practice.

These shapes are refused: `cy.origin`, iframes, `.shadow()`, `includeShadowDom`, `.within()`, a chained `.find()`, jQuery-only selectors, variables, template literals with expressions, and custom commands.

The project needs its own Cypress install. Heal does not add Cypress, a plugin, or a file to the project. A run uses a temporary copy and does not clear the project's screenshot, video, or download folders.

## The Findings and Results Contract

Since 0.4.0, qa-core-heal can read a findings file written by another tool (qa-core-flaky) and write a results file back. The two files follow contract version 1. Their JSON Schemas are in the `schemas/` folder of the package: `heal-findings.v1.schema.json` (owned by qa-core-flaky) and `heal-results.v1.schema.json` (owned by qa-core-heal). Version 1 is frozen. See `schemas/README.md`.

```bash
npx qa-core-flaky triage <report.json> --heal-findings heal-findings.json
npx qa-core-heal --findings heal-findings.json --results heal-results.json --dry-run
```

The first command is qa-core-flaky. It writes the findings file. The second command is qa-core-heal. A finding's `file` is relative to Playwright's `testDir` (for example `broken.spec.ts` when `testDir` is `./tests`). `project.configPath` stays relative to the folder where you run heal (for example `demo/saucedemo/playwright.config.ts`). Heal still receives that `configPath` unchanged.

**What it does.** For each finding whose handoff is `locator`, qa-core-heal runs that one test (not the whole file), reads the failure, and looks for a confident replacement on the live page. If it finds one, it applies the change to a temporary copy of your project and runs the same test there. The default is 3 runs, and every run must pass. `--shadow-runs` or `heal.shadowRuns` in `qa-core.config.json` sets the count. The flag wins. Only a change that passes every run is written to the results file as `proposed`. Your source files are not touched. A diff that removes or loosens an assertion is refused with `weakens-test` before any copy is made.

**The handoff gate.** A finding with the handoff `none` is refused with the code `ineligible-handoff`, and no test is run for it. qa-core-heal also checks the verdict and the gates in the finding itself, so a real bug or an environment issue is never run as a locator problem. A finding with the handoff `suggest` is not run either.

**Nothing is applied without your word.** `--dry-run` is the default. Each proposal comes with a patch file in `.qa-core/heal/patches`, next to the results file. Only `--apply` writes the change to your spec, and it asks first. `--apply --yes` skips the question. Without a terminal and without `--yes`, the answer is no and the entry stays `proposed`.

**One result per finding, in the same order.** Each entry has a `status`:

| Status | Meaning |
| --- | --- |
| `proposed` | a change was found and passed the scratch check. It is not applied |
| `applied` | the change was written to your spec, with `--apply` and your consent |
| `refused` | qa-core-heal chose not to act. The entry carries a `refusal` with a code and a message |
| `not-locator` | the test failed, but not on a locator, so there is nothing to heal |
| `nothing-to-heal` | the test passed when qa-core-heal ran it. This is weak evidence only. It does not show that the flakiness is gone |
| `error` | the test could not be run or read, for example because it is skipped |

**Refusal codes this build writes.** `ambiguous-match`, `element-changed`, `strict-needs-human`, `possible-real-bug`, `verification-failed`, `weakens-test`, `no-safe-pattern`, `ineligible-handoff`, `navigation-or-network`, `spec-not-found` and `timeout`. The schema also lists `baseline-not-reproduced`, `ai-disabled` and `ai-invalid-output`. This build does not write those three. Every refusal this build writes has a test fixture.

**Exit codes in findings mode.**

| Code | Meaning |
| --- | --- |
| `0` | the results file was written, whatever the statuses are |
| `1` | an error: the findings file cannot be read or is not valid, or the flags do not fit together. It is also returned when a change was applied and then reverted because its verify run failed |
| `2` | the findings file has a `schemaVersion` this build does not read. The message names the versions it supports. No results file is written |

**Check what a build supports.**

```bash
npx qa-core-heal capabilities --json
```

It prints one JSON object. `contracts.findings` and `contracts.results` are arrays of the contract versions this build reads and writes, so a caller checks that its own version is in the array:

```json
{
  "schema": "qa-core.heal-capabilities",
  "schemaVersion": 1,
  "tool": { "name": "qa-core-heal", "version": "0.6.0" },
  "contracts": { "findings": [1], "results": [1] },
  "playwrightVersion": "1.60.0",
  "features": { "findings": true, "targetedRun": true, "ruleSuggestions": false, "ai": false, "playwrightConfig": true, "runTimeout": true, "frameworks": ["playwright-js", "cypress-js"] },
  "frameworkVersions": { "playwright-js": "1.60.0", "cypress-js": null }
}
```

`playwrightVersion` is the version found for the current folder, or `null` when none is found. `features.frameworks` lists the adapters this build can run. `frameworkVersions` repeats `playwrightVersion` under `playwright-js`. `features.runTimeout` is true when this build accepts `--run-timeout`. Without `--json` the same facts print as plain text, with one extra line for the frameworks. The word `capabilities` is read as the subcommand only when it is the only argument (with or without `--json`). A spec file or folder with that name is still reachable as `./capabilities`.

`--run-timeout` is one budget for the whole command. Listing the test, the first run, every scratch run, and the re-run after `--apply` all share it. When the time is used up, the current run is stopped. In `--test` mode the run fails with "The test run timed out", or, when the budget runs out during the re-run, the heal is reverted and the message says the run timeout was reached during the re-run. In findings mode a run that already started is refused with "The test run timed out before it finished." A later finding that never started is refused with "The run timeout was used up before this finding started. No test was run." Both refusals use the code `timeout`. In findings mode the default is 10 minutes for the whole command, not for each finding. A long findings file can refuse the later findings. Raise the limit with `--run-timeout`. In 0.4.1 the default was 10 minutes for each Playwright run.

**Paths in a findings file.** The `file` of each finding is relative to the folder where you run qa-core-heal, or to the folder of `project.configPath`. When `project.configPath` is set and the file is not found from either of those, heal also looks in that config's `testDir` (when the config does not set `testDir`, Playwright's own default is the folder of the config file). Absolute paths and paths that leave the project are refused with `spec-not-found`, and the message says the file is outside the project. A path that contains `..` is refused the same way, even when it would resolve back inside the project, for example `tests/../tests/a.spec.ts`. The refusal code stays `spec-not-found`. A missing relative path that does not contain `..` says the file was not found inside the project folder. A symlink that points outside the project is refused with the same code, and the message says it is a symlink. The real location of the spec is checked against the project folder, so a `..` in `project.configPath` or a symbolic link cannot bring in a spec from outside it. A hard link inside the project that names a spec outside the project is not caught, because a hard link and a normal file look the same. Do not point a hard link at a spec outside the project. An explicit `--dry-run` is accepted with `--findings` and is the default anyway. `--findings` runs the test named in each finding, so it is never combined with `--test`.

**The Playwright config.** `project.configPath` is passed to Playwright as `--config` for the test list, the first run, the scratch check and the re-run after an apply, so a config that lives in a folder below the project root (for example `demo/saucedemo/playwright.config.ts`) is used. A `configPath` that does not exist, or that points outside the project, is ignored and Playwright finds its own config as before. With `--verbose`, heal prints one line saying why: `[verbose] ignored configPath <path>: <why>`. In spec mode (no findings file), pass `--playwright-config <path>`. It uses the same path rules and is passed through as `--config`. An explicit value that those rules refuse fails the run with a clear error. `--config` itself still names the qa-core config file.

**Separate output folders.** Every Playwright call in findings mode, and every Playwright call in spec mode, writes to its own temporary `--output` folder (`qa-core-heal-out-*` in the system temp directory). Heal removes that folder when the run finishes, when `--run-timeout` stops it, and when heal is stopped with SIGINT, SIGTERM, or SIGHUP. Those stops also kill the Playwright process group and the browser processes it started in their own group. The exit code is 130 for SIGINT, 143 for SIGTERM, and 129 for SIGHUP. After a killed child, heal also removes `.org.chromium.Chromium.*` files and folders in the system temp directory that were created after that child started. Files and folders that were already there are left alone. An entry a live process is using, including one that has a file open inside it, is left alone. Without `/proc`, heal cannot tell which entries are in use, so it skips this sweep. Two runs of qa-core-heal in the same project at the same time do not delete each other's traces.

**Run one test.** `--test` works without a findings file too:

```bash
npx qa-core-heal tests/saucedemo-login.spec.ts --test "logs in with a valid user" --dry-run
```

Exactly one test runs, in the first run and in the verify re-run. A title that matches more than one test (for example in two projects) is refused before anything runs. Give the full title (`"Describe › title"`) or `--project` to pick one.

**Not in 0.4.2.** The rule-based timing and selector fixes.

## Limitations

Honesty about scope, so you are never surprised:

1. **State-dependent elements cannot be healed by `--scan`.** The static probe sees the page as it loads; an element that exists only after user actions looks broken even when its locator is correct. Heal says so: `element may be state-dependent (selector token "result" suggests it appears only after user actions); static healing cannot verify it` when the selector carries evidence (toast, modal, alert, result), and the hedged `no matching or similar element on the probed page...` when it does not. State-gated ROLES (`option`, `menuitem`, `dialog`, `tooltip`, …) get the precise version: `role 'option' elements exist only while a dropdown/listbox is open; a fresh page load cannot show them. Static probing cannot verify this locator - check the option name manually or re-record it`. It is never a heal, since anything found instead would be the wrong element, though scored near-misses stay appended as evidence. The run-first default closes most of the URL side of this gap: it probes the page the test actually failed on.
2. **Dynamic locators cannot be matched to source.** A selector built at runtime (`page.locator(sel)`, template literals) has no literal call to rewrite. Run mode says so explicitly: `1 failing locator could not be matched to source: <selector> (from <test title>). This is a bug worth reporting.` It also exits non-zero rather than pretending there was nothing to heal.
3. **Healed locators can rot as the UI evolves.** A heal is correct against today's page; next month's redesign can invalidate it like any hand-written locator. This is why the run-first default re-verifies on every run instead of trusting yesterday's heal.
4. It cannot see silent positional drift: if a list reorders, `li:nth-child(2)` still resolves, to a different row, and is reported intact. Heal fixes broken locators; it does not audit passing ones.
5. Hash-suffixed generated ids (`#manage-apps-3fc9a1`) heal only when the element offers a second identity. Typo'd identifiers are different: the identity is one edit away, and the fuzzy stage heals them under the kind guard and confirmation; two near-identical candidates refuse as ambiguous.
6. Node 22.6+ is required to read TypeScript playwright configs (native type stripping). Older Node works with `.js` configs or explicit `--base-url` / `--route` flags, and the CLI says exactly that when it matters.
7. It never commits. Applying approved diffs to your working tree is the maximum action. You review, you commit.

## The Numbers

Measured on 16 public eval suites in this repo (168 locators, 104 deliberately broken, one suite probing a live public site, one exercising the run-first default end to end across 32 scenarios), Playwright 1.60:

| Measure | Result |
| --- | --- |
| Healable breaks fixed and verified by a passing re-run | 72 / 72 |
| Unhealable breaks correctly refused instead of guessed | 32 / 32 |
| Intact locators kept untouched | 10 / 10 |
| Valid locators wrongly touched | 0 |
| Wrong heals (locator rewritten to the wrong element) | 0 |
| Determinism | two full runs, byte-identical results |

Run them yourself: `npm run evals`. The harness exists so that every real-world bug becomes a pinned case: each refusal message, classification rule, and auth behavior above is asserted by a fixture, and the suite fails loudly if any of it regresses.

## From Source

```sh
npm install
npx playwright install chromium                 # macOS and Windows
npx playwright install --with-deps chromium     # Linux: also installs Chromium's system libraries
npm run demo                                    # broken suite -> failures -> proposed heals
npm test                                        # unit + integration tests
npm run evals                                   # the full eval harness
```

Use `node dist/cli.js` in place of `npx qa-core-heal` from a checkout (run `npm run build` once). Optional `qa-core.config.json` in your repo root sets baseUrl, test dir, allowed locator levels, page objects, authSetup, and storage state; full schema in `skill/references/config.md`.

`playwright` is a required peer dependency (`>=1.49.0`). `@playwright/test` is an optional peer dependency at the same range: install it when this project runs the Playwright test runner. This package was tested at 1.49.0 and at 1.64.1. The evals in this repo run on Playwright 1.60.0. A Playwright prerelease, such as `1.65.0-alpha`, does not satisfy `>=1.49.0` under npm's semver rules. To install qa-core-heal next to a Playwright prerelease, use `npm install --legacy-peer-deps`.

## Use It as a Claude Code Skill

The `skill/` folder makes heal a Claude Code skill: Claude detects locator-class failures in your suite, runs heal in dry-run, presents the consolidated diff, applies only what you approve, and never commits. Copy `skill/` into your skills directory or install from the release.

## License and Contributing

MIT. Issues and eval-suite contributions welcome, especially broken-locator patterns from real projects that heal should handle or honestly refuse.

Built by [Muhammad Usman](https://sardarusmanjutt.com), part of the QA-Core agentic testing project.
