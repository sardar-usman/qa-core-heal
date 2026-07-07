---
name: qa-core-heal
description: Self-heal broken Playwright locators in an existing test suite using QA-Core's deterministic heal engine. Use this skill whenever the user mentions broken locators, failing Playwright tests after a UI change, flaky selectors, "fix my tests", "heal my suite", locator drift, or asks to repair, update, or stabilize Playwright selectors. Also trigger when a Playwright test run fails with locator resolution errors (strict mode violations, element not found, timeout waiting for selector), even if the user does not use the word "heal".
---

# QA-Core Heal

QA-Core Heal repairs broken Playwright locators in an existing test suite. The heal engine itself is deterministic: given the same page and the same broken locator, it always resolves to the same replacement. Your job as the orchestrator is to configure it correctly for the user's project, run it safely, present the proposed changes as a reviewable diff, and never modify the user's repo without their approval.

## Core rules

These exist because the user is trusting an automated tool with their test code. Breaking any of them destroys that trust permanently.

1. Always run in dry-run mode first. Never apply changes on the first pass.
2. Present every proposed heal as a diff (old locator, new locator, file, line) before applying anything.
3. Never commit to git. Applying approved heals to the working tree is the maximum action. The user commits.
4. Always write the audit log (see Audit trail below) when heals are applied.
5. If the heal engine cannot resolve a locator with confidence, report it as unresolved. Do not guess or hand-write a replacement locator yourself. The engine's determinism is the product; a hand-written locator from you breaks the replay guarantee.

## Workflow

### Step 1: Detect the project

Before running anything, establish:

1. Confirm this is a Playwright project: look for `playwright.config.ts` or `playwright.config.js` and `@playwright/test` in package.json.
2. Find the test directory from the Playwright config (`testDir`), not by guessing.
3. Check for an existing `qa-core.config.json` in the repo root. If present, use it. If absent, create one from the template in `references/config.md`, inferring what you can (test dir, base URL from the Playwright config `use.baseURL`) and asking the user only for what cannot be inferred.

If this is not a Playwright project, say so and stop. Do not attempt to adapt the engine to Cypress, Selenium, or anything else.

### Step 2: Identify what is broken

If the user pointed at specific failing specs, use those. Otherwise run the suite (or the subset the user names) and collect the specs that fail with locator-class errors: strict mode violations, element not found, timeout waiting for locator. Test failures caused by assertion logic, network issues, or application bugs are NOT heal targets. Tell the user which failures you are excluding and why; misclassifying a real bug as a locator break hides defects, which is the worst thing a QA tool can do.

### Step 3: Dry run

Run the heal engine in dry-run mode against each broken spec:

```
npm run heal -- <spec-path> --base-url <baseURL> --dry-run
```

Run with --json for parseable output. Each proposed heal carries the cascade level it resolved at (role, label, placeholder, text, alt, title, testid, css, xpath) and an ambiguous flag. Collect them all before showing the user anything.

### Step 4: Present the diff

Show a single consolidated review, one entry per proposed heal:

```
[file:line] level: role (ambiguous: no)
  - old: page.locator('#submit-btn-2841')
  + new: page.getByRole('button', { name: 'Submit payment' })
  reason: id matched auto-generated pattern; role+name is unique and stable on page
```

Group by file. Flag anything that resolved at css or xpath level, or that carries ambiguous: true, as "review carefully". These are honest signals from the engine's cascade: css and xpath are last-resort levels, and ambiguous means multiple elements matched and the engine picked the best-level first match. List refused locators separately with the engine's reason; a refusal (for example a locator whose identity was the text and the text is gone) is the safety guard working, not a failure.

Then ask the user: apply all, apply selected, or abort.

### Step 5: Apply and log

On approval, re-run without `--dry-run` for the approved specs. Then:

1. Re-run the healed specs to verify they now pass. Report the before/after pass counts.
2. Write the audit log.
3. Summarize: healed N locators across M files, K unresolved, log written to `.qa-core/heal-log.jsonl`.

## Audit trail

Append one JSON line per applied heal to `.qa-core/heal-log.jsonl`:

```json
{"ts":"2026-07-06T10:12:03Z","file":"tests/checkout.spec.ts","line":42,"old":"#submit-btn-2841","new":"getByRole('button', { name: 'Submit payment' })","level":"role","ambiguous":false,"verified":true}
```

The `verified` field is true only if the healed spec passed on re-run. This log is the user's answer to "what did the tool change and why" in code review, so never skip it.

## Conventions matching

Read a sample of the user's existing test files before applying heals. Match their style:

1. If the suite uses Page Objects, heals to locators inside Page Object files should stay in those files. Never inline a locator into a spec when the project centralizes them.
2. Match their quote style and locator idioms (getBy* vs page.locator) where the engine output allows a choice.
3. TypeScript vs JavaScript output follows the file being edited, obviously, but also check tsconfig strictness before emitting typed helpers.

## When things go wrong

1. Engine exits non-zero: show the raw error, do not retry blindly. Common causes are wrong base URL (app not running) and auth walls. Check `qa-core.config.json` auth settings against `references/config.md`.
2. Healed test still fails: mark the heal as unverified in the log, revert that specific change, and report it as unresolved. A heal that does not make the test pass is not a heal.
3. More than half the suite fails with locator errors: stop and tell the user this looks like an environment or deploy problem, not locator drift. Mass-healing against a broken environment produces garbage locators.

## Bundled resources

- `references/config.md`: full config schema with every field explained. Read it before creating or editing a config file.
- `references/locator-strategy.md`: the cascade ladder the engine uses (role, label, placeholder, text, alt, title, testid, css, xpath) and what the ambiguous flag means. Read it when the user asks why a particular replacement was chosen.
- `example-project/`: a small Playwright suite with deliberately broken locators. Use it when the user wants to see heal work before pointing it at their real repo: `cd example-project && npm install && npm run demo`.
