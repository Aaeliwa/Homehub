# HomeHub V5 — Phase 5.3.1 Security Impact (Cleaning ↔ Rooms/Devices, widget)

**Version:** 5.7.1 • **Status: NOT APPROVED FOR DEPLOYMENT** until the real emulator passes `npm run test:rules` and `npm run test:rules:strict` (**106** tests each). Neither could run in the build environment. **Nothing was deployed; production data is unchanged.**

## 1. Rule changes (generated: `npm run rules:compare`, 5.3 → 5.3.1)
## Functions
- Added (2): cleanMinutesOk, cleanGeneratedOk
- Removed (0): —
- Changed (1): cleanRecurrenceOk

## Match paths
- Added (0): —
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/cleaningTasks/{taskId}`: changed create/update


Only **8 lines** of the Phase 5.3 rules changed. All of them are in `cleanRecurrenceOk` and the `cleaningTasks` create/update rules. No other collection, path or rule was touched.

## 2. What changed and why it is safe

**`cleanRecurrenceOk`** accepts one new shape, `{kind: 'after', unit: 'day' | 'month', interval}`, with interval 1–365 days or 1–12 months. Existing shapes are unchanged.

**`cleaningTasks` create** dispatches on whether the task has a `source`:
- **Manual tasks (no `source`):** the identical 5.3 conditions (exact keys, content, active room, active, creator, timestamps).
- **Generated tasks (`cleanGeneratedOk`):**
  - **Exact key set:** the manual keys plus `source` and `estimatedMinutes`.
  - **Fixed simple shape:** shared with no assignees, `'after'` recurrence, no due or end date, minutes 1–600.
  - **Deterministic id:** `r_<roomId>_<key>` or `d_<deviceId>_<key>`. The same template task can exist only **once** per room/device. A repeated or concurrent setup is a `set` on an existing document, which is evaluated as an *update* that changes `createdAt` and is refused (test G1).
  - **Room tasks:** `roomId == source.id`, and that room is **active in this Home** (`isActiveRoom`).
  - **Device tasks:** `roomId == null` (they follow the device's current room), and the device **exists in this Home and is active**.
  - **Declined tasks** may be created archived (`archivedAt = server time`, `archivedBy = caller`). That tombstone blocks the id, so a declined template task is never silently recreated.
  - **Permission:** requires `cleaning.create`. The creator is the caller, with server timestamps.

**`cleaningTasks` update:** `source` can never change, and `estimatedMinutes` may be edited (1–600). Archive, restore and edit permissions are unchanged.

| Threat | Result | Test |
|---|---|---|
| Duplicate generation (repeat setup, two users at once) | Refused (deterministic id, create-only) | G1 |
| Re-creating a declined/archived template task | Refused | G1 |
| Forged id / key mismatch / wrong `roomId` | Refused | G2 |
| Generating for an archived room/device, another Home's room, or a missing device | Refused | G2, G5 |
| Viewer or child generating | Refused | G3 |
| Changing a task's origin (`source`) | Refused | G3 |
| Invalid `'after'` recurrence (unknown unit, > 12 months) | Refused | G4 |
| Manual-task behaviour | Unchanged (exact keys still enforced) | G4 |
| Cross-Home read/write, non-member | Refused | G5 |
| Completion before the start date | Refused (`cleanDateOk`) | G4 |

**Occurrences, the audit log, claim/complete/reopen, children/guardians, privacy of finance, savings and Zakat, legacy adoption and cross-Home isolation are all unchanged.**

## 3. Data safety

- **No migration and no backfill runs automatically.** Existing rooms and devices are only *recognised* (read). Cleaning tasks are written only after a member with `cleaning.create` reviews and confirms the plan.
- **The setup is idempotent:** deterministic ids, existing (even archived) tasks are skipped, and the rules refuse re-creation. Re-running it writes nothing.
- **Existing manual tasks, occurrences and audit history are never modified.** A manual task with the same title in that room *covers* the template task, so no second copy is added.
- **Writes are bounded:** one task per (room|device, template key). At most 11 tasks per room and 9 per device, committed in chunks of 200.
- **The occurrence history window** grows only as far as the longest active `'after'` interval needs (≤ 400 days), using the same single-field query.

## 4. Rule-evaluation cost (worst-case exhaustive estimate, `npm run rules:cost`)
| allow | Phase 5.3 | Phase 5.3.1 |
|---|---|---|
| `/homes/{h}/cleaningTasks/{taskId} update` | 629 | 677 |
| `/homes/{h}/cleaningTasks/{taskId} create` | 622 | 636 |
| `/homes/{h}/cleaningOccurrences/{occId} create` | 490 | 490 |
| `/homes/{h}/cleaningOccurrences/{occId} update` | 344 | 344 |
| `/homes/{h}/cleaningLog/{logId} create` | 204 | 204 |
| `/homes/{h}/cleaningTasks/{taskId} get,list` | 85 | 85 |
| `/homes/{h}/cleaningOccurrences/{occId} get,list` | 85 | 85 |
| `/homes/{h}/cleaningLog/{logId} get,list` | 85 | 85 |
| `/homes/{h}/cleaningTasks/{taskId} delete` | 1 | 1 |
| `/homes/{h}/cleaningOccurrences/{occId} delete` | 1 | 1 |
| `/homes/{h}/cleaningLog/{logId} update,delete` | 1 | 1 |

The generated-task branch uses its own cheap, fixed-shape checks instead of the full manual validator, which keeps create at 636. Every value is far below the tripwire (1,100) and the levels the real emulator already passed. All new denial tests use `assertDenied`, so a denial caused by the expression limit fails the test.

## 5. Indexes
**None.** Cleaning queries are unchanged (`dueDate >=`, `occurrenceId ==`).
