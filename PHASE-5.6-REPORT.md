# HomeHub V5 — Phase 5.6 Report: Smart Reminders (Cleaning + Device Maintenance)

**Version:** 5.9.1 (backward-compatible, additive). **Baseline:** v5.9.0. The ZIP was not re-attached; the delivered package was used (SHA-256 `f1dcb08e…`), with 312/312 unit + static verified.

**The real emulator runs for 5.4d / 5.5 / 5.6 are still pending your logs and are not claimed as passed.** Any baseline failure there is a blocker.

**Confirmation:** no deployment, no production reads / writes, no migration, no `hr_*`, no Finance / Savings / Zakat change, no Cloud Functions, no Service Worker, no push, no permission prompts. Phase 5.7 was not started.

The design and decisions are in **PHASE-5.6-DESIGN.md**; behaviour per source type is in **REMINDER-BEHAVIOR-MATRIX.md**.

## 1. Implemented

- **Reminders page `#/reminders`** (app-level; Cleaning **or** Maintenance view, each source **only** with its own permission). It includes:
  - the honest banner "In-app reminders only … Background notifications are not implemented";
  - filters **All / Cleaning / Maintenance / Overdue / Today & upcoming / Open faults**;
  - groups Overdue → Due today → Open faults → Upcoming;
  - type, device / room, date (or **"No due date"** for faults), priority / severity, Unread / Read;
  - **Open** (deep link + highlight), **Mark read**, **Snooze 1 / 3 / 7 days**, **Dismiss**, plus a **"Dismissed and snoozed"** section with **Restore**;
  - **settings** (look-ahead 1 / 3 / 7 / 14, per-type toggles, quiet hours), which affect **presentation only**;
  - loading, error, empty and partial-permission states.
- **Bell** in the top bar (only when authorized). It has its own class, so the existing language / theme selectors are untouched.
  - **Lightweight:** the **actionable** count (and its listeners) runs only on Dashboard / Reminders / Cleaning / Maintenance.
  - Elsewhere it's a plain link with **no extra Firestore reads** (see §4 on why this was revised).
- **Dashboard card** (the shared `summary-card`; lazy-loaded).
- **In-app alert** (toast) for **new** urgent reminders while the app is open; never on load; quiet hours respected.
- **Derived, not copied:** uses Cleaning's `buildBoard`, `mayAct` and `sourceActive` and Maintenance's `planStatus` / `nextDue` directly, so reminders can't disagree with the modules.
  - **Each task gives at most one reminder per cycle** (a daily task does not remind for every future day).
  - Faults never get fabricated dates.
- **Deep links:** Home-scoped, read-once focus intents.
  - Cleaning opens the right tab with the task **highlighted**.
  - Maintenance opens the Plans tab with the plan highlighted, or the fault's detail.
  - The highlight is part of the render state, so it survives live re-renders.
- **Time:** the Home date is re-checked every 60 s and on tab focus (midnight / DST-safe via the Home time zone).
- **Lifecycle:** stores are Home-scoped resources; the bell controller is disposed on every shell rebuild; feeds dispose all listeners and timers.

## 2. Schema (owner-only; documented in FIRESTORE-SCHEMA.md)

| Path | Fields |
|---|---|
| `homes/{h}/reminderStates/{uid}_{fnv64(key)}` | `ownerUid`, `key` (`^[cpf]:`, ≤ 200), `state` (read \| dismissed \| snoozed), `snoozeUntil`, `sourceKind`, `updatedAt`, `schemaVersion` |
| `homes/{h}/reminderPrefs/{uid}` | `lookAheadDays` (1 / 3 / 7 / 14), `cleaning`, `maintenancePlans`, `maintenanceFaults`, `quietStart`, `quietEnd`, `updatedAt`, `schemaVersion` |

- **No copies of source records**; a small key and the presentation state only.
- **No indexes:** single-field `ownerUid ==` query.
- **Bounded cleanup:** stale and not-current state older than 30 days, ≤ 20 deletions per visit.

## 3. Security

**Rules diff** (generated):
## Functions
- Added (0): —
- Removed (0): —
- Changed (0): —

## Match paths
- Added (2): `/databases/{database}/documents/homes/{h}/reminderStates/{sid}`, `/databases/{database}/documents/homes/{h}/reminderPrefs/{uid}`
- Removed (0): —

## Allow statements on common paths
- none


- **The only new rules are the two owner-only paths:**
  - read / list only your own (`ownerUid` = caller; an unfiltered list is denied), as an active member of this Home;
  - the id is bound to the caller; exact keys; key format, with `sourceKind` matching the key prefix;
  - state enum; snooze date within 1 year ahead (server time) and only when snoozed; server timestamp;
  - **no takeover** of another member's document; owner-only delete.
- **They grant nothing on Cleaning / Maintenance:** reminders are derived from the user's own authorized subscriptions; test RM3 confirms no escalation.
- **Protected rules, verified byte-for-byte against v5.9.0:** **30 of 30** blocks identical (all Finance, Savings, Zakat, membership, roles, invites, users, Devices, Rooms, settings, **Cleaning** and **Maintenance**). No block removed; 0 functions changed.
- **Cost:** reminder state write **294**, prefs 192, reads ≤ 47. The heaviest rules overall are unchanged existing ones (commitments 1,026; expenses 969).
- **Data layer:** `atomicWrite` gained `delete`.
  - **A new static test enforces that only the reminders repository and store use it.**
  - Every module collection's rules still say `allow delete: if false`.
  - The fake SDK mirrors this (a delete elsewhere is refused).

