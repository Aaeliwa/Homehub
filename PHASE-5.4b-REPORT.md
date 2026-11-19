# HomeHub V5 — Phase 5.4b Report: Device Usage and Seasonal Cleaning

**Version:** 5.8.1 • **Baseline:** v5.8.0 (your upload, byte-identical to the delivered package; your runs: 114/114 Normal and Strict).

**Confirmation: no production data was changed, no migration was run, nothing was deployed, and no `hr_*` data was touched.** Phase 5.4c was not started.

The design review is in **PHASE-5.4b-DESIGN.md** (included).

## 1. Architecture

- **Devices stay authoritative and untouched** (`homes/{h}/devices`, exact-keys rules, owned by the Devices module). Cleaning references a device **by id**; the rules verify with `get()` that it exists, is `active`, and belongs to the **same Home**.
- **One task store:** device-triggered tasks are ordinary `cleaningTasks` with an optional, **immutable** `trigger`.
- **One completion store:** `cleaningOccurrences` + the append-only `cleaningLog`. Done, claim, skip, postpone, resume and reopen work identically in Basic and Advanced.
- **Derived status, never stored:**
  - "pending after use" = non-voided uses since the task's last completion;
  - "seasonal active" = the device's season state.

  Every member and refresh therefore computes the same answer from Firestore.

## 2. Schema (all under `homes/{h}/`)

| Path | Shape | Write model |
|---|---|---|
| `cleaningDeviceEvents/{eventId}` | `{deviceId, kind: 'use' \| 'void', voidsEventId, note ≤ 200, actorUid, at, schemaVersion}` | Append-only. `use` ids are generated once per attempt (a retry reuses them, so no duplicates); `void` id = `<eventId>_void` (at most one). |
| `cleaningDeviceState/{deviceId}` | `{state: 'active' \| 'inactive', rev, updatedBy, updatedAt, schemaVersion}` | rev n → n+1 only, together with its season entry; no no-op toggles |
| `cleaningDeviceSeasons/{deviceId}_s{rev}` | `{deviceId, rev, state, note, actorUid, at, schemaVersion}` | Append-only; written in the same batch as the state change |
| `cleaningTasks` (existing) | + optional immutable `trigger`: `{kind: 'afterUse', deviceId}` or `{kind: 'seasonal', deviceId, phase: 'active' \| 'start' \| 'end'}`; + recurrence kinds `onUse`, `onSeason` | — |
| `cleaningOccurrences` (existing) | + optional immutable `triggerEventId` / `triggerSeasonRev`; ids `<task>_u<eventId>` / `<task>_s<rev>` (date ids unchanged) | — |

**Indexes:** none (single-field queries only). Older tasks, occurrences and logs are unchanged and remain valid.

## 3. Behaviour (decisions and conservative defaults)

**After use:**
- Every non-voided use after the task's last completion makes it due.
- Uses **coalesce** into one occurrence keyed by the **first** pending use, so the key is the same for every member. The card shows "Used N× since last cleaning".
- **Done** resolves it; the next use starts a new occurrence. Each use stays in history.
- A device event **never** marks anything complete.
- Uses before the task's start date don't count; dates follow the Home time zone.

**Corrections:** a **void** event (new, audited, once per use). Nothing is deleted.

**Seasons:**
- A device with no state document is **off-season** (conservative).
- In-season periodic tasks appear only while the device is active. Their due date is clamped to the activation day; the recurrence basis is unchanged.
- Off-season hides them; reactivating shows them again. Nothing is deleted or reset.
- Start/end checklists are due once per transition (`_s1`, `_s2`, …).

**Concurrency:**
- Concurrent toggles: exactly one wins (revision check); the other user gets "someone changed this just now".
- Repeated clicks or retries of "Log use" reuse the same id.

**Skip / postpone / resume:** unchanged semantics. They are never a completion and never advance a completion clock.

**Routine:**
- The saved plan stays stable. Device items that become due later show as "N new tasks due today" (Advanced) and appear in Basic.
- Device items that were in the plan keep their exact occurrence id.

**Templates:** the standalone app's deferred device templates are now generatable **with their original keys**:
- 12 after-use / after-cycle tasks;
- 16 AC tasks (4 in-season periodic, 8 season-start, 4 season-end).

Still deferred: 4 (condition-based ×2, manual ×2). Existing households see these as **new suggestions in the review banner**; nothing is written without confirmation.

## 4. Permission matrix

| Action | Owner / Admin | Member | Child | Viewer | Other Home |
|---|---|---|---|---|---|
| Read events, states, seasons | ✔ | ✔ | ✔ | ✔ | ✘ |
| Log a use / correct a use | ✔ | ✔ | ✔ | ✘ | ✘ |
| Change season | ✔ | ✔ | ✘ | ✘ | ✘ |
| Create device tasks | ✔ | ✔ | ✘ | ✘ | ✘ |
| Complete device tasks | as other tasks (claim / eligibility) | | | | ✘ |

## 5. Rules changes (generated: `npm run rules:compare`, 5.8.0 → 5.8.1)
## Functions
- Added (9): cleanDevicePath, cleanEventPath, cleanStatePath, cleanSeasonPath, cleanActiveDevice, cleanTriggerOk, cleanOccIdOk, cleanUseOf, cleanSeasonEntryOk
- Removed (0): —
- Changed (2): cleanRecurrenceOk, cleanGeneratedOk

