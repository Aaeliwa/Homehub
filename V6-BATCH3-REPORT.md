# HomeHub V6 — Batch 3 Report (6.0.0-batch.3)

No deployment, deletion, reset or migration. The 26 protected rule blocks are byte-identical.

## Changes

**Owner / admin budgets:**
- Rules `budgetAdmin(h)` = `manageBudgets` **and** role id owner / admin, on every budget-period, head and cap-change path; `budgetWalletOk` does the same for **household** wallet cycles.
- Homes whose stored member role still grants `manageBudgets` get **no** budget authority (V6-10).
- **Template v7:** members lose only that grant, via a precise revocation. Custom grants survive (unit-tested).
- The UI mirrors this (`env.budgetAdmin`).

**Verified defects fixed:**
- `funding` / `adjustment` were accepted on V6 accounts (the "Add money" path) → refused (use income / reconcile).
- Savings transfers could predate an account's opening (silently excluded from the balance) → refused.

**Rule cost:** `walletMovements` create 750 → **744** (inlined guard); expenses update 1,018 (no safe cut).

**Clean start:** `docs/CLEAN-START.md` + the read-only `tools/clean-start-dryrun.mjs` (Home-name confirmation; a static test forbids write APIs).

## Files changed (vs batch 2)

- **Added:** `docs/CLEAN-START.md`, `tools/clean-start-dryrun.mjs`.
- **Modified:** `firestore.rules`, `package.json`, `app-config.js`, `roles.js`, i18n `en` / `ar`, expenses `finance-store` / `module` / `page` / `tab-budget` / `tab-household`, and 7 test files (E2E, rules, static, finance-store, finance-v6-store, legacy-adoption, zakat).

**Policy-driven test updates (kept exact):** member budget actions now denied (admin authorized); template 6 → 7.

## Test results

| Command | Result |
|---|---|
| `npm test` | **336/336 PASS** |
| `npm run test:e2e` | **119/119 PASS** |
| `npm run test:rules:smoke` (JavaScript only) | 144 tests; L14 whitelisted |
| `npm run test:rules` / `test:rules:strict` | **NOT RUN** (no `firebase-tools` / network). Expected **144/144** each |
| `npm run rules:limits -- <log>` | **NOT RUN** (needs the logs). Estimator: max 1,026, none > 1,100 |
| `tools/clean-start-dryrun.mjs` | **NOT RUN** (syntax-checked) |

## Clean start (summary; nothing executed)

1. Read-only dry run, name-confirmed.
2. Written approval.
3. Archive the old wallets (a rule-enforced freeze).
4. Re-run the dry run.
5. A **separately approved** Admin deletion of the listed ids only (Zakat `zk_*`, Savings `sv_*` and all Savings / Zakat data preserved).
6. Set up the V6 accounts.
7. Post-check.

## Release blockers

1. Normal + Strict emulator runs and `rules:limits` on both logs (yours).
2. **Each existing Home's owner should run "Update default roles"** (template v7). The rules already enforce the policy without it.
3. `walletMovements` create has 6 points of headroom: slim it before adding movement types.
