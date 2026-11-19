# HomeHub V5 — Phase 5.4a Report: Advanced Cleaning (routine, skip/postpone, time, stats, quick, whole room, settings)

**Version:** 5.8.0 • **Baseline:** v5.7.2 r2 (your runs: 109/109 Normal and 109/109 Strict). **NOT DEPLOYED. No data migrated, no `hr_*` data touched.** Stop for review before Phase 5.4b.

## 1. What was built (per your approved decisions)

- **Built-in screen `#/m/cleaning/advanced`.** Basic Cleaning is unchanged except for an **Advanced Cleaning / الإعدادات المتقدمة** button. Advanced has **← Back to Cleaning**.
- **One data model.**
  - Both screens use the **same store and repository**: `cleaningTasks`, `cleaningOccurrences`, `cleaningLog`. There is no second task or completion store.
  - Every action goes through the same audited path (`store.act` → occurrence + log, one batch, awaited).
- **Daily routine:**
  - The selection is saved **once per day** in `cleaningRoutines/{day}` (create-only). If two members open it at once, the first plan wins and the other uses it.
  - Statuses (done, claimed, reopened, skipped, postponed, assignment) are **always live** from occurrences.
  - Standalone selection rule: everything due today, all high-priority overdue, plus up to `catchUpMax` others. The day starts at `startHour`.
- **Skip** (your decision 2):
  - an audited `skip`; **not a completion**;
  - completion-based tasks are hidden **only on the skip day**, with the basis (last completion) unchanged, so they are still due afterwards;
  - for fixed-calendar tasks, that date is handled (never "missed");
  - **Resume** undoes it.
- **Postpone** (decision 3): an audited `postpone` to a date up to **30 days** ahead; shown on the new date; **not a completion**; the recurrence definition is unchanged. Done works from postponed; Resume undoes it.
- **Time tracking:** optional actual minutes (1–600) on Done; stored on the occurrence and in the audit entry.
- **Statistics:** last 7 or 30 days, read from the append-only audit log with a bounded single-field query. Completions, minutes (actual, else estimate), skips, postponements, reopenings, by member, by room.
- **Quick routine:** tasks fitting 5–60 minutes, high priority first.
- **Whole room:** a room's due tasks; **Done all** = one confirmed write per task, with live confirmed progress and honest partial results.
- **Settings:** `catchUpMax` (0–10), `startHour` (0–6), editors only.
- **Reset history / reset all / permanent delete: disabled** (decision 5), with an explanation on the Settings tab.

## 2. Schema changes (all under `homes/{h}/`, documented in FIRESTORE-SCHEMA.md)

| Path | Change |
|---|---|
| `cleaningOccurrences/{task}_{YYYYMMDD}` | + optional `skippedOn` (date), `postponedTo` (date), `actualMinutes` (int); + statuses `skipped`, `postponed`. Older documents remain valid. |
| `cleaningLog/{occ}_r{n}` | + actions `skip`, `postpone`, `resume`; + optional `actualMinutes` (complete only), `postponedTo` (postpone only) |
| **`cleaningRoutines/{YYYY-MM-DD}`** (new) | `{date, items[≤200 occurrence ids], catchUpMax, startHour, createdBy, createdAt, schemaVersion}`. Create-only. |
| **`cleaningSettings/general`** (new) | `{catchUpMax, startHour, updatedBy, updatedAt, schemaVersion}` |

**No migration:** existing tasks, occurrences, logs, ids, tombstones and generated tasks are untouched.

**Indexes:** none needed. Stats use a single-field range on `cleaningLog.at`.

## 3. Rules changes (generated: `npm run rules:compare`, v5.7.2 r2 → 5.8.0)
## Functions
- Added (8): cleanDayTs, cleanNearToday, cleanPostponeOk, cleanActualMinutesOk, cleanOptOk, cleanOptChangesOk, cleanNoProgress, cleanOccCreateOk
- Removed (0): —
- Changed (1): cleanOccUpdateOk

