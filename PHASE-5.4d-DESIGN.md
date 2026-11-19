# HomeHub V5 — Phase 5.4d Design: Device–Cleaning Integration

**Baseline:** v5.8.2 (Phase 5.4c): 298/298 unit + static, 113/113 browser, 122 emulator tests.

## 1. Audit (verified in the v5.8.2 code)

| Brief observation (from v5.8.1) | Status in v5.8.2 |
|---|---|
| Add Device taxonomy in `DEVICE_CATEGORIES` | Confirmed: **19 categories, 85 subtypes** (`other` allowed in each). The `other` category has **no** subtypes, so `subtype` may be `null`. |
| Device Details shows Cleaning + Maintenance as "coming later" | Confirmed (`device-detail.js` L63–67) |
| Basic task form has no device field | Confirmed (`page.js` `openTaskForm`, L269–323) |
| Maintenance unimplemented | Confirmed: `maintenance/module.js` has `enabled: false` and no page. **Its placeholder stays (truthful).** |

**Additional findings:**
1. **Room Details** (`room-detail.js` L89–94) also claims **Devices and Cleaning are "coming later"**, though both are live. It is fixed too; only Maintenance stays.
2. **Editing an after-use / season task in Basic is broken.** The repeat selector lacks `onUse` / `onSeason` and falls back to "once", so the save is refused. The shared form now shows trigger recurrences **read-only**, with an explanation.
3. **Advanced Cleaning has no New/Edit task form.** The Basic form is extracted into a shared module (`task-form.js`) used by Basic, Advanced and Device Details.

## 2. Schema: one optional field on `cleaningTasks`

**`deviceId`** (string | absent) is a plain device link for **non-trigger** tasks.
- Allowed on manual and template-derived tasks. Not allowed on generated tasks (their device is `source.id`) or on trigger tasks (their device is `trigger.deviceId`, which stays immutable).
- **Create:** the device must exist in **this Home** and be active.
- **Update:** `deviceId` may be changed or removed. A **new** value must again be an active device of this Home; an existing link to a since-archived device stays readable.
- **No device documents are modified.**

**A task's device** = `trigger.deviceId` ‖ `deviceId` ‖ (`source.kind == 'device'` ? `source.id`). One helper (`linkedDeviceId`) is used everywhere.

**Room:** for device-linked tasks, `roomId: null` means **"follow the device's current room"** (the default when a device is chosen). An explicit room stays fixed. This avoids stale cross-room copies; it's documented in the UI.

**Templates:** a `device` target no longer requires a trigger. A periodic device template applies as a task with `deviceId`. The deterministic id target becomes trigger device ‖ `deviceId` ‖ room ‖ `home`.

**AI import:** periodic device items become `deviceId` tasks (previously attached to the device's room). Devices are chosen only from the household's own list in the preview; ids in the JSON are still rejected.

## 3. Archived or missing devices

- **Plain-linked tasks stay visible**, labelled "(archived device)" / "(device removed)", so history is never hidden.
- **Trigger tasks** keep the 5.4b behaviour: not due while the device is archived.
- **New links to archived devices** are refused by the UI and the rules.
- **Archived device details** are readable, with no add or edit actions.

## 4. Device Details → Cleaning (live)

- Lists this device's linked tasks with live status: overdue / due today / done today / next date / "used N× since last cleaning" / off-season.
- **View cleaning tasks** opens Basic Cleaning filtered by this device.
- **Add cleaning task** opens the shared form with the device preselected (for `cleaning.create`).
- **Suggested tasks** for the device's category: editable defaults, never created automatically, each added only through the form.
- **Empty state:** "No cleaning tasks linked to this device yet".
- **Maintenance** keeps an honest "coming in a future update" notice.

**Navigation** uses an in-memory, **Home-scoped**, read-once **focus intent** (`homeId`, `deviceId`, `openNew`). Cleaning consumes it only when the `homeId` matches the active Home, so nothing leaks across Homes, nothing goes in the URL, and there is no stale selection after use.

## 5. Device catalog (suggestions)

`device-cleaning-catalog.js` gives **every category** (and therefore every subtype, including `other` and `null`) 1–3 suggested **cleaning** tasks with editable default frequencies and **safety caveats** (unplug first, no water on electronics, gas or electrical safety, external surfaces only). Servicing and repairs are **maintenance** and are not suggested. Frequencies are **suggestions, not manufacturer guidance**.

The coverage matrix (DEVICE-CLEANING-COVERAGE.md) is generated from the live taxonomy.

## 6. Security

- Rules change only `cleaningTasks` (the optional `deviceId`: validation on create and on change) and `cleaningCustomTemplates` (a device target without a trigger).
- **Untouched:** Finance, Savings, Zakat, membership, devices, rooms and every other rule.
