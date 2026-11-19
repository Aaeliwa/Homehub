# HomeHub V5 — Phase 5.4b Design Review (device usage and seasonal cleaning)

**Baseline:** v5.8.0 (your upload is byte-identical to the delivered package; unit + static 281/281; 114 emulator tests; you reported 114/114 Normal and Strict).

## 1. Devices: the authoritative record is never modified

- **Path:** `homes/{h}/devices/{deviceId}`.
  - IDs are Firestore-generated.
  - Rules: read `devices.view`; create / edit `devices.*`; **exact key set** (incl. `status` ∈ operational / needs_attention / out_of_service / stored, and `active` = archive).
- **Cleaning links to a device by ID only.** Rules verify with `get()` that the device exists in the **same Home** and is `active`. Nothing is added to device documents.

## 2. New, narrowly scoped records (all under `homes/{h}/`)

| Path | Purpose | Write model |
|---|---|---|
| `cleaningDeviceEvents/{eventId}` | **Usage event** (`kind: 'use'`), or a **correction** (`kind: 'void'`, id = `<eventId>_void`) | Append-only. The client generates the id **once per click**, so a retry reuses it and a duplicate create is refused. Actor = caller; `at` = server time. |
| `cleaningDeviceState/{deviceId}` | **Current season state** (`active` / `inactive`) + `rev` | rev n → n+1, only together with its season log entry. A stale or concurrent toggle is refused, so no transition is lost. |
| `cleaningDeviceSeasons/{deviceId}_s{rev}` | **Season history** (who, when, new state, note) | Append-only; written in the same batch as the state change |

**Indexes:** none (single-field queries only).

## 3. Tasks stay ordinary `cleaningTasks` (one task store)

New optional, **immutable** `trigger` field, plus two recurrence kinds:

| trigger | recurrence | Meaning |
|---|---|---|
| `{kind: 'afterUse', deviceId}` | `{kind: 'onUse'}` | Due when the device has been used since this task was last completed |
| `{kind: 'seasonal', deviceId, phase: 'active'}` | any periodic kind (`after`, `days`, …) | Normal schedule, **only while the device is in season** |
| `{kind: 'seasonal', deviceId, phase: 'start' \| 'end'}` | `{kind: 'onSeason'}` | Due once at each switch to active (`start`) or inactive (`end`) |

- **Templates:** the previously deferred standalone template tasks become generatable with their **original keys**:
  - `afterUse` / `afterCycle` → `afterUse`;
  - AC periodic → `seasonal` `active`;
  - AC start / end → `seasonal` `start` / `end`.
- **Still deferred:** `conditionBased` and `manual` device triggers (no safe data model yet), keys preserved.
- **Old tasks have no `trigger`,** so they are unaffected.

## 4. Occurrence identity (no collision with date ids)

| Task type | Occurrence id |
|---|---|
| Date-based (existing) | `<taskId>_<YYYYMMDD>` (unchanged) |
| afterUse | `<taskId>_u<eventId>`: the **first** use since the last completion. **Coalesces:** later uses before completion join the same occurrence (shown as "used N× since last cleaning"); every use stays in history. After completion, the next use starts a new occurrence. |
| seasonal start / end | `<taskId>_s<rev>` (the season transition) |

- The rules prove the referenced event or season entry exists **for the same device**.
- `dueDate` = the trigger's day in the Home time zone.
- Skip, postpone, resume, claim and reopen work unchanged. **Only Done** resolves a pending use or season item.

## 5. Derived (never stored) status

- **afterUse pending:** non-voided `use` events of the device with `at` > the task's last completion time.
- **Seasonal `active` tasks:** visible only while the state is `active`. On reactivation, the due date is `max(next due from the recurrence basis, activation day)`, so there's no burst of overdue items. The basis itself is **not changed**.
- **Default season state:** a device with no state document is **inactive** (conservative: nothing seasonal is due until someone switches it on).
- **Off-season:** the device's seasonal `active` tasks disappear from Basic and Advanced. **Nothing is deleted;** occurrences and history stay inspectable.

## 6. Corrections

A mistaken use is corrected with a **void event** (`<eventId>_void`, at most one per event, audited), never by deleting it. Voided uses don't count.

## 7. Routine integration

- The **saved plan stays stable.** Device items that become due later in the day appear as **"new tasks due today, not in the plan"** (Advanced: Devices tab; Basic: Today).
- Quick routine, whole-room and statistics include device tasks like any other task. Device tasks follow the device's current room.

## 8. Permission matrix (existing `cleaning.*` permissions; no template change)

| Action | Owner / Admin | Member | Child | Viewer | Other Home |
|---|---|---|---|---|---|
| Read device events, states, seasons | ✔ | ✔ | ✔ (view) | ✔ | ✘ |
| Log a use, or void a use | ✔ | ✔ | ✔ (`cleaning.complete`) | ✘ | ✘ |
| Toggle season | ✔ | ✔ (`cleaning.edit`) | ✘ | ✘ | ✘ |
| Create device-triggered tasks | ✔ | ✔ (`cleaning.create`) | ✘ | ✘ | ✘ |
| Complete device tasks | as today (claim / eligibility) | | | | ✘ |

## 9. Time zone, offline, concurrency

- **Days** come from the Home time zone; the routine day uses `startHour` (5.4a).
- **Offline / retry:** usage is saved with an idempotent id, success is shown only after confirmation, and a retry never duplicates.
- **Simultaneous uses** are separate events that coalesce into one due item.
- **Simultaneous season toggles:** the revision check lets exactly one win; the other user is told to retry with the fresh state.
