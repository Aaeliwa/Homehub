# HomeHub V5 — Phase 5.5 Report: Device Maintenance Management

**Version:** 5.9.0 • **Baseline:** v5.8.3 (Phase 5.4d). The ZIP was not re-attached; the delivered v5.8.3 package was used (SHA-256 `581cd1c9…`), with 303/303 unit + static verified. **The 125-test emulator baseline is not claimed as passed;** your Normal / Strict logs are pending, and any baseline failure there would be a v5.8.3 blocker, not a 5.5 result.

**Confirmation:**
- no production data was changed, no migration or seed was run, nothing was deployed, no `hr_*` data was touched;
- **no Finance integration;** Finance, Savings, Zakat, Devices and Cleaning logic and rules are unchanged;
- Phase 5.6 / 5.7 were not started.

The design is in **PHASE-5.5-DESIGN.md**; device coverage is in **MAINTENANCE-COVERAGE.md**.

## 1. Implemented

- **Maintenance module (`#/m/maintenance`, enabled):**
  - a separate navigation destination after Cleaning, plus a dashboard card (due / overdue counts, open faults);
  - tabs: **Due** (overdue / due today / next 30 days), **Plans** (active / archived / all), **Faults** (open / closed / all), **History**;
  - a device filter (archived devices labelled); loading, error and empty states (incl. a Home with no devices).
- **Preventive plans:**
  - linked to **one active device of this Home**; the device link is **immutable**;
  - schedule: **once**, or **every N days / weeks / months after the last completion** (the single basis, shown in the UI), with month-end clamping and Home time-zone dates;
  - nothing is pre-generated; status (overdue / due today / upcoming / completed / archived) is derived identically everywhere;
  - optional assignee (active member), estimated minutes, priority, notes;
  - edit (field-level, `rev` + 1), archive / reactivate (`maintenance.delete`), **no delete**.
- **Completion** (idempotent): one batch writes the record `<planId>_c<n>` and the plan count n.
  - **Two members at once:** only one wins; the other is told "already recorded by someone else".
  - **My own retry** of a save that already succeeded is recognised ("already recorded"). Never double-counted.
- **Faults:**
  - report (summary, symptoms, severity, assignee, estimate);
  - **open → in progress → resolved → closed**, plus cancel / reopen; **closed is final**;
  - every change has `rev` + 1 and an append-only event `<faultId>_r<rev>` (from → to, actor, note), shown as an audit trail;
  - resolving can add a **repair record** (cost, provider, parts).
- **Service history and costs:**
  - a combined per-device timeline (preventive + repair + corrections);
  - actual costs in **integer minor units per currency**, never summed across currencies; **estimates are kept separate** and never totalled;
  - totals ignore records superseded by a **correction** (a new record beside the original, which stays unchanged);
  - **no Finance posting.**
- **Device Details → Maintenance (live; the release blocker):**
  - plans with next due / status, open faults, recent service;
  - **View maintenance** (filtered), **Add maintenance plan**, **Report a fault** (device preselected);
  - optional suggestions with **🛠 Professional only** flags;
  - read-only for archived devices and viewers;
  - the Cleaning section is unchanged.
- **Navigation:** in-memory, Home-scoped, read-once intent; the dialog closes before navigating and disposes its listener.
- **"Coming later" placeholders removed:** Device Details has none left. **Room Details** also listed Maintenance as "coming"; that's removed and the section relabelled "Related to this room".
- **Catalog:** suggestions for every category, plus subtype items where generic advice would be poor or unsafe.
  - Hazardous work (gas, refrigerant, electrical panels, batteries / inverters / UPS, water heaters, pumps, generators, solar, central AC) is **professional-only with no DIY steps**.
  - User items are limited to checks, tests and consumable replacement per the manual.
- **Roles:** the permissions already existed (template v1): **no template bump, no role-data change.**
- **Deferred:** attachments (no Storage infrastructure exists), Finance posting, notifications, vendor booking, reopening preventive completions (corrections are used instead).

## 2. Schema (all under `homes/{h}/`; documented in FIRESTORE-SCHEMA.md)

| Collection | Key rules |
|---|---|
| **`maintenancePlans`** | exact keys; active device of this Home; immutable device; `completedCount` changes only together with its record; `rev` + 1 |
| **`maintenanceRecords`** | append-only; completion / repair / correction, each proven against its plan, fault or original |
| **`maintenanceFaults`** | exact keys; status machine with permissions; `rev` + 1 with its event |
| **`maintenanceFaultEvents`** | append-only; only together with the matching fault change |

**No indexes needed. No migration.**

## 3. Rules diff and costs (generated)
## Functions
- Added (11): mtCan, mtPath, mtDate, mtActiveDevice, mtMemberOk, mtRecurrenceOk, mtMoneyOk, mtPlanContentOk, mtFaultContentOk, mtServiceOk, mtTransitionOk
- Removed (0): —
- Changed (0): —

## Match paths
- Added (4): `/databases/{database}/documents/homes/{h}/maintenancePlans/{planId}`, `/databases/{database}/documents/homes/{h}/maintenanceRecords/{recordId}`, `/databases/{database}/documents/homes/{h}/maintenanceFaults/{faultId}`, `/databases/{database}/documents/homes/{h}/maintenanceFaultEvents/{eventId}`
- Removed (0): —

## Allow statements on common paths
- none


