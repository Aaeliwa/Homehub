# HomeHub V5 — Phase 5.3.1 Report: Cleaning widget & Rooms/Devices integration

**Version:** 5.7.1 • **Baseline:** Phase 5.3 (v5.7.0, deployed). **NOT APPROVED FOR DEPLOYMENT** until the real emulator passes the normal and strict runs (106 tests each). Nothing was deployed; production data is unchanged.

## 1. Root causes

**Issue 1: the dashboard card looked different.** Existing cards (Rooms, Devices, Finance, Savings) use the shared `summary-card` component. The Phase 5.3 Cleaning card used invented classes (`widget__title`, `widget__value`, `widget__hint`) that have **no CSS at all**, and its outer element reused `.widget`, the dashboard's *slot* class, so it was a slot nested in a slot. It also differed in edge cases: it left an empty slot when unavailable (Rooms removes it) and showed no "—" on error.
**Fix:** rebuilt on `summary-card` with the module's accent. A browser test asserts **identical computed styles** to the Rooms card.

**Issue 2: rooms and devices were not reflected in Cleaning.** Phase 5.3 had only manual tasks: no template libraries, no generation from rooms or devices, and no last-completion scheduling. The standalone app (`homeCleaning.html`, read in full) has all three.

## 2. Standalone behaviour reused, and HomeHub adaptations

| Standalone (homeCleaning.html) | HomeHub 5.3.1 |
|---|---|
| Built-in `TEMPLATES` (6 room types) / `DEVICE_TEMPLATES` (7 device types) with stable keys | **Same data, extracted verbatim** (`cleaning-templates.js`, generated). See CLEANING-TEMPLATE-INVENTORY.md. |
| Room picker creates a room *and* its template tasks | HomeHub rooms/devices already exist (created in Rooms / Devices), so they are **recognised** via a type mapping and set up through a **one-tap review** that shows the exact tasks and frequencies |
| `syncType` / `syncDeviceType`: add only missing tasks; never edit or delete | Same: the plan adds only missing template tasks and never touches existing ones |
| Dedup: `appliedKeys` + same `templateKey` or title in the room | **Deterministic ids** `r_<room>_<key>` / `d_<device>_<key>` (stronger: also concurrency-safe and enforced by the rules), plus same-title coverage. **Declined** tasks become archived tombstones, the equivalent of `appliedKeys`. |
| First-due stagger `n % min(period, 7)` | Same |
| `nextAfter(freq, today)`: last-completion scheduling | Same semantics as `recurrence.kind: 'after'` (see §3). Manual tasks keep fixed-calendar scheduling. |
| Paused room / inactive device hides its tasks | Archived room/device hides its generated tasks; restore shows them |
| Delete room/device **hard-deletes** its tasks | HomeHub never hard-deletes: tasks and history are kept, just hidden |
| Moving a device keeps the old room on its tasks | **Fixed:** device tasks follow the device's *current* room |
| Seasonal devices, usage / cycle / condition triggers, manual device tasks | **Deferred** (your decision). All keys and metadata are kept in the library; 32 device tasks, including all 16 AC tasks. |
| Daily routine: catch-up quota, quick-pick, skip, postpone | **Deferred** (your decision) |
| Old-format data (`hr_*`) | **Untouched**; any import is a separate decision |

## 3. Last-completion scheduling (`'after'`): definition

- **Next due** = (latest completion date of the task, in the Home's time zone) + N days / N months. Month ends are clamped (31 Jan + 1 month = 28/29 Feb). With no completion yet: the (staggered) start date.
- **Done:** the occurrence for the due date D becomes done, and the next due date becomes completion + N.
- **Overdue completion:** due D, done on T > D, next = T + N (standalone `nextAfter(freq, today)`).
- **Reopen:** the occurrence is no longer done, so the next due date is recomputed from the *previous* completion. The same occurrence D (same deterministic id) is due again; nothing needs undoing.
- **No pile-up:** only one open date exists per task. A task completed today still counts in today's progress.
- **History:** the store keeps enough occurrence history for the longest active interval (e.g. 3 months ≈ 100 days; maximum 400).

## 4. Rooms/devices lifecycle → generated tasks

| Event | Effect |
|---|---|
| New room/device of a mapped type | A banner offers its template tasks; nothing is written until confirmed |
| Rename | Reflected live (tasks reference the room/device) |
| Device moved to another room | Its tasks follow the device's current room |
| Room/device archived | Its generated tasks are hidden; occurrences and audit history are kept |
| Restored | Tasks are visible again. 'After' tasks are due from their last completion, so they may show as overdue once. |
| Room type changed | Only the new type's missing tasks are offered; old tasks remain until you archive them |
| Task declined / archived | Never suggested or recreated again |
| Manual tasks | Unchanged; a same-titled manual task in the room covers the template task |

## 5. Tests

| Suite | Result in the build environment |
|---|---|
| `npm test` (unit + static) | **265/265** (+7: template equality with homeCleaning.html, mapping, plan / dedupe / tombstones, stagger, 'after' scheduling incl. time zone and month clamp, board, lifecycle) |
| Browser E2E | **109/109** (T-UI and G-UI: identical card styles; recognition; review with frequencies; declined kept; idempotent; rename / move / archive / restore; new device; 'after' scheduling) |
| Real emulator | **106 tests** (+G1–G5): **UNVERIFIED**; your normal and strict runs are required |

**Defects found by the tests and fixed:**
- an extra bracket in the rules;
- the template-equality test was silently skipped (it now always runs against the shipped reference file);
- a sandbox-realm quirk in that test;
- device labels printed the icon key ("dishwasher Bosch");
- a duplicate browser flow was removed (the existing T-UI / G-UI flows already covered it).

## 6. Deliverables
- **PHASE-5.3.1-SECURITY-IMPACT.md:** rules diff, threats, costs.
- **CLEANING-TEMPLATE-INVENTORY.md:** every template task, key and frequency.
- **PHASE-5.3.1-CHANGED-FILES.txt**
- **PHASE-5.3.1-MANUAL-CHECKLIST.md**
- TESTING.md, CHANGELOG.md and FIRESTORE-SCHEMA.md updated.
