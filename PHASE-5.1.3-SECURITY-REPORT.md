# HomeHub V5 — Phase 5.1.3 Security Report (final rules repair, local verification)

**Version:** 5.5.4 • **Status: NOT APPROVED FOR DEPLOYMENT.** The real emulator result for 5.1.3 is **UNVERIFIED** (it cannot run in the build environment: no network to install `firebase-tools` / the emulator). Nothing was deployed, no production data was touched, and no legacy adoption was executed.

**Inputs actually available:**
- your summary of the real-emulator run of 5.1.2 (83 tests: 81 passed, 2 failed, with the error locations);
- `emulator-result.txt` (the 5.1.1 run).

**Not received:** the 5.1.2 emulator log, and the production rules (`Pasted text(9).txt`). See `RULES-PROD-VS-5.1.3.md`.

## 1. Failure 1: private-finance query (`rules.test.mjs:541`, "false for 'list' @ L900")

- **Exact failing request:** Bob's own query `expenses where readers array-contains 'bob'` (expected to succeed).
- **Rule:** `expenses` read → `canReadFinance(h, resource.data)`.
- **Diagnosis.** Rules are not filters. For a query, the engine must *prove* the condition from the query's constraints alone. 5.1.2 had:
  - `d.get('audience','') == 'household' && …`: cleanly false for this query (no `audience` constraint). This is why the result was `false`, not 5.1.1's evaluation error.
  - `(d.readers is list && request.auth.uid in d.readers)`: the constraint `readers array-contains 'bob'` lets the engine prove `'bob' in readers`, but **not** that `readers is list`. So the branch is unprovable and the query is denied.

  Evidence: the `wallets` read rule uses plain `request.auth.uid in resource.data.readers`, and its query tests passed in your runs.
- **Fix:** drop `readers is list` in `canReadFinance` and `canReadSavings`, giving `request.auth.uid in d.readers`.
- **Security:**
  - For single-document reads, a missing or non-list `readers` makes `in` an evaluation error, which already means **deny**, so nothing is widened.
  - The Home owner and other adults are still not in `readers`, so they are denied for both get and query (asserted).
- **Same analysis applied to:**
  - `savingsAssets`, `savingsEvents`: `canReadSavings` had the same defect and is fixed.
  - `wallets`: already correct.
  - `zakatRecords`: plain `uid in resource.data.readers`, already correct.
  - `walletMovements`, `spendingCycles`, `commitments`: use `canReadFinance`, so fixed.
- **New regression test** (`5.1.3 "mine" queries…`): for all 8 private-capable collections, the wife's own `readers` query **succeeds** and the owner's query for the wife's records is **denied**. The household savings query succeeds for the owner; the child's household query is denied; an unconstrained list is denied.

## 2. Failure 2: invitation acceptance (`rules.test.mjs:743`)

- **Exact failing subcase:** **"expired" setup**, not an acceptance. The fixture computed `expiresAtMillis = Date.now() + 1` on the client, then wrote the invite. By evaluation time `request.time ≥ expiresAtMillis`, so the create rule (expiry must be in the future at creation) correctly **refused** it: "false for 'create' @ L336". The write was not inside an assertion, so it threw and aborted the test.
- **Consequence:** every later subcase **never ran**:
  - mutated role;
  - membership-without-accept and accept-without-membership (the half-batches);
  - forged `acceptedBy`;
  - cross-Home substitution;
  - member-cannot-cancel;
  - admin cancel and accept-after-cancel;
  - no delete;
  - no listing.

  The L336/L357 *evaluation errors* in the log belong to the denied single-use acceptance (as intended).
- **Classification: fixture bug; the rules are correct.**
- **Fix (no rule weakened):**
  1. Create a *valid* invite (asserted).
  2. Move `expiresAtMillis` into the past with rules disabled (= time passing).
  3. Assert that acceptance is **denied**. All later subcases now run, and the `j` invite write is also asserted.
- **New control test:** the same kind of invite is accepted before expiry, so "expired" is refused *only* because of expiry; creating an already-expired invite is refused.

## 3. 1000-expression limit

**What the evidence shows (5.1.1 log, mapped with the new `npm run rules:limits`):**