## 4. Tests (this build environment)

| Suite | Command | Result |
|---|---|---|
| Unit + static | `npm test` | **322/322 PASS** (+10, incl. the lightweight-bell guard) |
| Browser E2E | `npm run test:e2e` | **116/116 PASS** with the lightweight bell (single run; repeated from the clean unzip, see §4a) |
| Offline rules-file check (NOT a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (133 tests) |
| **REAL emulator, Normal** | §7 | **NOT EXECUTED** (no network). **Expected 133/133** (130 + RM1–RM3). |
| **REAL emulator, Strict** | §7 | **NOT EXECUTED. Expected 133/133.** |

**New tests:**

*Unit (9):*
- **Cleaning derivation:**
  - overdue / today / next-upcoming only, and the look-ahead;
  - done / skipped (one-time and daily); not-mine / child; archived; postpone giving a new key;
  - after-use coalescing; off-season.
- **Maintenance:** month clamp, a new cycle after completion, completed one-time, archived, faults (no date, severity order, reopen giving a new key).
- **Permissions:** no source means no items or counts; prefs only filter.
- **Identity:** deterministic keys, dedupe, order, and **no mutation of frozen source data**.
- **Presentation:** read / dismissed / snooze expiry; counts.
- Prefs / quiet hours / bounded cleanup; the store's write shapes / prefs validation / disposal; the delete guard.

*Emulator (3):*
- **RM1:** owner-only states; caller-bound id; forged owner; formats; `sourceKind` / key match; state enum; snooze bounds; server time; no copied fields; **no takeover**; another member can't read / list / delete; an unfiltered list denied; cross-Home; non-member; owner restore.
- **RM2:** owner-only prefs, shape and bounds.
- **RM3:** no escalation into Cleaning / Maintenance.

*Browser (RM-UI):*
- the bell and card count (4; the resolved fault excluded); groups with "No due date";
- read / snooze / dismiss / restore with **source records byte-identical**;
- **deep links highlight** (plan, task); done in Cleaning makes today's reminder go away and only the next occurrence remain;
- reload persistence; **per-user state** (Mona unaffected by the owner's snooze; her look-ahead only changes her view);
- **no access:** no bell, no card, the page refuses;
- Arabic mobile.

### 4a. Browser test history (honest record)

| Run | Bell | Machine | Result |
|---|---|---|---|
| Working tree | every page | multi-core | **116/116** |
| Clean unzip, 3 runs | every page | **1 core** (after an environment restart) | 81 / 107 / **108/116** |
| v5.9.0 control | (none) | 1 core | 40 failures within 72 checks (the run was cut off by another restart) |
| **Working tree, lightweight bell** | data pages only | 1 core, low load | **116/116** |

**Three tests failed in all three heavy runs** (S40–S45, S47–S48, Recovery). The cause is one chain:
1. S40–S45 (Arabic) timed out midway and never switched back to English.
2. Recovery then clicked the English "Try again" on an Arabic page.

The control run never reached these tests, so the environment alone couldn't be proven. The identified contributor was the always-on bell's extra listeners on every page, which led to the design fix. **The final run also had lower machine load**, so both factors may have contributed. **Please confirm with `npm run test:e2e` on your machine.**

**Defects found by the new tests and fixed:**
1. **Restore failed silently:** the data layer had no delete. Fixed narrowly, with a guard.
2. **Daily tasks produced a reminder per future day.**
3. **The deep-link highlight was lost on live re-render** (Cleaning and Maintenance).
4. **Data-access code under `src/ui`** violated the "UI never talks to Firestore" guard; moved to `src/core/reminders`.
5. **A forbidden word in comments.**
6. **An accidental empty `assets/css/main.css`** created by a stray command was found by the baseline comparison and **removed**.
7. **The always-on bell** made every page open the Cleaning / Maintenance listeners (extra reads; slowed unrelated tests). Now limited to data pages.

## 5. Known limitations

- **No background / push / browser notifications.** These need new infrastructure (Service Worker / FCM / scheduled backend) and a **separately approved** subphase.
- **In-app alerts are per tab** (two open tabs can each show a toast once).
- **No count in the dock / sidebar;** the bell sits in the top bar, and **its count shows only on Dashboard / Reminders / Cleaning / Maintenance** (by design, to avoid extra reads).
- **The look-ahead is capped at 14 days** (the Cleaning board's loaded window).
- **Presentation state is per Home and per user;** it is not shared between members (by design).

## 6. Rollback compatibility (plan only)

- Redeploy v5.9.0 rules and hosting.
- **`reminderStates` / `reminderPrefs` documents** become unreachable under the old rules (no match) and are ignored by the old client.
- **No source data is affected** (reminders never write it). Nothing needs deleting; re-deploying 5.9.1 makes them visible again.

## 7. Windows CMD verification

```cmd
cd HomeHub-V5
npm test
npm run test:e2e
npm run test:rules > emulator-5.6-normal.txt 2>&1
npm run test:rules:strict > emulator-5.6-strict.txt 2>&1
npm run rules:limits -- emulator-5.6-normal.txt
npm run rules:limits -- emulator-5.6-strict.txt
```

**Expected:** 133/133 in each mode.

**Deploy only after both pass and you approve:**
1. `firebase deploy --only firestore:rules`.
2. `firebase deploy --only hosting`.
