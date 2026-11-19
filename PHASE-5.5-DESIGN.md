# HomeHub V5 — Phase 5.5 Design: Device Maintenance Management

**Baseline:** v5.8.3 (Phase 5.4d). The ZIP was not re-attached; the delivered v5.8.3 package was used (SHA-256 `581cd1c9…`): 303/303 unit + static verified here. The 125 emulator tests are **not** claimed as passed; your logs are pending.

## A. Audit (actual source)

| Area | Finding |
|---|---|
| Module | `maintenance/module.js`: `enabled: false`, route `/m/maintenance`, `standardPermissions('maintenance', {extra: ['complete']})`, registration only. **No maintenance code, rules, paths or data exist.** |
| Permissions | Granted since role template **v1**: admin (view, create, edit, delete, complete), member (view, create, edit, complete), viewer (view), child (none), owner `*`. **No template bump and no role-data change needed.** |
| Devices | `homes/{h}/devices/{id}`: exact-key rules, `active` = archive, `status` ∈ operational / needs_attention / out_of_service / stored. **Not modified.** |
| Device Details | Live Cleaning section (5.4d service factory); Maintenance "coming later" placeholder. |
| Attachments | No Firebase Storage or attachment code exists. **Attachments are deferred** (no unreviewed Storage rules). |
| Money | Finance uses integer **minor units** with `parseMinor` / `formatMoney` (pure). Reused **read-only** for parsing and display; no Finance logic or data is touched. Home currency: `home.currency`. |
| Cleaning | Patterns reused as *inspiration* (deterministic ids, rev + append-only events, one confirmed write per action, Home-scoped focus). **No cleaning collection is reused.** |

## B. Schema (all under `homes/{h}/`)

### `maintenancePlans/{planId}`: preventive plans

| Field | Rule |
|---|---|
| `deviceId` | an active device of **this** Home at creation; **immutable** |
| `title` ≤ 120, `instructions` ≤ 2000, `notes` ≤ 1000 | text |
| `recurrence` | `{kind: 'once'}` \| `{kind: 'every', unit: 'day' \| 'week' \| 'month', interval: 1–365 / 1–52 / 1–24}` |
| `firstDueDate` | `YYYY-MM-DD` |
| `assigneeUid` | null, or an **active member of this Home** |
| `estimatedMinutes` | null or 1–1440 |
| `priority` | low / normal / high |
| `active`, `archivedAt`, `archivedBy` | archive / reactivate (no delete) |
| `completedCount`, `lastDoneDate` | maintained **only** by completions (see D) |
| `rev` | +1 on every update |
| audit | `createdBy`, `createdAt`, `updatedBy`, `updatedAt`, `schemaVersion` |

**Recurrence basis (one, shown in the UI): after the last completion.**
- next due = `lastDoneDate` + interval (months clamped to the month end); with no completion yet, `firstDueDate`;
- a one-time plan is *completed* after one completion.
- Dates are calendar dates in the **Home time zone**. No occurrence documents are pre-generated.

**Status (derived identically on every client):**
- *archived* (active false);
- *completed* (once, done);
- *overdue* (next < today), *due today* (next == today), *upcoming*.

### `maintenanceRecords/{recordId}`: service history (append-only, immutable)