| Rule | Hits | All in passing tests? |
|---|---|---|
| `devices` update | 49 | yes |
| `members` create | 24 | yes |
| `members` update | 14 | yes |

A hit inside a passing test belongs to a request the test expected to be **denied**. "Harmless" is not assumed:
- **Security outcome:** a limit hit always denies, so it cannot grant access.
- **Masking risk (real):** such a denial may happen *because evaluation stopped*, not because of the intended condition. That would hide a rule that wrongly allows. So these branches must not run out of budget; they must fail on their discriminating condition.

**Changes so far:**
- **5.1.1:** helpers bind each document once (`canWith`, `accessW`, `expenseWalletOkW`, `savingsEventCreateOk`, `joinsByInviteI`).
- **5.1.2:** cheap discriminators first in `members` create/update and `devices` update.
- **5.1.3:** adoption roles use `isLegacyAdoptionCompanion` instead of re-running the full `isLegacyAdoption()` five times per adoption batch. The membership still proves it in full, and the batch is atomic.

**What I cannot claim:** that the 5.1.2 messages you saw are gone. **I did not receive the 5.1.2 log**, so I cannot name the remaining branches. Run:

```powershell
npm run test:rules *> emulator-5.1.3.txt
npm run rules:limits -- emulator-5.1.3.txt
```

and send both files. Any hit inside a **failing** test, or any hit in a test that asserts a denial, gets that exact branch reworked.

## 4. Critical protections

| Protection | Rule mechanism | Evidence |
|---|---|---|
| Legacy Home ID, memberships, custom roles, profiles, business history preserved | Adoption is create-only (members + missing system roles); the Home doc must be byte-identical (`getAfter == get`); no business rule is satisfiable in the batch | L1–L20 passed in your 5.1.1 and 5.1.2 runs; unit tests (byte-identical data) |
| No legacy takeover / owner promotion | Stored `createdBy` must equal the caller; there must be no prior owner role; owner can't be assigned via member edits or invites | L2, L4, L5, L10–L13; 4A role tests |
| One-time adoption | Membership and owner role exist afterwards, and both paths are create-only | L11, L12 |
| Owner cannot read another adult's private wallets / savings / assets / Zakat | Read requires `household` + view, or the caller in `readers`; the owner is not in `readers` | 5 CRITICAL, finance PRIVATE, new 5.1.3 "mine" test |
| Child / guardian boundaries | Guardian = explicit `guardianUids`; a child can't un-share | 4A child test; 5 child savings |
| Cross-Home isolation | All paths are under `homes/{h}`, with membership checked against `h` | Tenant / cross-Home tests |
| No role escalation / unauthorized financial changes | Rank checks; `can()`; label equality; `createdBy == auth.uid` | 4A roles; Phase 4/5 write tests |

## 5. Verification (exact counts)

| Suite | Result |
|---|---|
| `npm test` (unit + static) | **235/235 PASS** |
| `npm run test:rules:smoke` (offline stand-in: **not** a rules result) | No JavaScript-level failures in 85 tests |
| Browser E2E | See TESTING.md (all passing, from the clean unzip) |
| **`npm run test:rules` (REAL emulator, 85 tests incl. 2 new)** | **UNVERIFIED.** Not runnable here |

## 6. Local verification on Windows (PowerShell, from the `HomeHub-V5` folder)

```powershell
node --version          # 20 or 22 recommended (firebase-tools warns on 24)
java -version           # 11+ required by the Firestore emulator
npm test                                    # expect 235/235
npm run test:rules:smoke                    # expect "OK: no JavaScript-level failures"
npm run test:rules *> emulator-5.1.3.txt    # REAL emulator; expect 85/85 and no limit hits
Get-Content emulator-5.1.3.txt -Tail 15
npm run rules:limits -- emulator-5.1.3.txt  # maps any 1000-expression hits to rule + test
npm run rules:compare -- production.rules firestore.rules --md RULES-PROD-VS-5.1.3.generated.md
npm run test:e2e                            # browser regression (needs Playwright/Chromium)
```

**Deployment gate** (all three required):
1. Real emulator 85/85 with zero limit hits in failing tests.
2. The production comparison is generated and reviewed.
3. No open critical item.

Until then: **do not deploy**.
