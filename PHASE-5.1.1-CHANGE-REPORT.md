# HomeHub V5 — Phase 5.1.1 Rules & Test-Suite Repair: change report

**Version:** 5.5.2 • **Scope:** `firestore.rules`, `tests/rules/rules.test.mjs`, static tests, docs.
**No application code, data structure, or production deployment changed.** No legacy business data is touched.

## Honest status of verification

| Check | Status in the build environment |
|---|---|
| Real Firestore emulator (`npm run test:rules`) | **REQUIRES FIREBASE EMULATOR RERUN.** It could not run here: no network, so `firebase-tools` and the emulator JAR cannot be downloaded (Java 21 *is* present). The emulator log referenced in the request was **not attached** (uploads contained only the old V4 ZIP and the 5.1 brief), so failures were diagnosed from the source code, not mapped one-by-one to the log. |
| Offline JS check of the rules test file (`npm run test:rules:smoke`, new) | **PASS**: 82/83. The only failure is L14, which needs real rule enforcement. Rules are *not* evaluated by this check. |
| Unit + static (`npm test`) | **PASS**: 231/231, including 2 new regression guards |
| Browser E2E | **PASS**: see TESTING.md (repeated and from the clean unzip) |

Do **not** treat this package as accepted until `npm run test:rules` shows zero failures on your machine. If anything still fails, send the full emulator output; it is the authoritative report.

## Defects found and fixed

### 1. Unsupported list addition in rules (**security-relevant; production defect**)

Firestore Rules lists do not support `+`; it raises an evaluation error, so the request is denied. There were five occurrences:

| Line (5.1) | Rule | Legitimate operations that were being denied |
|---|---|---|
| 219 | `access2`: `(rd(A) + rd(B)).toSet()` | Transfers / funding involving a personal (private/shared) wallet |
| 810, 839 | wallets create/update: `([ownerUid] + sharedWith).toSet()` | Creating any personal wallet (own, shared, **child allowance**); sharing / un-sharing |
| 1131, 1155 | savingsAssets create/update: same form | Creating any personal savings asset; sharing / un-sharing (incl. child savings) |

- **Fix:** `.concat()` (`rd(A).concat(rd(B))`, `[ownerUid].concat(sharedWith)`). The semantics are identical: same set equality, same readers.
- **Why tests missed it:** browser E2E uses an SDK stand-in that does not evaluate rules, and a static test pinned the *buggy* text. That test now pins the correct form, and a new guard fails if list `+` reappears. The guard catches 4 of the 5 shipped occurrences by syntax; the fifth (`rd(A) + rd(B)`) is asserted explicitly in its corrected form.
- **Security:** not weakened. These paths were *over*-denying. The privacy conditions (readers = owner + sharedWith exactly; household vs restricted) are unchanged.

### 2. Missing `assert` import in `tests/rules/rules.test.mjs`

Phase 5/5.1 tests call `assert.equal` / `assert.deepEqual`, but `assert` was never imported, so those tests failed with a `ReferenceError`. **Fixed:** `import assert from 'node:assert/strict'`. **Measured** with the offline check: the shipped file failed 2 tests from this cause.

### 3. Write batches mixing Firestore instances (the "Firestore initialization" failures)

`env.authenticatedContext(uid).firestore()` returns a **new** Firestore instance on every call. The helper `svRef()` called `db(user)` again for every reference, so the tests "5 events", "5 wallet ↔ savings" and "5 zakat" built batches with references from different instances. The SDK rejects those ("Provided document reference is from a different Firestore instance") before any rule runs.

**Fix:** `db(user)` returns one cached instance per account. **Measured** with the offline check: 3 tests failed from this cause in the shipped file, and 0 after the fix. It also reduces emulator load: one instance per account instead of one per call.

### 4. Expression-limit (1000) headroom: hot paths evaluated once

Rules functions re-evaluate their body on every call. The hottest helpers re-read the same documents repeatedly. **Fix:** each document is evaluated once and passed as a parameter. Every condition is unchanged; this is pure parameter binding.

| Helper / rule | Before | After |
|---|---|---|
| `can(h, ns, action)` (52 call sites) | Membership read 2×, role read 2× | `canWith(h, myMember(h), …)`: membership 1×, role existence + permissions |
| `expenseWalletOk` / `access1` | Wallet re-read 3–4× | `expenseWalletOkW(h, d, W)` / `accessW(d, W)`: once |
| `savingsEvents` create | Asset re-read 5× (plus helpers) | `savingsEventCreateOk(h, eventId, d, A)`: once |
| `joinsByInvite` | Invitation re-read 8× | `joinsByInviteI(h, u, d, I)`: once |

A static test pins these bound-once forms. **Whether every 1000-expression warning in your log is gone can only be confirmed by the emulator rerun.** If one remains, its log line names the rule; send it and that path gets the same treatment.

### 5. "Undefined fields" in rules

Membership documents created by setup have no `relationship` / `guardianUids`. Every rule that reads them uses `.get(field, default)` (`isChildMember`, `isGuardianOf`, the wallet child check, legacy adoption) or sits in an `||` whose other branch decides. Nothing else read a possibly-missing field without a guard. **No change needed;** confirmed by inspection, and to be confirmed by the emulator.

## Mapping to the reported 21 failures (to verify with the emulator)

The log was not available, so this is a source-based attribution, not a log mapping:

- **Missing `assert`:** 2 tests (measured).
- **Cross-instance batches:** 3 tests (measured).
- **List addition:** every test that creates or shares a personal wallet or personal savings asset, or transfers via one. That is the Phase 4 wallet and 4A family-finance privacy tests and the Phase 5 savings privacy, child and event tests. This class plausibly accounts for most of the remaining ~16.
- **Expression limit:** event/expense/invitation paths; mitigated as above.

## Files changed

- `firestore.rules`: the list `+` → `.concat()` fixes (5); the bound-once helpers (`canWith`, `accessW`, `expenseWalletOkW`, `savingsEventCreateOk`, `joinsByInviteI`). No rule was widened.
- `tests/rules/rules.test.mjs`: the `assert` import; `db()` caches one instance per account.
- `tests/static/static.test.mjs`: two new guards (no list `+`; bound-once hot paths).
- `tests/static/finance-static.test.mjs`, `tests/static/family-static.test.mjs`: assertions updated from the old text to the corrected and bound forms (same security meaning).
- `tests/rules-smoke/` (**new**) and `package.json` `test:rules:smoke`: the offline JS check of the rules test file.
- Docs: this report, TESTING.md, SECURITY.md, CHANGELOG.md, PROJECT-STATE.md; version 5.5.2.

## How to verify on your machine

```bash
npm test                    # unit + static (expect 231/231)
npm run test:rules:smoke    # offline JS check of the rules tests (expect OK; L14 needs real rules)
npm run test:rules          # REAL emulator (needs Java + network once): expect 83/83, zero failures
npm run test:e2e            # browser regression
```

Do **not** deploy until `npm run test:rules` is clean. Deployment stays manual: `firebase deploy --only firestore:rules`.