- **Preventive completion:** id `<planId>_c<n>` (n = the plan's `completedCount + 1`).
- **Repair record:** id `<faultId>_r<rev>`, written with the fault's resolve transition.

| Field | Rule |
|---|---|
| `kind` | `preventive` \| `repair` |
| `deviceId` | **must equal** the plan's or fault's device |
| `planId` / `faultId` | one of them, matching the id |
| `serviceDate` | `YYYY-MM-DD`, from 3 years ago to tomorrow (Home time zone) |
| `workPerformed` ≤ 1000, `provider` ≤ 100, `parts` ≤ 500, `notes` ≤ 1000 | text |
| `costMinor` | null or an integer 0–100,000,000 (**actual** cost, minor units) |
| `currency` | null, or 3 uppercase letters; **required when `costMinor` is set** |
| `actorUid` | = caller; `at` = server time; `schemaVersion: 1` |

**No update and no delete.** Mistakes are corrected with a **new** record (see D).

### `maintenanceFaults/{faultId}`: corrective issues

| Field | Rule |
|---|---|
| `deviceId` | an active device of this Home at creation; immutable |
| `summary` ≤ 120, `description` ≤ 2000 | text |
| `severity` | low / medium / high / critical |
| `status` | `open` → `inProgress` → `resolved` → `closed`; plus `cancelled` |
| `assigneeUid` | null or an active member |
| `diagnosis` ≤ 2000, `resolution` ≤ 2000, `estimateMinor` + `estimateCurrency` | an **estimate** is kept separate from actual costs and never summed with them |
| `reportedBy`, `reportedAt` | immutable |
| `rev` | +1 per update; audit fields |

**Transitions** (each writes the fault, rev + 1, **and** an append-only event `maintenanceFaultEvents/<faultId>_r<rev>` in one batch):

| From | To | Permission |
|---|---|---|
| open | inProgress | `maintenance.complete` |
| inProgress | open | `maintenance.complete` |
| inProgress | resolved (+ optional repair record `<faultId>_r<rev>`) | `maintenance.complete` |
| resolved | inProgress (reopen) | `maintenance.edit` |
| resolved | closed | `maintenance.edit` |
| open / inProgress | cancelled | `maintenance.edit` |
| cancelled | open (reopen) | `maintenance.edit` |
| *(same status)* | field edits (summary / description / severity / assignee / diagnosis / estimate) | `maintenance.edit` |

**`closed` is final.**

### `maintenanceFaultEvents/{faultId}_r{rev}`: fault history (append-only)

`{faultId, rev, fromStatus, toStatus, note ≤ 500, actorUid, at, schemaVersion}`. The rules require it to match the fault's after-state in the same batch.

## C. Permission matrix

| Action | Owner | Admin | Member | Viewer | Child | Other Home |
|---|---|---|---|---|---|---|
| View plans / faults / history (`maintenance.view`) | ✔ | ✔ | ✔ | ✔ | ✘ | ✘ |
| Create plan, report fault (`maintenance.create`) | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ |
| Edit plan, edit / close / cancel / reopen fault (`maintenance.edit`) | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ |
| Complete plan, start / resolve fault (`maintenance.complete`) | ✔ | ✔ | ✔ | ✘ | ✘ | ✘ |
| Archive / reactivate plan (`maintenance.delete`) | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ |

## D. Concurrency and idempotency

- **Completing a plan:** one batch creates the record `<planId>_c<n>` and updates the plan (`completedCount: n`, `lastDoneDate`, `rev + 1`).
  - The rules require **both together**: the record's n must equal the plan's new count, and the plan update must name that new record.
  - Two members completing at once compute the same n, so **only one wins**; the other's batch is refused. The client confirms with a server read and says "already completed by someone else". **No double completion, no duplicate cost.**
  - A retry of a successful write is likewise refused and recognised.
- **Plan edits / archive:** `rev` + 1 is required, so a stale edit is refused instead of overwriting someone else's change.
- **Fault transitions:** `rev` + 1, with an event id `<faultId>_r<rev>`; concurrent transitions are refused, and the event can't be duplicated.
- **Corrections:** completion and repair records are immutable. A wrong entry is corrected by adding a **correction record** (kind `preventive` / `repair`, `notes` naming the corrected record, plus `correctsRecordId`) and, for schedules, by editing the plan's first due date. No silent overwrite and no reopen of preventive completions.

## E. UI

- **Maintenance module** (`#/m/maintenance`, enabled, separate from Cleaning):
  - tabs: **Due** (overdue / today / upcoming), **Plans**, **Faults**, **History** (per-currency totals);
  - device and status filters; New plan / Report fault;
  - forms with confirmed saves; a complete dialog (date, work, provider, parts, cost + currency, notes); a fault detail with allowed transitions and the event trail.
- **Device Details → Maintenance** (live, via a service factory like Cleaning):
  - plans with next due / overdue, open faults, recent history;
  - **View maintenance** (filtered by the device), **Add maintenance plan**, **Report a fault** (device preselected);
  - optional **suggestions** (catalog) with professional-only flags;
  - read-only for archived devices and viewers.
- **Catalog:** `maintenance-catalog.js` gives every category conservative, optional suggestions. Professional-only items (gas, refrigerant, electrical panels, batteries / inverters, water heaters, …) are flagged and contain **no DIY instructions**. Not manufacturer intervals.

## F. Compatibility, limits, rollback

- **Additive only:** new collections; Device Details' placeholder replaced; module enabled. Cleaning, Finance, Savings, Zakat and Devices code and rules are unchanged.
- **No indexes:** single-field queries and collection listeners only. Listeners start only when Maintenance or a device's section is open.
- **Deferred:** attachments, Finance posting, notifications, vendor booking, reopen of preventive completions.
- **Rollback:** older rules don't match the maintenance paths, so the documents become **unreachable but stay stored**. Older clients don't show the module. **No data needs deleting.**
