# HomeHub V5 — Phase 5.4d Report: Device–Cleaning Integration (P0)

**Version:** 5.8.3 • **Baseline:** v5.8.2 (Phase 5.4c): 298/298 unit + static, 113/113 browser, 122 emulator tests.

**Confirmation:** no production data was changed, no migration was run, nothing was deployed, no `hr_*` data was touched, and no device documents or Devices rules were modified.

The design is in **PHASE-5.4d-DESIGN.md**; the device catalog coverage is in **DEVICE-CLEANING-COVERAGE.md**.

## 1. Audit results (verified in v5.8.2)

- **Confirmed brief observations:**
  - taxonomy of 19 categories / **85 subtypes** (and the `other` category allows a `null` subtype);
  - Device Details showed **Cleaning and Maintenance as "coming later"**;
  - the Basic task form had **no device field**.
- **Maintenance is genuinely unimplemented** (`maintenance/module.js` `enabled: false`), so its placeholder stays, truthfully.
- **Additional findings, all fixed:**
  1. **Room Details** also claimed **Cleaning** was "coming later".
  2. **Editing an after-use / season task in Basic was broken:** the repeat selector fell back to "once", so the save was refused.
  3. **Advanced Cleaning had no New/Edit task form.**

## 2. Implemented

### P0-A: catalog
- `device-cleaning-catalog.js` gives **every category** (and so all 104 category/subtype combinations, incl. `other` and `null`) 1–3 suggested **cleaning** tasks, plus subtype-specific extras where a generic suggestion would be poor (washing-machine drum, kettle/coffee descale, burners, solar panels, …).
- Each suggestion has an editable "after done" default and a **safety caveat** where relevant (unplug, no water on electronics, gas, electrical panel outside only, heights, batteries, chemicals).
- Shown as **suggestions only**, with a disclaimer; never created automatically; maintenance and servicing excluded.
- Phase 5.4b built-in templates and their stable keys are unchanged.

### P0-B: device selector (Basic and Advanced)
- A shared form (`task-form.js`) adds an optional **Device / الجهاز** selector: this Home's active devices, labelled "name · type · room".
- **Ordinary tasks** get a plain `deviceId` link (no trigger needed). It can be **changed or cleared** on edit.
- **Room:** with a device chosen, the default is **"Follow the device's room (now: …)"** (`roomId: null`), so the task moves with the device and never holds a stale copy. An explicit room stays fixed.
- **After-use / season / generated tasks** show their device and recurrence **read-only**, with an explanation (immutable by design). Editing other fields now works.
- **Archived or removed** linked devices are labelled honestly ("archived device" / "Device no longer available"), are **never offered** for new links, and their tasks and history stay visible.
- **Basic:** New / Edit plus a **Device filter**. **Advanced:** **New task**, **Edit** on rows, and **Add cleaning task** per device (Devices tab).
- Saves await server confirmation before showing success.

### P0-C: Device Details → Cleaning is live
- The section shows this device's linked tasks with live status: overdue since / due today / done today / next date / used N× / due after the next use / off season / nothing due soon.
- Actions:
  - **View cleaning tasks** opens Basic filtered by the device;
  - **Add cleaning task** opens the form with the device preselected;
  - **suggested tasks** pre-fill the form (nothing is created until Save);
  - an honest empty state.
- **Archived devices** are read-only, with history still visible.
- **Navigation** uses an in-memory, **Home-scoped, read-once** intent, so nothing goes in the URL, nothing goes stale, and nothing crosses Homes. The dialog closes before navigating and disposes its live subscription.
- **Maintenance:** the only "coming in a future update" notice left, in English and Arabic. Room Details no longer lists Cleaning as coming.

### P0-D: templates and AI
- A **device-targeted template** may now be periodic (no trigger). Applying it creates a `deviceId` task with deterministic id `c_<template>_<device>`.
- **AI-imported** periodic device items become `deviceId` tasks. Devices are chosen only from the household's own list in the preview; any `deviceId` inside the JSON is **rejected**.

## 3. Schema and rules (documented in FIRESTORE-SCHEMA.md)

**`cleaningTasks.deviceId`** (optional), on manual and template-derived tasks only:
- **create:** an active device of **this** Home, and not combined with a trigger or a generated source;
- **update:** a **new** value is re-validated, and `null` clears it. An unchanged link to a device archived **later** doesn't block other edits.

**Rules diff** (generated: `npm run rules:compare`, 5.8.2 → 5.8.3):
## Functions
- Added (1): cleanDeviceLinkOk
- Removed (0): —
- Changed (3): cleanTemplateRefOk, cleanTemplatedOk, cleanTemplateContentOk

