# qa-core.config.json

Lives in the repo root. Optional: when the file is absent the CLI falls back to the built-in defaults shown below (it does not create the file). `baseUrl` and `testDir` show example values; they have no built-in defaults. Without a config file you pass a spec path on the command line; the base URL is resolved automatically from the project's `playwright.config.ts/.js` (`use.baseURL`) or an absolute `page.goto()` in the specs, and `--base-url` is only needed when neither exists.

```json
{
  "$schema": "https://raw.githubusercontent.com/sardar-usman/qa-core/main/schema/config.schema.json",
  "baseUrl": "http://localhost:3000",
  "testDir": "tests",
  "selectorPreference": ["role", "label", "placeholder", "text", "alt", "title", "testid", "css", "xpath"],
  "pageObjects": {
    "enabled": true,
    "dir": null
  },
  "auth": {
    "storageState": null
  },
  "heal": {
    "dryRunByDefault": false,
    "maxHealsPerRun": null,
    "verifyAfterApply": true
  },
  "audit": {
    "logPath": ".qa-core/heal-log.jsonl"
  }
}
```

Apply mode is always gated regardless of these settings: the CLI prints the full proposed diff first and requires `--yes` or an interactive confirmation before writing.

## Field notes

- `baseUrl`: where the app under test runs. Infer from Playwright config `use.baseURL` when present. If neither exists, ask the user; never guess a port.
- `testDir`: infer from Playwright config `testDir`. This is the only directory heal will read or write test files in.
- `selectorPreference`: an allow-list guard, not a reordering. The engine's resolve cascade order is fixed (that fixed order is what makes heal deterministic and verified). Any heal that resolves at a level not listed here is refused and reported. Remove `css` and `xpath` from the list to forbid last-resort heals entirely. A `css-tag-fix` heal (a compound CSS selector whose typo'd tag token was corrected) counts as `css` for this guard — listing `css` allows it, removing `css` forbids it.
- `pageObjects.enabled`: when true, heals targeting locators defined in `pageObjects.dir` are applied there, not inlined into specs.
- `auth.storageState`: path to a Playwright storage state JSON for authenticated pages. If the app needs auth and this is not set, heal will hit login walls; detect this (heal failures all resolving to login page elements) and prompt the user to generate a storage state with Playwright's own auth setup, then point this field at it. A setupSpec option that runs an auth spec automatically is planned for v2; it is not in v1, so do not reference it.
- `authSetup`: `"file#export"` (or `"file:export"`) naming the user's own login function, run against the probing page. When BOTH `authSetup` and a storage state are configured, the saved session is used first and an expired session automatically falls back to the login function ("saved session expired; falling back to auth setup") — never the reverse.
- `heal.maxHealsPerRun`: safety cap, unset by default. If a run proposes more than this, stop and warn (see "When things go wrong" in SKILL.md; mass drift usually means environment problems).
- `audit.logPath`: append-only JSONL. Add `.qa-core/` to the user's `.gitignore` only if they ask; many teams want the log committed for review trails.
