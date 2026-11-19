# HomeHub V5 — Phase 5.6 Design: Smart Reminders (Cleaning + Device Maintenance)

**Baseline:** v5.9.0 (Phase 5.5). The ZIP was not re-attached; the delivered package was used (SHA-256 `f1dcb08e…`), with 312/312 unit + static verified here. **The real emulator runs (130 expected) are unverified,** and the Phase 5.4d / 5.5 emulator logs are still pending; they are not claimed as passed.

## 1. Audit (actual source)

| Area | Finding |
|---|---|
| Notification infrastructure | **None:** no Service Worker, Firebase Messaging, Cloud Functions, web manifest or Notification API use. |
| Cleaning due logic | `buildBoard()` (cleaning-model): fixed and `after` recurrence, skip / postpone, after-use (coalesced `<task>_u<event>`), seasons (`<task>_s<rev>`, off-season hidden), archived devices / rooms (`sourceActive`), eligibility (`mayAct`). Window: 60 days back, **14 days ahead**. Live store: tasks, occurrences, device events / states. |
| Maintenance due logic | `planStatus()` / `nextDue()` (after-last-completion, month clamp, Home time zone); faults `open` / `inProgress` / `resolved` / `closed` / `cancelled` (no due dates). Live store: plans, faults, records. |
| Modules / permissions | The registry requires each module to declare **its own** permissions. A "reminders" module would need new `reminders.*` permissions, so a **role-template bump** and an owner-run role update in every Home (production role data). **Rejected.** |
| App-level pages | `#/settings`, `#/family` and `#/join` are routed in `main.js` (lazy when Firebase-backed). Top bar: language chip and theme chip (the E2E tests select both by class). |
| Rules helpers | `isActiveMember(h)`, `can(h, ns, action)`. |

## 2. Decisions

1. **In-app reminders only.** "Background notifications: not implemented" is stated in the UI.
   - **No** Service Worker, FCM, Functions, browser-permission prompt or e-mail / SMS.
   - Push / background delivery is a **separate, later, explicitly approved** subphase.
2. **Reminders are an app-level page `#/reminders`, not a registry module.** Visible with `cleaning.view` **or** `maintenance.view`; each source is shown **only** with its own view permission; **no role-template change**.
3. **Derived, not copied.** Reminders are computed client-side from the already-authorized Cleaning and Maintenance stores, using their own functions (`buildBoard`, `planStatus`, `nextDue`).
   - No household feed and no second task store.
   - **Nothing a reminder does changes a task, occurrence, plan, fault or cost.**
4. **Presentation state is stored per user, per Home, owner-only**, so read / dismiss / snooze follow the user across tabs, reloads and devices.

## 3. What becomes a reminder

| Source | Included when | Excluded when | Key (identity) |
|---|---|---|---|
| Cleaning task occurrence | board item **overdue / today / upcoming (≤ look-ahead)** that the user **may act on** (`mayAct`); after-use pending; season checklist due | done; skipped today (all) or skipped fixed-calendar date; off-season; archived task / room / trigger device; postponed beyond the window | `c:<occurrenceId>@<shownDate>` (occurrence id = `<task>_<YYYYMMDD>` / `<task>_u<event>` / `<task>_s<rev>`). A postponement gives a new shown date, so a new key, so the reminder reappears. |
| Maintenance plan | active; **overdue / due today / upcoming ≤ look-ahead** | archived; a completed one-time plan | `p:<planId>@<nextDue>`. A completion moves `nextDue`, so a new key; the stale reminder disappears. |
| Maintenance fault | status **open / inProgress**, shown as **"Open issue", no date** | resolved, closed, cancelled | `f:<faultId>@r<rev>`. Any change (severity, reopen, …) gives a new key, so it shows again as unread. |

**One item per key** (deduplicated), sorted overdue, then today, then open faults (critical / high first), then upcoming by date.

## 4. Presentation state

### `homes/{h}/reminderStates/{uid}_{fnv64(key)}`

| Field | Rule |
|---|---|
| `ownerUid` | = caller (and the id prefix) |
| `key` | ≤ 200, `^[cpf]:` format |
| `state` | `read` \| `dismissed` \| `snoozed` |
| `snoozeUntil` | `YYYY-MM-DD` (1–366 days ahead) when snoozed, else null |
| `sourceKind` | `cleaning` \| `maintenancePlan` \| `maintenanceFault` |
| `updatedAt` | server time |
| `schemaVersion` | 1 |

- **Owner-only** get / list / create / update / delete; an active member of this Home only.
- **Delete** = clear presentation state (restore). Never canonical data.
- **Snooze** hides the reminder until `snoozeUntil` (Home date), then it returns **unread**. It never postpones the real task or plan.
- **Retention:** state documents whose key no longer matches a current reminder and are older than 30 days are deleted by the owner's client (bounded cleanup, at most 20 per visit).

### `homes/{h}/reminderPrefs/{uid}`

| Field | Rule |
|---|---|
| `lookAheadDays` | 1 / 3 / 7 / 14 (default 3) |
| `cleaning`, `maintenancePlans`, `maintenanceFaults` | booleans (presentation only) |
| `quietStart`, `quietEnd` | 0–23 \| null |
| audit | `updatedAt`, `schemaVersion` |

Owner-only.

### Counts
- **Actionable** = shown items (not dismissed or actively snoozed).
- **Unread** = actionable and not marked read.
- The bell shows the **actionable** count; the page shows both.
- Listener reconnects don't re-mark anything as unread: state is persisted.

## 5. In-app alerts and time

- **In-app alert:** a toast when a **new** overdue / due-today reminder appears **while the app is open** (never on first load). Once per key per tab session; suppressed during quiet hours and for disabled types.
- **Midnight / time zone:** the Home calendar date is re-checked every 60 s and on tab focus; a date change recomputes everything (Home time zone, so DST-safe).
- **Home switch / sign-out:** the stores are Home-scoped resources (disposed); the bell controller is disposed on shell rebuild; focus intents are Home-scoped and read-once.

## 6. Deep links

- **Cleaning:** focus `{view: today | overdue | upcoming, highlightTaskId}` opens Basic Cleaning on that tab and highlights and focuses the task.
- **Maintenance:** focus `{planId}` opens the Plans tab with the plan highlighted; `{faultId}` opens the fault detail.

## 7. Compatibility

- **Additive:** a new route, two new owner-only collections, the bell, a dashboard card, focus fields.
- **Untouched:** Cleaning, Maintenance, Finance, Savings and Zakat data, rules and logic.
- **Rollback:** older rules don't match the reminder paths, so the documents become unreachable (still stored) and the old client ignores them. Nothing needs deleting.

## 8. Revision: lightweight bell (decision log)

**First version:** the bell's live count ran on **every page**, so Savings, Finance, Family, Rooms and so on all opened the Cleaning and Maintenance listeners (tasks, 60 days of occurrences, device events, plans, faults, records) plus the reminder state.

- That's **extra Firestore reads for every user on every page**, which conflicts with "avoid costly listeners".
- On a single-core test machine it slowed heavy unrelated tests past their timeouts.

**Now:**
- The **count** (and its listeners) runs only on **Dashboard, Reminders, Cleaning and Maintenance**, where that data is already loaded.
- **Elsewhere the bell is a plain link** to Reminders: no count, no extra reads.
- **In-app alerts** therefore appear only on those pages.
- **Enforced by a static test and an E2E check** (no count on Rooms).
