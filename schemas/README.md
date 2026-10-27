# Contract Schemas

These two files are the heal side of contract version 1 between qa-core-flaky and qa-core-heal.

| File | Owner | What it describes |
| --- | --- | --- |
| `heal-findings.v1.schema.json` | qa-core-flaky | The findings file that `qa-core-heal --findings` reads. |
| `heal-results.v1.schema.json` | qa-core-heal | The results file that `qa-core-heal --results` writes. |

Both are JSON Schema draft 2020-12.

## Rules

- Version 1 is frozen. The files here are byte for byte the contract v1 files. A test checks their SHA-256 hashes.
- A change that is not backward compatible needs a new schema version, not an edit to these files.
- qa-core-heal reads findings with `schemaVersion` 1 only. Any other version exits with code 2 and a clear message. No results file is written.
- The schemas are shipped with the package, so a consumer can validate a file without a network call.
- ajv is a dev dependency of this repository. qa-core-heal itself does not validate at run time with ajv. The tests do.

## Checking Which Versions a Build Speaks

```bash
npx qa-core-heal capabilities --json
```

The output lists the tool version, the findings and results contract versions this build speaks, and the Playwright version it found.
