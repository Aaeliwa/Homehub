# HomeHub V5 — Phase 5.1.2 Rules Report (local verification before any deployment)

**Version:** 5.5.3 • **Inputs:** your emulator run of the 5.1.1 package (`emulator-result.txt`: 83 tests, 68 passed, 15 failed, 86 × "maximum of 1000 expressions") and the 5.1.1 ZIP. **Nothing was deployed; production was not touched.**

## 0. Production rules baseline: NOT RECEIVED

The production rules file referred to as `Pasted text(9).txt` **was not in the uploads**; only `emulator-result.txt` arrived. So:

- **The production-to-5.1.2 comparison and deployment impact assessment are PENDING.** No conclusions about production are made in this report.
- **To produce the comparison on your machine** (no network needed), save the production rules from the Firebase console as `production.rules`, then run:

  ```bash
  npm run rules:compare -- production.rules firestore.rules --md RULES-PROD-VS-5.1.2.md
  ```

  It lists functions, `match` paths and per-path `allow` statements added, removed or changed. Comments and whitespace are ignored. It is validated: it reports exactly the known 5.1.1 → 5.1.2 changes (Section 4).
- **Or send me the file:** I will write the full functional and security comparison and the deployment impact assessment from it, without changing any production permission unless a verified defect requires it.
- **What to look for in that comparison:**
  - collections that production serves today but 5.1.2 lacks; these would become **denied** after deployment;
  - production paths that read older-format fields;
  - any broad production rule (a catch-all, or `if true`). 5.1.2 has none, so removing it would deny clients that depended on it.

**Earlier evidence (not proof):** your "ليست لديك صلاحية" screen in Phase 5.1 is consistent with production running rules older than Phase 5.

## 1. The 15 emulator failures: three root causes

| # | Tests | Root cause (from your log) | Fix | Verified by |
|---|---|---|---|---|
| A | 10: the 4A child-wallet test and all nine Phase 5 tests | `context.firestore()` called **twice** in one `withSecurityRulesDisabled` callback → "Firestore has already been started and its settings can no longer be changed" | Bind `c.firestore()` once per callback (2 callbacks) | Offline stand-in, which now reproduces the real library behaviour and your exact failure list |
| B | 4: invitation create/escalation/accept tests | `withSecurityRulesDisabled()` **resolves to undefined**, not the callback's value, so `homeName` was `undefined` (SDK "invalid data"). A second use in "accept: valid" was hidden behind it | Capture values inside the callback (2 places) | Same |
| C | 1: "finance: PRIVATE wallet…" | **Production-relevant rules defect.** In a *query*, rules see only the query's constraints. For the "mine" query (`readers array-contains me`), `canReadFinance` read the unconstrained `audience` → "Property audience is undefined" → **the whole query is denied**. The app's own "mine" listeners use this query, so private finance and a child's Finance would fail | Read the optional field with `.get('audience', '')` (and `visibility` for wallets and savings assets), in `canReadFinance`, `canReadSavings`, and the `wallets` / `savingsAssets` reads. The `readers` check keeps its proven form | Rules change. **Confirm with the emulator rerun** |

Offline stand-in, measured: the 5.1.1 test file → **14 failures** (exactly A + B as in your log); the 5.1.2 file → 0 (only L14, which needs real rules enforcement, remains).

## 2. 1000-expression limit: analysis and changes

All 86 occurrences in your log were in **requests that the tests expect to be denied** (bootstrap misuse, adoption attacks, escalation, invalid device edits). No legitimate operation failed from it, and hitting the limit always **denies**.

| Rule (5.1.1 line) | Hits | Change (headroom) |
|---|---|---|
| devices update (791) | 49 | Each path starts with its cheap discriminator (`active` state, changed keys) before `can()` |
| members create (558) | 24 | Each path starts with its own disjoint key set (adoption also checks `legacyAdoption == true`); the invite path proves the invite exists before reading `createdBy` |
| members update (598) | 14 | Each path starts with `changed().hasOnly([...])` (plus the target status) before `can()` and rank lookups |

These are **conjunct reorderings only**: every condition must still hold, so no access is widened. Combined with 5.1.1's bound-once helpers, denied requests now exit early. **Confirm with the rerun that no 1000-expression line remains.** If one does, the log names the rule.

## 3. Protection confirmed by your emulator run (5.1.1), unchanged in 5.1.2

Passed in your run: all Legacy Home Adoption tests (L1–L20), bootstrap and takeover tests, role escalation, members, rooms, devices, tenant isolation, and the finance and 4A tests not listed above. 5.1.2 does not alter those rules except the reorderings above. **The privacy and savings tests (Phase 5) never reached the rules** because of fixture failure A; they are expected to run for the first time in your rerun.

## 4. Rules comparisons (generated with `npm run rules:compare`)

### 5.1.1 (your emulator run) → 5.1.2
## Functions
- Added (0): —
- Removed (0): —
- Changed (2): canReadFinance, canReadSavings

## Match paths
- Added (0): —
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/members/{u}`: changed create/update
- `/databases/{database}/documents/homes/{h}/devices/{deviceId}`: changed update
- `/databases/{database}/documents/homes/{h}/wallets/{walletId}`: changed get/list
- `/databases/{database}/documents/homes/{h}/savingsAssets/{assetId}`: changed get/list


### 5.1 (Phase 5.1 ZIP) → 5.1.2
## Functions
- Added (5): canWith, accessW, expenseWalletOkW, joinsByInviteI, savingsEventCreateOk
- Removed (0): —
- Changed (7): can, canReadFinance, access1, access2, expenseWalletOk, joinsByInvite, canReadSavings

## Match paths
- Added (0): —
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/members/{u}`: changed create/update
- `/databases/{database}/documents/homes/{h}/devices/{deviceId}`: changed update
- `/databases/{database}/documents/homes/{h}/wallets/{walletId}`: changed get/list/create/update
- `/databases/{database}/documents/homes/{h}/savingsAssets/{assetId}`: changed get/list/create/update
- `/databases/{database}/documents/homes/{h}/savingsEvents/{eventId}`: changed create


No `match` path was added or removed; no rule was widened; there is no catch-all.

## 5. Verification status

| Check | Result |
|---|---|
| `npm test` (unit + static) | **PASS** (see TESTING.md) |
| `npm run test:rules:smoke` (offline; rules not evaluated) | **PASS**: no JavaScript-level failures |
| Browser E2E | **PASS** (see TESTING.md) |
| `npm run test:rules` (real emulator) | **REQUIRES YOUR RERUN**: cannot run here (no network for `firebase-tools` / the emulator) |
| Production comparison and deployment impact | **PENDING**: production rules file not received |

**Do not deploy** until `npm run test:rules` reports 83/83 with no 1000-expression lines, and the production comparison has been reviewed.