## Match paths
- Added (0): —
- Removed (0): —

## Allow statements on common paths
- `/databases/{database}/documents/homes/{h}/cleaningTasks/{taskId}`: changed create/update


**Protected rules, verified byte-for-byte against v5.8.2:** all **20** Finance, Savings, Zakat, membership, roles, invites, users, **devices**, rooms and settings blocks are **identical**.

**Worst-case cost:** task create **863**, task update **801**, templates 509 / 496. All are below the 1,100 tripwire; the heaviest existing rule (commitments 1,026) already passes your real runs. **The emulator runs remain the authority.**

## 4. Tests

| Suite | Command | Result in the build environment |
|---|---|---|
| Unit + static | `npm test` | **303/303 PASS** (+5) |
| Browser E2E | `npm run test:e2e` | **114/114 PASS** (+ DEV-LINK; a single uncontaminated run, see note) |
| Offline rules-file check (NOT a rules result) | `npm run test:rules:smoke` | No JavaScript-level failures (125 tests) |
| **REAL emulator, Normal** | §6 | **NOT EXECUTED** (no network). **Expected 125/125** (122 + E1–E3). |
| **REAL emulator, Strict** | §6 | **NOT EXECUTED. Expected 125/125.** |

**New tests:**

*Unit (5):*
- **all 104 taxonomy combinations:** linkable, with suggestions, every suggestion a valid task and template;
- link rules (not with a trigger or generated source; id format; clearing; unlinked tasks keep their exact old shape);
- helpers (linked device, room following, archived visibility);
- templates and AI device mapping (incl. a rejected JSON `deviceId`);
- Home-scoped, read-once focus.

*Emulator (3):*
- **E1:** create with an active device; refused: archived, forged / other-Home, link + trigger, viewer, cross-Home. Change / clear validated; a later-archived link doesn't block edits.
- **E2:** periodic device template and its application.
- **E3:** **all 104 combinations** linked in the real rules engine.

*Browser (DEV-LINK):*
- Device Details live, with exactly one "coming later" (Maintenance) in English and Arabic;
- add with preselection and room-follow; the Basic device filter;
- a suggestion pre-fills without writing;
- Advanced New with an `other`/`null` device, and Edit re-link;
- archived devices never offered;
- **editing an after-use task now works**;
- a second member; reload;
- Arabic mobile; Room Details without a Cleaning placeholder.

**Updated older expectations:**
- the Phase 2 room test R7 asserted the old (false) "Cleaning coming later" placeholder; it now asserts Maintenance only;
- one 5.4c unit assertion ("a device template needs a trigger") is reversed by design.

**Note on browser runs:** one run was invalid because two suites overlapped and shared the fake database. It was discarded, and 114/114 comes from a single clean run.

**Defects found and fixed:**
- the false Cleaning placeholders (Device and Room Details);
- the broken edit of trigger tasks in Basic;
- a `null` passed to the DOM in the new filter row (caught by an existing guard test).

## 5. Known limitations

- **Emulator results are pending** (your runs).
- **Room Details** has no Cleaning *section*. The false placeholder is removed, and room-level cleaning stays in Cleaning's room filter.
- **Maintenance** is still unimplemented (truthfully labelled).
- **Suggestions** are generic per category or subtype, not model-specific.

## 6. Windows CMD commands

```cmd
cd HomeHub-V5
npm test
npm run test:rules > emulator-5.8.3-normal.txt 2>&1
npm run test:rules:strict > emulator-5.8.3-strict.txt 2>&1
npm run rules:limits -- emulator-5.8.3-normal.txt
npm run rules:limits -- emulator-5.8.3-strict.txt
npm run test:e2e
```

**Expected:** 125/125 in each mode, and no expression-limit hit inside a failing test.

## 7. Deployment and rollback (plan only)

**Deploy (after 125/125 Normal and Strict and your approval):**
1. Optional Firestore export.
2. `firebase deploy --only firestore:rules`.
3. `firebase deploy --only hosting`.
4. Live check: open a device's details, add a cleaning task, see it in Basic and Advanced.

**Rollback to v5.8.2:**
- Tasks with **`deviceId`** remain **readable**, but v5.8.2 rules refuse their updates (unknown key). Completions keep working (separate documents).
  - **Recommended:** clear device links (edit → Device: none) or archive those tasks **while 5.8.3 is deployed**.
- **Device-targeted periodic templates** are refused for edits by the old rules, but stay readable.
- **Don't revert rules blindly after new data is written.**
