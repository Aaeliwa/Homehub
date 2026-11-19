# HomeHub V5 — Phase 5.2.1: Rule-Evaluation Repair (security impact report)

**Version:** 5.6.1 • **Status: DO NOT DEPLOY** until BOTH `npm run test:rules` and `npm run test:rules:strict` pass 90/90 on the real emulator, with no expression-limit denial. Neither could run here (no network for the emulator). **Nothing was deployed; no production data was touched.**

## 1. Input
Your real run of Phase 5.2 gave **89/90**. The failing test was **Z6/Z7 "dangling snapshotId"**: `maximum of 1000 expressions … create @ L1263`, plus an evaluation error at `update @ L1312:26`. Other negative tests that pass also logged limit messages.

## 2. Root cause
1. **Not overlapping rules.** Every collection has exactly one `match` block, so no second rule set applies to `zakatRecords` (verified by listing all 18 `match` statements).
2. **Denied requests are evaluated exhaustively.** In every emulator log so far, all expression-limit messages came from requests that ended **denied**, while legitimate requests doing *more* work on the same rules passed: a valid linked payment adds `getAfter()` reads and passes, while the dangling one fails. On a denial the evaluation behaves exhaustively: every alternative of each `A || B || C` chain is evaluated, every helper is evaluated in full at each call, and for a create on a new document the `update` rule is evaluated too (your L1312 error). **That is also why the 5.1.2/5.1.3 approach of reordering conditions could not work:** ordering only helps if evaluation stops early.
3. **Expensive helpers.** `can()` (about 88 expressions per call) was called repeatedly, including inside `mayUseWallet` / `mayUseAsset`. Content validators cost about 240–430 each. Multi-path rules therefore evaluated several full validations on every denial.

**Measurement:** the new `tools/rules-cost.mjs` (`npm run rules:cost`) computes an *exhaustive worst-case estimate* per `allow`:
- user functions inlined at each call;
- `&&` / `||` count both sides;
- a ternary counts one branch.

Its ranking matched the real logs. Members create, members update and devices update, which hit the limit in real runs, were all near the top. The Zakat create (957) plus the evaluated update together exceeded 1,000.

## 3. Fixes and why each is logically equivalent

**A. Dispatch instead of "try every path."** `(A) || (B) || (C)` becomes `d ? (A) : (B || C)`.

This is equivalent whenever *d* is implied by A's own conditions and contradicted by B's and C's. Where two paths can both accept the same request, both are kept together. Branch texts were reused **verbatim** via a mechanical split; no condition was retyped.

| Rule | Discriminator | Why the discriminator selects exactly the paths that could pass |
|---|---|---|
| `zakatRecords` create | `kind` | profile / snapshot / payment are mutually exclusive values |
| `walletMovements` create | `type` | funding / transfer / savings / adjustment are mutually exclusive; the key-set check dispatches on `savings` exactly as before |
| `walletMovements` update | status changed? | void requires a status change; re-label forbids it |
| `members` create | `'legacyAdoption'` key → adoption; `'inviteCode'` key → invite; else bootstrap | the three exact key sets are disjoint |
| `members` update | stored status removed/left → rejoin; new status `removed` → remove; `left` → leave; other status change → manager; `guardianUids` / `roleId` / `displayName` changed → guardians / manager / self; **otherwise self ∥ manager ∥ guardians (kept)** | each test is implied by exactly one path's own conditions (see the comment in the rules) |
| `expenses` create | `source == 'app'` | app vs import are exclusive |
| `expenses` update | status changed → void/restore; only labels changed → **re-label ∥ edit (both kept)**; else edit | void needs a status change; the edit and re-label key sets overlap only on labels |
| `commitments` update | `lastPaidDate` changed → pay; labels only → **re-label ∥ edit**; due-date fields only → **edit ∥ pay**; else edit | `lastPaidDate` is changeable only by pay; overlaps kept |
| `savingsAssets` / `wallets` create & update | `scope` (incoming for create, stored for update) | home vs personal are exclusive, and scope is immutable on update |
| `devices` update | `active` changed → archive / restore by stored state; else edit | edit forbids changing `active` |

**B. Cheaper helpers (same truth table):**
- **Permission check:** `can()` builds the role path once (`roleGrants`). `grants()` uses `perms.hasAny(['*', ns + '.*', ns + '.' + action])` instead of three `in` scans.
- **Zakat create:** `(owner && can) || (guardian && can)` becomes `can && (owner || guardian)`, which is algebraically identical with one `can()` call.
- **Bound once:** the referenced calculation / linked expense in a Zakat payment, the wallets in movements (`mvTransferW(h, d, A, B)`, `mvUseW`), and "exactly one wallet side" (`oneOf`, identical to `(a == null) != (b == null)`).
- **Old/new wallet in edits:** when it is the same wallet (`resource.walletId == incoming.walletId`), the new-wallet check already contains the old-wallet check (same existence and permission), so it is evaluated once. When the wallet changes, both checks remain.

