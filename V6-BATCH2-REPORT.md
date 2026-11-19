# HomeHub V6 — Batch 2 Report (6.0.0-batch.2)

**Baseline:** batch 1 + the V6-4 fix (verified present). **Not done:** no deployment, deletion or migration. Savings / Zakat / Cleaning / Maintenance / Reminders source is unchanged; their 26 rule blocks are byte-identical.

## Completed

- **One budget model:**
  - V6 Homes (accounts or periods) no longer link expenses or commitment payments to wallet cycles;
  - Overview, the Budget tab and the dashboard widget show the household budget;
  - wallet cycles are read-only history;
  - non-V6 Homes are unchanged; no records are reinterpreted.
- **Zakat (OD-3):** Zakat payments reduce the account balance but never the budget; they're shown as "Zakat — not in budget" and Finance can't void or re-price them.
- **Accounts:**
  - ATM withdrawal / cash deposit transfers (neutral; not before an opening);
  - rename (name only);
  - account activity labelled by type.
- **Budget:**
  - breakdown (eligible spending, refunds, net, remaining);
  - **audited cap edits** (period + create-only `budgetCapChanges/{period}_r{rev}` with from / to / reason / actor / server time, one batch; open periods; `manageBudgets`).
- **Closed periods read-only:** no money edits / voids, no new attribution; date edits re-attribute.
- **UI:** EN / AR, RTL; a mobile account-row overlap found by screenshot and fixed.

## Deferred

- A cap-history viewer (records are stored and readable).
- More than one Bank / Cash account; deleting or retiring wallet-cycle code.
- `walletMovements` create cost is at its **750** tripwire (zero headroom): future movement types need slimming first.

## Files changed (vs batch 1)

- `firestore.rules`, `assets/css/modules/finance.css`, `package.json`, `src/config/app-config.js`
- i18n `en.js` / `ar.js`
- `src/modules/expenses/`: `collections.js`, `finance-store.js`, `finance-v6.js`, `page.js`, `tab-budget.js`, `tab-household.js`, `widget.js`
- tests: `run-e2e.mjs`, `rules.test.mjs`, `finance-v6.test.mjs`, `finance-v6-store.test.mjs`

## Test results

| Suite | Result |
|---|---|
| `npm test` | **333/333 PASS** |
| Browser E2E | **119/119 PASS** (+V6-UI2: Zakat, ATM, rename, cap edit, one budget model, AR mobile) |
| Rules-file check (JavaScript only) | 142 tests; L14 whitelisted |
| **Emulator Normal / Strict** | **NOT RUN** (no `firebase-tools` / network). Expected **142/142** (+V6-8 cap-edit audit, +V6-9 closed-period / transfer / rename) |
| Rule cost (estimator) | max 1,026, none > 1,100; expenses update 1,018; `walletMovements` create 750 / 750 |

## Release blockers

1. **Your** Normal + Strict emulator runs and `rules:limits` on both logs.
2. **Product point:** members hold `manageBudgets` by default (role template), so they can create periods and edit caps. Confirm, or approve restricting it to owners / admins.
