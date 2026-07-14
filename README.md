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

## Quick start

```sh
npm i -D qa-core-heal
npx playwright install chromium   # once, if you don't already have it
npx qa-core-heal tests/login.spec.ts
```

Zero config. The CLI runs the spec with Playwright first; if everything passes it prints `All tests passing. Nothing to heal.` and exits — no scanning, no probing, no browser. On failures, this is the full shape of a run:

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

The page each test was on when it failed comes from the Playwright trace, so a locator that breaks three clicks deep heals on the page it actually broke on — not on your homepage. Base URL, routes, and page objects (imports followed recursively) are all resolved from your project as-is: your `playwright.config.ts` is imported the way Playwright imports it, `defineConfig`, env vars, `require("dotenv")` and all.

## Authenticated apps

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

(The quotes matter in zsh — `#` starts a comment otherwise.) The module loads with the same TypeScript machinery as your config, and `await login(page)` runs on a fresh page in the probing context — with your project's baseURL set, so relative `page.goto("/")` works exactly as in your tests. One login, many probes: the session lives in the probing context for the whole run. For every run, put it in `qa-core.config.json`:

```json
{ "authSetup": "utils/common.ts#login" }
```

A login that throws or hangs (60s default, `--auth-setup-timeout <seconds>`) fails the whole run loudly — `auth setup utils/common.ts#login failed: <error>` — never a silent unauthenticated probe. It deliberately does NOT parse or re-run your `beforeAll`/`beforeEach` hooks: setup code can seed data or trigger side effects, and only you can say what is safe to re-run.

**2. Saved sessions: `--storage-state <path>`.**

Playwright's storage-state file (or `auth.storageState` in qa-core.config.json) — the right fit for CI and the standard save-auth pattern: a setup script that logs in once and writes `context.storageState({ path: '.auth/state.json' })`. With neither flag set, heal auto-detects: `use.storageState` from your playwright config, then `.auth/state.json` / `playwright/.auth/user.json` if present, announcing `using storage state from <path>`. Detection finding nothing just probes unauthenticated. An expired session is diagnosed, not papered over:

```text
storage state was applied but /accounts still redirected to /login; the saved
session may be expired. Re-generate it and retry.
```

And when `--auth-setup` ran but the redirect still happens: `auth setup ran but /accounts still redirected to /login; the login function may have failed silently or the session did not persist`.

**3. Security.**

> The tool never reads or stores credentials. It executes only the login code you explicitly name — nothing else in your setup files. Sessions stay in memory for the duration of the run. Logs and audit entries carry file paths, export names, and pass/fail — never credentials, cookie values, or storage-state contents. Keep session files out of version control: add `.auth/` to your `.gitignore`.

## How it decides

**Failure classification is evidence-based.** A failure is a locator problem only when the evidence says so — a `locator.<action>:` / `expect.<matcher>:` prefix, a call-log `waiting for locator(...)` line, an `element(s) not found`, a strict mode violation — anywhere in the error, even when the top-level message is a test timeout or "Target page, context or browser has been closed". A locator that RESOLVED to a real element whose value merely mismatched is an app problem: `not a locator problem, healing won't fix this`. Navigation errors, thrown app errors, and timeouts with no pending locator action are reported, never healed.

**The heal ladder.** Broken locators re-resolve by semantic intent through Playwright's own preference order — role with accessible name, label, placeholder, text, alt, title, testid, then CSS/XPath — with a fuzzy stage below all of that for typo'd identifiers (`#Emai_l` → `#Email`, a `getByRole` name `"Ema_il_2"` → `"Email"`), scored by edit distance and whole-word token containment (a name mutation "search1" matches the field whose accessible name contains "search" as a word), and only accepted when exactly one candidate clears the bar.

**The kind guard.** The original selector says what KIND of element it meant — `#register-button` is a button, a `.fill()` target is a text input. A candidate of a conflicting kind is refused, however well the name matched:

```text
kind mismatch: expected button, candidate is link
```

**Ambiguity refuses, with names.** Nothing is ever picked from a set:

```text
ambiguous on route /: several close matches (#contact-email, #backup-email), refusing to guess
ambiguous on route /: several elements match the intent (candidates: #alpha, #beta, #gamma), refusing to guess
```

**Same-element confirmation.** Before a heal is proposed, the candidate must still carry the original locator's identity. Confirmation compares logical fingerprints — tag, key attributes, accessible-name sources, geometry — across fresh reads, so a React re-render that replaces every DOM node cannot fail a correct heal; pages that mutate identity attributes faster than a probe can read them get a deterministic instability refusal instead of a guess. When the fingerprint genuinely differs, the refusal says what differed:

```text
re-resolved element differs: expected an element matching "search panel 42"
(from page.locator('#search-panel-42')), got input[id="global-lookup"][type="search"] at (169, 100); not healing
```

**The principle: refusal over wrong heal.** A wrong locator that passes today is worse than a red test you can see. Every refusal states its reason — not found on which route, closest candidates below the confidence threshold, possibly state-dependent, redirected to login — so you always know what to do next.

## Modes & flags

