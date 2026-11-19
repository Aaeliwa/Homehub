# HomeHub V5 — Phase 5.3 Report: Home Routine & Cleaning + Edit Active Budget

**Version:** 5.7.0 • **Baseline:** Phase 5.2.1 ZIP (v5.6.1). Your real emulator runs (normal and strict 90/90) are the rules baseline. **Recommendation: NOT APPROVED FOR DEPLOYMENT** until the real emulator passes the normal and strict runs (101 tests each). Nothing was deployed; no production data was touched.

## 1. Audit (before any change)

**Baseline measured here:** unit + static 242/242, browser 105/105.

| Area | Finding |
|---|---|
| Cleaning | Placeholder only (`enabled: false`, metadata). Its permissions `cleaning.view` / `create` / `edit` / `delete` / `complete` were **already seeded** in every role since Phase 1, with child view + complete. So no new permission and no role-template change were needed. |
| Rooms | Shared household structure; `isActiveRoom()` exists. Devices already use the "check the room only when it changes" pattern, which Cleaning reuses. |
| Budget editing | The store had an **unused** `editCycle()`. Its rule allowed changing amount, end date and duration (amount > 0) with **no audit**. No screen and no deployed version used it. |
| Budget display | `cycleStats()` computes remaining = budget + carry-in − spent, the daily allowance and pace. It is reused unchanged for the preview. |
| Members / guardians | `guardianUids`, `isGuardianOf`, `isChildMember`, the member directory (`directory().nameOf`, `childrenOf`): all reused. |
| Indexes | Only single-field queries before; the same holds after. |

## 2. Architecture

**Workstream B: Edit Active Budget**
- `src/modules/expenses/budget-edit.js` (pure): validation, before/after preview (via `cycleStats`), and the write set.
- **Store** `editBudget()`: ONE batch = cycle `{budgetMinor, budgetRevision: n+1}` + `budgetAdjustments/{cycleId}_r{n+1}`. A rules denial is reported as a conflict.
- **Store** `adjustmentsFor(cycleId)`: the history. Two listeners were added (household + mine), using the same privacy query shapes as Finance.
- **UI** (`tab-budget.js`): an "Edit budget" button on the active cycle (only for those who may manage it); a dialog showing current budget, spent, remaining, days left and daily allowance; live before → after preview; over-budget warning; optional reason; and a "Budget changes" history.

**Workstream A: Home Routine & Cleaning** (`src/modules/cleaning/`):
- `cleaning-model.js` (pure): validation, recurrence (once / every N days / weekdays every N weeks / monthly with last-day clamp), a bounded range (400 days, refused not truncated), `mayAct`, the audited action state machine, and the dashboard board (missed-occurrence policy).
- `cleaning-repository.js` (the only file with cleaning paths), `cleaning-store.js` (2 listeners, disposed with the scope), `cleaning-service.js`.
- `page.js`: progress; room filter; Today / My tasks / Shared available / Upcoming / Overdue / Done / Manage; task form; claim / done / release / reopen (reason) / history; archive / restore with confirmation.
- `widget.js`: the dashboard card.
- **Data:**
  - `cleaningTasks/{id}`;
  - `cleaningOccurrences/{taskId}_{YYYYMMDD}`, created **only when someone acts**, so there are no pre-generated or unbounded futures and **no duplicates**;
  - `cleaningLog/{occ}_r{n}`, append-only audit.
- **Time zone:** all scheduling uses the Home's calendar date (`todayIn(home.timezone)`).
- **Missed occurrences:** only the most recent missed date per task is actionable; earlier misses are counted ("missed N times") and never pile up.
- **Offline return:** occurrences are evaluated against today on every render. Actions are atomic batches; a stale view is refused by the rules and reported as a conflict, then the live list refreshes.
- **Shell:** the mobile dock now shows "More" when there are more than 4 destinations. This was found by existing tests: adding Cleaning had pushed Rooms and Devices off the mobile dock.

## 3. Status

**Implemented and tested** (unit + static + browser):
- Edit Budget: increase, decrease, below spent, zero, invalid values, recalculation (your example: 10,000 / 2,500 / 12,000 gives **9,500**), wallet balance and expenses unchanged, history, conflict mapping, closed-cycle refusal (model).
- Cleaning:
  - CRUD;
  - all recurrence kinds, including month ends, leap years and year boundaries;
  - time zone across midnight;
  - missed policy;
  - deterministic IDs and "first claimer wins" (store + browser);
  - claim → done → reopen (reason) → history;
  - children and assignment eligibility (model);
  - rooms: renamed, archived, filter.
- Arabic RTL and mobile (390 px) without overflow.

**Implemented, rules UNVERIFIED** (real emulator not runnable here): B1–B6 and C1–C5 in `tests/rules/rules.test.mjs`, covering:
- atomic and audited budget edits; stale and concurrent edits; immutability; closed cycles; unauthorized, cross-Home and private-wallet access;
- task permissions, archived rooms, claim concurrency, valid dates, the revision chain, reopen reason, children / guardians, and cross-Home access.

**Not implemented** (out of scope or deliberate):
- reminders and notifications;
- per-task time of day (dates only);
- task photos / attachments;
- reassigning the "shared with everyone" pool per child;
- editing a budget's dates or duration (explicitly excluded by the brief, now impossible by rule);
- reopening a *closed* cycle's budget.

## 4. Tests

| Suite | Result |
|---|---|
| `npm test` | **258/258** (+16 new: 6 budget, 10 cleaning) |
| Browser E2E | **107/107** (+ B-UI, + C-UI) |
| Emulator | **101** (+6 budget, +5 cleaning): **UNVERIFIED** |
| Offline rules-file check | No JavaScript-level failures |

**Existing tests updated (intent kept; see TESTING.md):**
- "planned modules untouched" checks now exclude Cleaning;
- planned tiles 7 → 6;
- finance listeners 10 / 5 → 12 / 6;
- dock icons +1 for "More";
- the rules helper allow-list gained the built-in `string()`.

**Defects found by the tests and fixed:**
- the mobile dock lost Rooms / Devices;
- interval 0 was silently saved as daily;
- recurrence ranges were silently truncated;
- the "former member" label flashed while names were loading;
- a dashboard card could render "null";
- a stale completion note showed on reopened tasks.

## 5. Limitations
- **Real emulator results are unverified;** deployment remains blocked until they pass.
- The rules bound an occurrence date to the task's range (and the exact date for one-time tasks), but **cannot iterate recurrence**. That a recurring task's date falls on the exact weekday / interval is enforced by the client.
- The overdue list looks back 60 days; misses older than that are not counted.
- Budget history adds two finance listeners per Home (household + mine).