**Protected blocks, verified byte-for-byte against v5.8.3:** **26 of 26 identical**. That covers all Finance, Savings, Zakat, membership, roles, invites, users, **Devices**, **Rooms**, settings **and every Cleaning** block. No block was removed.

**Worst-case cost (exhaustive estimate):** record create **542**, plan create 490, fault create 471, plan update 467, fault update 424, event 211. All are far below the 1,100 tripwire. **The emulator runs remain the authority.**

## 4. Tests (this build environment)

| Suite | Command | Result |
|---|---|---|
| Unit + static | `npm test` | **312/312 PASS** |
| Browser E2E | `npm run test:e2e` | **115/115 PASS** (single clean run; repeated from the clean unzip) |
| Offline rules-file check (NOT a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (130 tests) |
| **REAL emulator, Normal** | §6 | **NOT RUN** (no network for the emulator). **Expected 130/130** (125 + M1–M5). |
| **REAL emulator, Strict** | §6 | **NOT RUN. Expected 130/130.** |

**New tests:**

*Unit (9):*
- recurrence, clamping and status;
- plan validation, edit patches (device never editable), archive;
- completion ids and one-time / archived refusals;
- cost validation and per-currency totals;
- the fault state machine with permissions (closed final);
- the catalog for **all 104 combinations** (hazards professional-only; no user-level gas / refrigerant item);
- store concurrency (**two members → one record**, retry → "existing", stale edit refused, faults audited);
- **per-field errors (regression);**
- Home-scoped focus.

*Emulator (5):*
- **M1:** plans: roles, active same-Home device, assignee, forged author / time, shape, bounds, stale rev, immutable device, archive permission, no delete.
- **M2:** completions: record and count together only, device / date match, viewer, **duplicate / concurrent completion**, immutable history, one-time once.
- **M3:** costs: negative, fractional, orphan cost / currency, malformed currency, bounds, future or malformed dates.
- **M4:** faults: event required, start open, legal transitions only, event must record the real from-status, `rev` + 1, **concurrent duplicate transition**, repair only on resolve, closed final, immutable events.
- **M5:** cross-Home and non-member denied, child has no view, corrections (identity copied, id format, no correction of a correction), no device edits through maintenance.

*Browser (MT-UI):*
- Device Details with Maintenance + Cleaning live and **no placeholder** (English and Arabic);
- plan from Device Details → **done once with cost** → due recalculated;
- a **failed write then retry** gives exactly one record;
- the full fault lifecycle with its 4-event trail; history totals;
- a second member; an archived device read-only;
- **Home switch** shows no data from the other Home;
- Arabic mobile with no overflow.

**Existing tests updated (equal or stronger):**

| Test | Was | Now |
|---|---|---|
| Phase-discipline guards (devices, finance, rooms, static, registry) | "Maintenance not started" | Maintenance rules exist **only** for its 4 collections; Devices and Rooms rule blocks carry no maintenance logic; maintenance code imports no Finance store / repository and writes no Finance collection; Inventory / Shopping / Chef / Meal planner / Contacts still not started; every enabled module has a page **and** a widget |
| R7, D8, D17, DEV-LINK | the old Room / Device placeholders | "**no** coming-later text", plus waiting for the live slots |
| A7, D1 | 6 planned tiles | **5** |

**Defects found and fixed:**
1. **Per-field form errors were silently dropped** (`AppError` keeps only `detail`); a regression test was added.
2. **Room Details still said Maintenance was "coming".**
3. **Removing the placeholder broke older device tests,** which then cascaded across later tests (D8 left a dialog open); fixed at the root.
4. **A sloppy emulator assertion** that would have passed for the wrong reason was removed.

Also: my process count for the browser suite briefly matched my own shell. It now counts only `node` processes; every reported run was single and uncontaminated.

## 5. Known limitations

- **Emulator results are pending** (your runs).
- **No attachments or photos** (deferred; no Storage).
- **Preventive completions can't be reopened;** corrections are added as new records instead.
- **Totals are per currency** (no conversion, by design).
- **The device link of a plan or fault can't be changed** (create a new one).

## 6. Windows CMD verification

```cmd
cd HomeHub-V5
npm test
npm run test:e2e
npm run test:rules > emulator-5.5-normal.txt 2>&1
npm run test:rules:strict > emulator-5.5-strict.txt 2>&1
npm run rules:limits -- emulator-5.5-normal.txt
npm run rules:limits -- emulator-5.5-strict.txt
```

**Expected:** 130/130 in each mode. If v5.8.3's own 125 tests fail there, that is a baseline blocker; please send the logs.

## 7. Deployment plan (plan only; for later approval)

**Preflight:**
1. Both emulator runs pass (130/130) with no expression-limit hits.
2. Optional Firestore export.
3. Confirm the target project `expensetracker-d7309`.

**Order:**
1. `firebase deploy --only firestore:rules` (no indexes are needed).
2. `firebase deploy --only hosting`.
3. Live check:
   - open a device's details: Cleaning and Maintenance both shown, no placeholder;
   - create a plan, mark it done once, report and resolve a fault;
   - check the History totals.

**Rollback (non-destructive):**
- Redeploy the v5.8.3 rules and hosting.
- **Maintenance documents written by 5.9.0 stay stored** but become **unreachable** (the old rules have no match for them), and the old client has the module disabled.
- **No data needs deleting.** Re-deploying 5.9.0 makes it visible again.
- Devices, Cleaning and Finance data are unaffected either way, because maintenance never writes to them.
