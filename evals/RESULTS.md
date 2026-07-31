# qa-core-heal eval results

Playwright version: 1.60.0

A heal counts as correct only when its status matches the expected outcome
AND the test that uses the locator passes after the heal is applied.
Expected refusals (no identity left to heal from) count as correct behavior.

| Suite | Locators | Broken | Healed | Correctly refused | Intact kept | Wrong heals | Post-heal green |
|---|---|---|---|---|---|---|---|
| checkout-basic | 10 | 5 | 5/5 | 0/0 | — | 0 | 5/5 passed |
| signup-pom | 12 | 6 | 6/6 | 0/0 | — | 0 | 3/3 passed |
| orders-dashboard | 10 | 5 | 3/3 | 2/2 | — | 0 | 4/6 passed (2 expected failures) |
| account-settings | 10 | 5 | 5/5 | 0/0 | — | 0 | 7/7 passed |
| pricing-hostile | 10 | 6 | 3/3 | 3/3 | — | 0 | 3/6 passed (3 expected failures) |
| hostile-mutation | 3 | 1 | 0/0 | 1/1 | — | 0 | 1/2 passed (1 expected failure) |
| fuzzy-typos | 20 | 12 | 6/6 | 6/6 | 3/3 | 0 | 7/13 passed (6 expected failures) |
| react-churn | 3 | 2 | 1/1 | 1/1 | — | 0 | 1/2 passed (1 expected failure) |
| tag-typos | 9 | 7 | 2/2 | 5/5 | 2/2 | 0 | 2/7 passed (5 expected failures) |
| normalization | 4 | 3 | 2/2 | 1/1 | 1/1 | 0 | 2/3 passed (1 expected failure) |
| shadow-dom | 5 | 3 | 2/2 | 1/1 | 2/2 | 0 | 2/3 passed (1 expected failure) |
| kind-guard | 6 | 4 | 1/1 | 3/3 | 1/1 | 0 | 2/5 passed (3 expected failures) |
| run-mode | 17 | 17 | 17/17 | 0/0 | — | 0 | 28/28 passed |
| demowebshop-pom | 11 | 4 | 3/3 | 1/1 | 1/1 | 0 | 7/8 passed (1 expected failure) |
| **Total** | **130** | **80** | **56/56** | **24/24** | **10/10** | **0** | |

Misses (expected heal, got refusal): 0
Cascade level agreement (informational): 56/56 correct heals landed on the predicted level.