**Default (run-first).** As above: run the tests, heal only what actually failed for locator reasons, on the page it failed on, then re-verify.

**`--scan`.** The static probe: no test execution — every locator in the spec and its page objects probed on its inferred route, reported intact / healed / refused. For locator audits and suites too expensive to run. It cannot see pages only reached mid-test; the run-first default can, which is why a locator `--scan` honestly refuses can heal in the default mode.

**CI.** `--yes` / `-y` applies without prompting. In a non-interactive context the CLI never prompts. Exit codes: **0** heals applied, all tests passing, nothing to heal, or `--dry-run`; **1** error; **2** heals available but not applied — the diff is still printed, so a pipeline can surface it.

| Flag | What it does |
| --- | --- |
| `--dry-run` | preview only, never writes |
| `--json` | one machine-readable JSON object on stdout, byte-stable |
| `--base-url <url>` | override base URL resolution (config → goto scan) |
| `--project <name>` | pick a Playwright project when their baseURLs disagree |
| `--route <file>=<route>` | override route inference per file (repeatable) |
| `--storage-state <path>` | probe with a saved Playwright session |
| `--auth-setup <file>#<export>` | probe after running your login function |
| `--auth-setup-timeout <seconds>` | login timeout, default 60 |
| `--no-trace` | skip tracing (custom browser setups); failure URLs come from route inference |
| `--no-verify` | skip the verification re-run |
| `--max-heals <n>` | cap heals per run |

## Limitations

Honesty about scope, so you are never surprised:

1. **State-dependent elements cannot be healed by `--scan`.** The static probe sees the page as it loads; an element that exists only after user actions looks broken even when its locator is correct. Heal says so — `element may be state-dependent (selector token "result" suggests it appears only after user actions); static healing cannot verify it` when the selector carries evidence (toast, modal, alert, result), and the hedged `no matching or similar element on the probed page...` when it does not. The run-first default closes most of this gap: it probes the page the test actually failed on.
2. **Dynamic locators cannot be matched to source.** A selector built at runtime (`page.locator(sel)`, template literals) has no literal call to rewrite. Run mode says so explicitly — `1 failing locator could not be matched to source: <selector> (from <test title>). This is a bug worth reporting.` — and exits non-zero rather than pretending there was nothing to heal.
3. **Healed locators can rot as the UI evolves** (credit: found by a community tester). A heal is correct against today's page; next month's redesign can invalidate it like any hand-written locator. This is why the run-first default re-verifies on every run instead of trusting yesterday's heal.
4. It cannot see silent positional drift: if a list reorders, `li:nth-child(2)` still resolves — to a different row — and is reported intact. Heal fixes broken locators; it does not audit passing ones.
5. Hash-suffixed generated ids (`#manage-apps-3fc9a1`) heal only when the element offers a second identity. Typo'd identifiers are different — the identity is one edit away, and the fuzzy stage heals them under the kind guard and confirmation; two near-identical candidates refuse as ambiguous.
6. Node 22.6+ is required to read TypeScript playwright configs (native type stripping). Older Node works with `.js` configs or explicit `--base-url` / `--route` flags, and the CLI says exactly that when it matters.
7. It never commits. Applying approved diffs to your working tree is the maximum action. You review, you commit.

## The numbers

Measured on 10 public eval suites in this repo (89 locators, 51 deliberately broken, one suite probing a live public site, one exercising the run-first default end to end), Playwright 1.60:

| Measure | Result |
| --- | --- |
| Healable breaks fixed and verified by a passing re-run | 39 / 39 |
| Unhealable breaks correctly refused instead of guessed | 12 / 12 |
| Valid locators wrongly touched | 0 |
| Wrong heals (locator rewritten to the wrong element) | 0 |
| Determinism | two full runs, byte-identical results |

Run them yourself: `npm run evals`. The harness exists so that every real-world bug becomes a pinned case: each refusal message, classification rule, and auth behavior above is asserted by a fixture, and the suite fails loudly if any of it regresses.

## From source

```sh
npm install
npx playwright install chromium                 # macOS and Windows
npx playwright install --with-deps chromium     # Linux: also installs Chromium's system libraries
npm run demo                                    # broken suite -> failures -> proposed heals
npm test                                        # unit + integration tests
npm run evals                                   # the full eval harness
```

Use `node dist/cli.js` in place of `npx qa-core-heal` from a checkout (run `npm run build` once). Optional `qa-core.config.json` in your repo root sets baseUrl, test dir, allowed locator levels, page objects, authSetup, and storage state; full schema in `skill/references/config.md`.

## Use it as a Claude Code skill

The `skill/` folder makes heal a Claude Code skill: Claude detects locator-class failures in your suite, runs heal in dry-run, presents the consolidated diff, applies only what you approve, and never commits. Copy `skill/` into your skills directory or install from the release.

## License and contributing

MIT. Issues and eval-suite contributions welcome, especially broken-locator patterns from real projects that heal should handle or honestly refuse.

Built by [Muhammad Usman](https://sardarusmanjutt.com), part of the QA-Core agentic testing project.