## Match paths
- Added (2): `/databases/{database}/documents/homes/{h}/cleaningRoutines/{day}`, `/databases/{database}/documents/homes/{h}/cleaningSettings/{sid}`
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/cleaningOccurrences/{occId}`: changed create/update
- `/databases/{database}/documents/homes/{h}/cleaningLog/{logId}`: changed create


**Security notes:**
- Occurrence updates dispatch on the new status (one branch per transition).
- `skippedOn` is bounded to ±2 days of server time; `postponedTo` must be after the due date and at most 31 days ahead, and the audit entry must record the same date.
- Each optional field may change only in its own transition.
- Skip and postpone can never set claim or completion fields. Resume is allowed for the actor, an eligible member or an editor.
- Routines: create-only, near today, ≤ 200 items, by members who can complete or create tasks.
- Settings: `cleaning.edit` only, with exact keys and bounds. No deletes anywhere.
- **Unchanged:** Finance, Savings, Zakat, Rooms, Devices, Members, legacy adoption, and every other rule.

**Worst-case cost:** occurrence create 608 / update 528; routine create 397; settings 195. All far below the 1,100 tripwire.

## 4. Tests

| Suite | Command | Result in the build environment |
|---|---|---|
| Unit + static | `npm test` | **281/281 PASS** (+9 Advanced) |
| Browser E2E | `npm run test:e2e` | **111/111 PASS** (+ ADV-UI; repeated from the clean unzip) |
| Offline rules-file check (NOT a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (114 tests) |
| **REAL emulator, Normal** | `npm run test:rules *> emulator-5.8.0-normal.txt` | **NOT EXECUTED HERE** (no network for the emulator). Expected **114/114** (109 baseline + A1–A5). |
| **REAL emulator, Strict** | `npm run test:rules:strict *> emulator-5.8.0-strict.txt` | **NOT EXECUTED HERE.** Expected **114/114**. |
| Expression-limit check | `npm run rules:limits -- emulator-5.8.0-strict.txt` | Run after both |

**New tests:**

*Unit (9):* the skip, postpone, resume and minutes state machine; skip semantics for completion-based and fixed tasks; postpone display and basis; the routine plan selection with a stable plan and live statuses; the `startHour` day across time zones; settings; quick-pick; statistics; store listeners (on demand, all disposed), routine create-only and concurrent "existing"; whole-room confirmed progress and partial results.

*Emulator (5):*
- **A1:** skip bounds, no minutes, never a completion, viewer denied, duplicate refused, resume, claim after skip.
- **A2:** postpone ≤ 31 days, after the due date, audit date must match; Done from postponed with minutes; minutes bounds and only on completion.
- **A3:** routine create-only; concurrent second save refused; viewer / far date / > 200 / update / delete / cross-Home denied.
- **A4:** settings: editors only; bounds; only `general`; forged editor; no delete; cross-Home denied.
- **A5:** backward compatibility with v5.7.2-shape writes.

*Browser (ADV-UI):*
- entry and back links; the plan saved once and shared by two members;
- skip, postpone and done-with-minutes sync to Basic; a Basic claim shows in Advanced; the second member resumes;
- whole-room Done all; statistics; settings persistence;
- Arabic on mobile with no overflow.

## 5. Known limitations

- **Real emulator results are pending** your Normal and Strict runs.
- **The day's plan is fixed once saved.** Tasks that become due later that day are listed as "N new tasks became due today" (they appear in Basic), not added to the plan.
- **Statistics** count audit events. A completion that is later reopened stays counted as an event, and its reopening is reported alongside it.
- **The routine** is created by the first member who opens Advanced that day. Viewers only see an unsaved preview until then.
- **Not in 5.4a:** device usage and seasonal tasks (5.4b); custom templates and AI routine import (5.4c). Legacy `hr_*` data: out of scope.

## 6. Deployment and rollback (do not deploy until both emulator runs pass and you approve)

1. Optionally export a Firestore backup from the console.
2. `firebase deploy --only firestore:rules`, then `firebase deploy --only hosting`.

**Rollback:** redeploy the v5.7.2 r2 `firestore.rules` and hosting from `HomeHub-V5.7.2-r2-full.zip`.
- Occurrences written by 5.8.0 with `skipped` / `postponed` status would then be refused for further updates by the old rules (they remain readable).
- The routines and settings collections become unreachable, but cause no harm.
- No data needs removing.