## Match paths
- Added (3): `/databases/{database}/documents/homes/{h}/cleaningDeviceEvents/{eventId}`, `/databases/{database}/documents/homes/{h}/cleaningDeviceState/{deviceId}`, `/databases/{database}/documents/homes/{h}/cleaningDeviceSeasons/{entryId}`
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/cleaningTasks/{taskId}`: changed create/update
- `/databases/{database}/documents/homes/{h}/cleaningOccurrences/{occId}`: changed create


**Protected rules (verified byte-for-byte against v5.8.0):** all 18 Finance, Savings, Zakat, membership, roles, invites, users, devices, rooms and settings blocks are **identical**. The only other differences are the two enclosing blocks, which now contain the three new cleaning collections.

**Worst-case cost (exhaustive estimate):** task create 760, task update 704, occurrence create 700, occurrence update 537; device state 253, events 246, seasons 164. All are below the 1,100 tripwire.

## 6. Tests

| Suite | Command | Result in the build environment |
|---|---|---|
| Unit + static | `npm test` | **290/290 PASS** (+9 device tests) |
| Browser E2E | `npm run test:e2e` | **112/112 PASS** (+ DEV-UI; repeated from the clean unzip) |
| Offline rules-file check (NOT a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (119 tests) |
| **REAL emulator, Normal** | see §7 | **NOT EXECUTED HERE** (no network for the emulator). **Expected 119/119** (114 baseline + D1–D5). |
| **REAL emulator, Strict** | see §7 | **NOT EXECUTED HERE. Expected 119/119.** |

**New tests:**

*Unit (9):*
- after-use: due on use, coalescing, Done resolves, next use starts a new occurrence, voided and pre-start uses ignored, time zone, skip/postpone;
- seasons: off-season by default, clamp to activation with the basis unchanged, start/end per transition;
- routine with device ids; 66/70 templates, all payloads pass the rules mirror; manual trigger validation;
- store: device listeners only when needed, idempotent use, single void, season revisions, stale toggle refused.

*Emulator (5):*
- **D1:** usage events: duplicate id, viewer, archived / other-Home device, forged actor, client time, note length, id format, immutable, cross-Home.
- **D2:** void: once, same device, must target an existing use, cannot void a void, original kept.
- **D3:** seasons: entry required, editors only, archived device, mismatched entry, no-op, stale and concurrent toggles, entry on its own, no deletes, cross-Home.
- **D4:** triggered tasks: valid shapes, device of this Home, immutable trigger, real generated payloads accepted, trigger ≠ source refused.
- **D5:** occurrences: event / season proofs, id match, resolved once, wrong season state, **no date-keyed occurrence for event tasks**.

**Emulator test H1** now asserts that all **125** real setup payloads (incl. AC seasonal and usage tasks) are accepted one per write.

*Browser (DEV-UI):* off-season hidden; a failed save, then a retry with the same id (no duplicate); 3 uses = one item; Done in Basic resolves the exact occurrence; void keeps the original; start/end season checklists; a second member; Arabic on mobile.

**Defects found by the new tests and fixed:**
- the setup review **crashed** for suggestions without a frequency (usage / season tasks);
- the rules accepted **date-keyed occurrences for event tasks** (tightened);
- the "deferred" note was **mislabelled** after 5.4b (reworded EN/AR).

**Updated Phase 5.3.1 / 5.3.2 expectations** (counts change because more templates are now generatable):
- the realistic household: 97 → 125;
- T-UI: 20 → 38; G-UI: 20 → 38 / 3 → 4 groups / 21 → 39; H-UI: 22 → 24;
- "AC fully deferred" → "AC offered 16 seasonal tasks".

The behavioural assertions are unchanged. One test race was fixed (DEV-UI now waits for the day's plan save before simulating a failed write).

## 7. Exact Windows CMD commands

```cmd
cd HomeHub-V5
npm test
npm run test:rules > emulator-5.8.1-normal.txt 2>&1
npm run test:rules:strict > emulator-5.8.1-strict.txt 2>&1
npm run rules:limits -- emulator-5.8.1-normal.txt
npm run rules:limits -- emulator-5.8.1-strict.txt
```

**Expected:** 119/119 in each mode, and no expression-limit hit inside a failing test.

## 8. Known limitations

- **Real emulator results pending** (your runs).
- **Live usage window:** uses are kept live for **120 days**. A use older than that which was never cleaned stops showing as due; it stays in Firestore.
- **Default season state:** a device with no season state is **off-season**. Users must start the season once for in-season tasks to appear.
- **Not modelled:** condition-based and manual device triggers.
- **Corrections:** only a use can be voided. A season change is corrected by toggling again (both entries stay in history).

## 9. Deployment and rollback (plan only; do not deploy without approval)

**Deploy:**
1. Optional Firestore export.
2. `firebase deploy --only firestore:rules` (after 119/119 Normal and Strict).
3. `firebase deploy --only hosting`.

**Rollback to v5.8.0** (rules and hosting from `HomeHub-V5.8.0-Phase5.4a-full.zip`):
- **Device events / state / season documents** written by 5.8.1 become **inaccessible** (no rules) but remain stored; delete nothing.
- **Tasks with a `trigger`** (and `onUse` / `onSeason` recurrence) stay **readable**, but v5.8.0 rules **refuse updates** to them (unknown keys and recurrence kinds), and the v5.8.0 client may show them as non-recurring.
  - **Recommended:** before rolling back, archive device-triggered tasks while 5.8.1 is still deployed. Archiving changes only `active` / `archivedAt` / `archivedBy`, so it's reversible.
- **Occurrences with `_u` / `_s` ids** remain readable; the old rules refuse further updates to them.
- No other data is affected. **Do not assume the old rules can edit the new documents.**
