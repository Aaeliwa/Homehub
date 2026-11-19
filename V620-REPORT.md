# HomeHub V6.2.0 — Report

No deployment, data deletion or migration.

## Changes

- **Finance Overview** (homes with Cash/Bank): search (all months) → month arrows/picker → available balance + Cash/Bank (all-time) + month spent → one budget bar (collapsed; category limits inside) → Add expense/money, transfer → due bills (Mark as paid) → newest-first history (edit, delete = void with reason).
- **Budget:** `financeMonthly/{YYYY-MM}` (owner/admin); inherited by later months; past months read-only.
- **Work/Vacation filter + summary** by each expense's own date, both ends inclusive.
- **10-day budget:** out of navigation; under **Advanced** only while cycles exist or Cash/Bank isn't set up. Records untouched.
- **Calendar module:** month/week/agenda, dashboard month widget, Google CSV import, off-duty suggestions confirmed as vacation, soft delete, private events.
- **Cleaning:** one "Pending cleaning tasks" reminder per day.

## Migration

Additive only. Role template **v8** adds `calendar.*`: existing homes' owners must run **Settings → Update default roles** so members see Calendar.

## Tests

| Command | Result |
|---|---|
| `npm test` | **358/358** |
| `npm run test:e2e` | **121/121** |
| `npm run test:rules:smoke` | 150 tests, JavaScript-clean |
| `npm run test:rules` / `:strict` | **NOT RUN** (no emulator). Expected 150/150 |
| `npm run rules:limits -- <log>` | **NOT RUN**. Estimator max 1,026 |

Rules vs V6.1.1: + `calendarEvents`, `financeMonthly`; `adoptionTemplateVersion` 7→8; nothing else changed.

## Limits

- No calendar recurrence; calendar reminders are in-app only.
- Days between shifts are only suggestions; nothing is classified as vacation automatically.

## Manual check

1. Finance: search across years; backdated expense; budget; pay a bill once.
2. Calendar: import the CSV (8 events); re-import adds none; confirm a vacation; filter Finance by it.
3. Dashboard calendar widget; one cleaning reminder.

## Deploy (after both emulator runs pass)

```cmd
firebase deploy --only firestore:rules
firebase deploy --only hosting
```