**C. Strict mode for the entire suite.** `npm run test:rules:strict` (cross-platform launcher) sets `STRICT_DENIALS=1`. Every `assertFails` in `tests/rules/rules.test.mjs` then becomes `assertDenied`, which **fails** if the denial message shows the 1000-expression limit. All privacy denials already use `assertDenied` in normal mode.

## 4. Worst-case cost estimate (before → after)

The estimate is exhaustive and conservative. A real request evaluates only the dispatched branch.

| allow | Phase 5.2 | Phase 5.2.1 |
|---|---|---|
| `/homes/{h}/walletMovements/{movementId} create` | 1618 | 709 |
| `/homes/{h}/members/{u} update` | 1348 | 847 |
| `/homes/{h}/expenses/{expenseId} update` | 1222 | 969 |
| `/homes/{h}/commitments/{commitmentId} update` | 1110 | 1026 |
| `/homes/{h}/zakatRecords/{recordId} create` | 957 | 557 |
| `/homes/{h}/expenses/{expenseId} create` | 943 | 690 |
| `/homes/{h}/savingsAssets/{assetId} create` | 921 | 774 |
| `/homes/{h}/savingsAssets/{assetId} update` | 921 | 796 |
| `/homes/{h}/members/{u} create` | 882 | 376 |
| `/homes/{h}/wallets/{walletId} update` | 815 | 548 |
| `/homes/{h}/devices/{deviceId} update` | 808 | 478 |
| `/homes/{h}/wallets/{walletId} create` | 694 | 555 |
| `/homes/{h}/rooms/{roomId} update` | 628 | 607 |
| `/homes/{h}/commitments/{commitmentId} create` | 628 | 621 |
| `/invites/{code} create` | 622 | 615 |
| `/homes/{h}/spendingCycles/{cycleId} update` | 605 | 591 |
| `/homes/{h}/devices/{deviceId} create` | 523 | 516 |
| `/homes/{h}/spendingCycles/{cycleId} create` | 506 | 499 |
| `/homes/{h}/walletMovements/{movementId} update` | 490 | 336 |
| `/homes/{h}/savingsEvents/{eventId} create` | 476 | 469 |

The remaining highest figures (`commitments` / `expenses` update, about 1,000) are the worst case of an edit that **moves the record to a different wallet** with full re-validation. They come from a kept `||` (where two paths can both accept) or from the wallet-change branch. Ordinary edits, and every denial test in the suite, take a single, much cheaper branch. If your strict run still flags one of them, `npm run rules:limits` will name it and that path gets the next reduction.

## 5. Protections: unchanged
- **Private finance / savings / Zakat.** The read rules (`canReadFinance`, `canReadSavings`, `uid in readers`) are untouched, and the Home owner gets no implicit access.
- **Zakat sharing / revocation.** The update path (readers only; owner or guardian; guardians retained) is untouched. Same-owner calculation linking is preserved (now via `zakatSnapshotOfOwner`, same conditions).
- **Legacy Home adoption (L1–L20).** `isLegacyAdoption` and the companion are untouched. Members create only dispatches between the three existing paths.
- **Roles, escalation, guardians, cross-Home isolation.** All the same conditions apply. No `match` path was added or removed, and there is no catch-all.

## 6. Changed files
See `PHASE-5.2.1-CHANGED-FILES.txt` (generated against the Phase 5.2 ZIP).

## 7. Verification here
| Check | Result |
|---|---|
| `npm test` (unit + static, incl. cost tripwires) | **242/242 PASS** |
| `npm run test:rules:smoke` (offline; rules NOT evaluated) | No JavaScript-level failures (90 tests) |
| Browser E2E | see TESTING.md |
| `npm run test:rules` / `npm run test:rules:strict` (REAL emulator) | **UNVERIFIED.** Required: 90/90 and 90/90 |

## 8. Your commands (PowerShell, `HomeHub-V5` folder)
```powershell
npm test
npm run test:rules        *> emulator-normal.txt
npm run test:rules:strict *> emulator-strict.txt
npm run rules:limits -- emulator-normal.txt
npm run rules:limits -- emulator-strict.txt
```
**Acceptance:** both runs 90/90, and `rules:limits` shows no hit inside a failing test. Until then, **do not deploy**.
