# HomeHub V6.0.0 — RC1 Report (6.0.0-rc.1)

## Verified

- **B1 fix present.** Vs batch 3, only the version string changed in production source; `firestore.rules` is byte-identical.
- **Authorization paths:**
  - owner / admin budgets: `budgetAdmin` / `budgetWalletOk`, role-checked;
  - refunds: `mvRefundOk` + ledger, latest-only void;
  - transfers: same currency, never before an opening;
  - closed periods: `v6Unlocked` / `v6PeriodOpenOk`;
  - Zakat `zk_*` locked.
- **Existing Homes:** members are refused by role id even with a stale `manageBudgets` grant (emulator V6-10). The v7 upgrade revokes only that grant and keeps custom permissions (unit-tested).
- **Rule cost (estimator):** max 1,026, none > 1,100; `expenses` update 1,018; `walletMovements` create 744 / 750. No platform-limit violation found, so no rule change.

## Changes (RC1)

| File | Change |
|---|---|
| `tools/clean-start-dryrun.mjs` | Lists **exact paths** (delete / archive / preserve) + a SHA-256 of the delete list; pure `buildCleanStartPlan`; still read-only and name-confirmed |
| `docs/CLEAN-START.md` | Paths, checksum re-check; clean-start approval ≠ deployment approval |
| `tests/unit/clean-start.test.mjs` (new), `tests/static/static.test.mjs` | Plan + read-only guards |
| `tests/rules/rules.test.mjs` | The B1 fix |
| `package.json`, `src/config/app-config.js` | `6.0.0-rc.1` |

## Tests

| Command | Result |
|---|---|
| `npm test` | **337/337 PASS** |
| `npm run test:e2e` | **119/119 PASS** |
| `npm run test:rules:smoke` (JavaScript only) | 144 tests; L14 whitelisted |
| `npm run test:rules` | **NOT RUN** (no `firebase-tools` / network). Expected 144/144 |
| `npm run test:rules:strict` | **NOT RUN.** Expected 144/144 |
| `npm run rules:limits -- <log>` | **NOT RUN** (needs both logs) |
| Dry run against Firestore | **NOT RUN** (plan logic unit-tested) |

## One-time owner action (existing Homes)

Settings → **Update default roles** (template v7). Members lose only `expenses.manageBudgets`; custom grants survive. The rules already enforce the policy without it.

## Recommendation

**NO-GO until** your Normal and Strict emulator runs show **144/144** with **0** `rules:limits` hits. After that: **GO** for deployment approval.

- rules → hosting;
- clean start remains a separate, separately approved step.

**Residual risks (not blockers):**
- `walletMovements` create has 6 points of headroom;
- a cap-history viewer is deferred.
