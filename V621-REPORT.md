# HomeHub V6.2.1 — Report

Surgical patch on V6.2.0. No deployment, no data deletion, no migration to run.

## Changed files

- **Finance:** `expenses/page.js`, `tab-monthly.js`, `tab-wallets.js`, `expense-form.js`, `finance-monthly.js`, new `wallet-choice.js`; removed `tab-budget.js`, `tab-household.js`; `finance.css`
- **Calendar:** `calendar/calendar-model.js`, `calendar-store.js`, `calendar-repository.js`, `page.js`
- **Other:** `firestore.rules`, i18n `en`/`ar`, version 6.2.1
- **Tests:** new `finance-v621.test.mjs`; updated `calendar.test.mjs`, `rules.test.mjs`, `run-e2e.mjs`

## Behaviour

- **Finance tabs** are now Overview · History · Bills · Wallets. The 10-day Budget, Advanced and Household tabs are gone. Their records and ledger logic are kept, so balances don't change. Cash/Bank setup moved to Wallets.
- **History** uses the same table as the Overview: date, name (with "Added by"), category, wallet, signed amount, edit/void. It has search across all months, the month picker, Work/Vacation, category and wallet filters, and "Show more". It works in RTL and scrolls sideways on phones.
- **Wallet is the only expense source**, in Quick add, the Add dialog, the Overview, Edit and paying a bill. Cash and Bank are matched by wallet role (or, for older homes, wallet type), never by name. If either can't be matched, the user is told to set it up; nothing is chosen silently. The Mine scope and children use their own wallets.
  - New expenses are saved with `paymentMethod: null`.
  - Older payment-method values are kept unless the wallet is changed.
  - Records whose wallet is no longer available stay read-only.
- **Calendar → Settings → CSV Imports** lists each import with its file name, time, event count and status. **Remove Import** soft-deletes only that import's events. Events edited after import are kept by default, and there is a checkbox to remove them too.
  - Removal is done in chunks of 20. If it stops partway, the import shows "Removal interrupted" and can be resumed safely.
  - When a file is re-imported, previously removed rows are restored only if ticked one by one.
  - V6.2 imports made without a batch are listed separately and can only be deleted one at a time.

## Rules

- New `calendarImports` collection: private imports are visible only to whoever imported them, removing one needs `calendar.delete`, and there is no hard delete.
- Imported events must name an open import of the person importing them, and that link can't be changed later.
- Restoring a removed row is only allowed for CSV rows, never for manual events.
- Highest estimated rule cost is unchanged at 1,026.

## Tests

| Command | Result |
|---|---|
| `npm test` | **371/371** |
| `npm run test:e2e` | **122/122** |
| `npm run test:rules:smoke` | 151 tests, no JavaScript errors |
| `npm run test:rules` / `:strict` | **NOT RUN** (no emulator here) |
| `npm run rules:limits` | **NOT RUN** |

E2E steps that used the removed screens (cycles, period/cap editing, reconcile, refund, renaming accounts) were retired or rewritten for the screens that remain.

## Remaining limitations

- Reconcile, refund and budget-period screens are no longer reachable; their records stay.
- Rule changes have not been run against the emulator.

## Deploy (after both emulator runs pass)

`firebase deploy --only firestore:rules`, then `firebase deploy --only hosting`.
