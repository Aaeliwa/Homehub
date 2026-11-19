# Reminder Behavior Matrix (Phase 5.6)

Reminders are **derived** in the open app from Cleaning and Maintenance with those modules' own logic. **In-app only:** nothing is delivered while HomeHub is closed. **No reminder action changes a task, occurrence, plan, fault or cost.**

**Key** = the reminder's identity. A new key means a new reminder (unread, even if an older one was dismissed).

## Cleaning (requires `cleaning.view`; only tasks the user may act on, `mayAct`)

| Source state | Reminder | Key |
|---|---|---|
| Fixed-calendar / "after done" task, due **today** | Due today | `c:<task>_<YYYYMMDD>@<date>` |
| … missed earlier (latest missed day only) | Overdue | same scheme |
| … next occurrence within the look-ahead, **and nothing current** | Upcoming (**one per task**, never one per future day) | same scheme |
| Done | none (a recurring task shows only its next occurrence) | — |
| Skipped today / skipped fixed date | none | — |
| Postponed to date P | shown on P (upcoming / today / overdue) | `c:<task>_<orig YYYYMMDD>@<P>` (new key) |
| After-use: uses since the last completion | **one** reminder ("used N×") | `c:<task>_u<first event>@<day>` |
| Season start / end checklist | due once per transition | `c:<task>_s<rev>@<day>` |
| Seasonal in-season task while **off-season** | none | — |
| Archived task / room / trigger device | none (history kept in Cleaning) | — |
| Assigned to someone else; a child not listed | none | — |

## Maintenance (requires `maintenance.view`)

| Source state | Reminder | Key |
|---|---|---|
| Plan, next due (after the last completion, month-end clamped, Home date) < today | Overdue | `p:<plan>@<nextDue>` |
| … == today | Due today | same |
| … within the look-ahead | Upcoming | same |
| Plan completed (next due moves forward) | the old key disappears; the next cycle appears when in the window | new `nextDue`, so a new key |
| One-time plan completed / plan archived | none | — |
| Fault **open / inProgress** | **Open fault, "No due date"** (never a fabricated date), sorted by severity | `f:<fault>@r<rev>` |
| Fault resolved / closed / cancelled | none | — |
| Fault reopened, or severity / anything changed | reappears (unread) | new rev, so a new key |

## Presentation state (per user, per Home, owner-only)

| Action | Effect | Stored as |
|---|---|---|
| Mark read | stays listed, not bold | `reminderStates/<uid>_<fnv64(key)>` `{state: 'read'}` |
| Snooze 1 / 3 / 7 days | hidden until that Home date, then **unread** again | `{state: 'snoozed', snoozeUntil}` |
| Dismiss | hidden (recoverable under "Dismissed and snoozed") | `{state: 'dismissed'}` |
| Restore | back to normal | the document is deleted (owner-only) |
| Open | marks read, then deep-links and highlights the task / plan, or opens the fault | — |

**Counts:**
- **Actionable** = shown (not dismissed or actively snoozed); shown on the bell and the card.
- **Unread** = actionable and not read.
- A listener reconnect never re-marks anything as unread.

**Cleanup:** state documents whose key is no longer current **and** that are older than 30 days are deleted by the owner's client (≤ 20 per visit).

**Bell:**
- shows the live count only on **Dashboard, Reminders, Cleaning and Maintenance** (where that data is already loaded);
- elsewhere it's a plain link (no extra reads).

**In-app alert:**
- a toast for a **new** overdue / due-today reminder appearing while one of those pages is open;
- never on load; once per key per tab; silenced during quiet hours and for disabled types.

**Not in Phase 5.6:** background or push notifications, the browser Notification API, e-mail / SMS / WhatsApp.
