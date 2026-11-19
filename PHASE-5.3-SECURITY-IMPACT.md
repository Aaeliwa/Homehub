# HomeHub V5 — Phase 5.3 Security Impact (rules, permissions, privacy, evaluation cost)

**Version:** 5.7.0 • **Status: NOT APPROVED FOR DEPLOYMENT** until the real emulator passes `npm run test:rules` and `npm run test:rules:strict` (101 tests each). Neither could run in the build environment (no network for the emulator). **Nothing was deployed; no production data was touched.**

## 1. Rule changes (generated: `npm run rules:compare`, 5.2.1 → 5.3)
## Functions
- Added (16): cyclePath, budgetAdjPath, budgetAdjOk, cleanTaskPath, cleanOccPath, cleanLogPath, cleanRecurrenceOk, cleanTaskContentOk, cleanMayAct, cleanDateOk, cleanLogOk, cleanLogMatches, cleanClaimFields, cleanCompleteFields, cleanClearedFields, cleanOccUpdateOk
- Removed (0): —
- Changed (0): —

## Match paths
- Added (4): `/databases/{database}/documents/homes/{h}/budgetAdjustments/{adjId}`, `/databases/{database}/documents/homes/{h}/cleaningTasks/{taskId}`, `/databases/{database}/documents/homes/{h}/cleaningOccurrences/{occId}`, `/databases/{database}/documents/homes/{h}/cleaningLog/{logId}`
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/spendingCycles/{cycleId}`: changed update


**No existing rule was widened.** The only changed existing rule is the `spendingCycles` update, and it is **narrowed** (see §2). Every other existing `match` / `allow` is byte-identical.

## 2. Edit active budget

**Before (5.2.1):** an unused path allowed changing `budgetMinor`, `endDate` and `days` on an active cycle (budget > 0), with **no audit record**.

**Now:** that path is **replaced** by an amount-only, audited edit. Changing the dates or duration is therefore no longer possible at all. No client used that path, the deployed 5.1.3 app included.

The `spendingCycles` update has three **exclusive** branches (dispatch):

| Branch | Discriminator | Conditions |
|---|---|---|
| Edit budget | `budgetRevision` changes | Cycle active. Only `budgetMinor`, `budgetRevision`, `updatedBy`, `updatedAt` change. Amount is a non-negative integer and different. Revision = stored + 1. `manageBudgets` on the cycle's wallet. The adjustment record `{cycleId}_r{rev}` exists after the batch. |
| Close | `status` changes | Unchanged from 5.2.1 |
| Re-label | otherwise | Unchanged from 5.2.1 |

`budgetAdjustments/{cycleId}_r{n}` is **append-only** (update/delete denied):
- It is created only in the batch that moves its cycle from revision n−1 to n.
- `budgetAdjOk(d, Before, After)` proves that old = **stored** amount, new = the cycle's new amount, and delta = new − old.
- Editor = caller, time = server time, and currency, wallet, `audience` and `readers` equal the cycle's.
- Reads use `canReadFinance`, so a **private** cycle's history is visible only to its readers. The Home owner has no implicit access.

| Threat | Result |
|---|---|
| Stale / concurrent edit | Refused: the revision and stored amount must match (test B3). The client shows "someone changed this budget". |
| Forged editor, delta, id or labels | Refused (B5) |
| Viewer, other Home, another adult's private wallet | Refused (B6) |
| Closed cycle | Refused (B5) |
| Changing dates, duration, currency or wallet through an edit | Refused (B4) |
| Wallet balances, expenses, movements | Not touched. The rules for those collections are unchanged and the edit batch writes only the cycle and the adjustment (unit test + B-UI). |

## 3. Home Routine & Cleaning

**Permissions (seeded since Phase 1; no template change):**

| Permission | Default roles |
|---|---|
| `cleaning.view` | admin, member, viewer, child |
| `cleaning.create` / `cleaning.edit` | admin, member |
| `cleaning.delete` (archive / restore) | admin |
| `cleaning.complete` | admin, member, child |

**Tasks (`cleaningTasks`):**
- **Read:** members with `view`.
- **Create:** requires `create`; exact keys; validated content.
  - Assignees and eligible members are members of this Home (at most 5).
  - Recurrence shape is strict.
  - The room must be an active room of this Home.
  - The creator is the caller.
- **Update:** dispatches on whether `active` changes.
  - Archive / restore requires `delete`.
  - Content edits require `edit` and only work on active tasks; the room is checked only when it changes.
- **Delete:** denied.

**Occurrences (`cleaningOccurrences/{taskId}_{YYYYMMDD}`):**
- **Read:** members with `view`.
- **Create** (rev 1): the ID must match the task and date, and the date must lie in the task's range (for one-time tasks, exactly the due date). The caller must be able to act on the task. Claim or complete fields must name the caller with server time. The audit entry `_r1` must exist with the same action and actor.
- **Update:** revision +1, then dispatch on the new status:
  - **claimed:** from open, eligible;
  - **done:** from open (eligible), or from claimed (the claimant or `edit`);
  - **open from claimed:** the claimant or `edit`;
  - **open from done:** the completer, **a guardian of the completer**, or `edit`, with a reason in the audit entry.
- **Delete:** denied.

**Log (`cleaningLog/{occ}_r{n}`):** created only with the occurrence change of the same revision and actor (caller, server time). Update and delete are denied.

**Children:** "shared with everyone" means adult members. A child acts only when explicitly listed (assignee or eligible), and cannot create, edit or archive tasks.

**Cross-Home:** every path is under `homes/{h}` and requires active membership in `h` (C1, C5).

| Threat | Result |
|---|---|
| Two people claim the same date | The second create hits an existing id and is refused (C2). The UI shows "someone else got there first". |
| Completing / reopening without an audit trail | Refused (C2, C3) |
| Forged actor; revision skip | Refused (C2, C3) |
| Child acting on "everyone" or others' tasks | Refused (C4) |
| Viewer completing; member archiving | Refused (C1, C3) |
| Other Home / non-member | Refused (C1, C5) |

## 4. Privacy

- **Private wallets, savings, Zakat and their queries:** unchanged.
- **Budget history** follows its cycle's privacy (`audience` / `readers` copied and verified by the rules).
- **Cleaning** is household data visible to members with `cleaning.view`. It holds no financial or private data.

## 5. Rule-evaluation cost (worst-case exhaustive estimate, `npm run rules:cost`)
| allow | Worst-case cost (estimate) |
|---|---|
| `/homes/{h}/cleaningTasks/{taskId}` update | 629 |
| `/homes/{h}/cleaningTasks/{taskId}` create | 622 |
| `/homes/{h}/spendingCycles/{cycleId}` create | 499 |
| `/homes/{h}/cleaningOccurrences/{occId}` create | 490 |
| `/homes/{h}/cleaningOccurrences/{occId}` update | 344 |
| `/homes/{h}/spendingCycles/{cycleId}` update | 286 |
| `/homes/{h}/budgetAdjustments/{adjId}` create | 254 |
| `/homes/{h}/cleaningLog/{logId}` create | 204 |
| `/homes/{h}/spendingCycles/{cycleId}` get,list | 144 |
| `/homes/{h}/budgetAdjustments/{adjId}` get,list | 144 |
| `/homes/{h}/cleaningTasks/{taskId}` get,list | 85 |
| `/homes/{h}/cleaningOccurrences/{occId}` get,list | 85 |
| `/homes/{h}/cleaningLog/{logId}` get,list | 85 |
| `/homes/{h}/spendingCycles/{cycleId}` delete | 1 |
| `/homes/{h}/budgetAdjustments/{adjId}` update,delete | 1 |
| `/homes/{h}/cleaningTasks/{taskId}` delete | 1 |
| `/homes/{h}/cleaningOccurrences/{occId}` delete | 1 |
| `/homes/{h}/cleaningLog/{logId}` update,delete | 1 |

Every new or changed rule is well below the existing tripwires (any rule ≤ 1,100), and the dispatch pattern from Phase 5.2.1 is used throughout. All new denial tests use `assertDenied`, which fails if a denial was caused by the 1,000-expression limit.

## 6. Indexes
**None required.** Every new query uses one field:
- `budgetAdjustments`: `audience ==` / `readers array-contains`;
- `cleaningOccurrences`: `dueDate >=`;
- `cleaningLog`: `occurrenceId ==`.

## 7. Verification status

| Check | Result |
|---|---|
| Unit + static | **PASS** (258/258) |
| Browser E2E | **PASS** (107/107, from the clean unzip) |
| Real emulator (101: 90 baseline + B1–B6 + C1–C5), normal and strict | **UNVERIFIED** |
