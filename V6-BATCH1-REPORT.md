# HomeHub V6 — Finance Batch 1 Report (6.0.0-batch.1)

**Baseline:** the B0-corrected V5.9.1.

**Not done:** no deployment, data deletion or migration. Savings, Zakat, Cleaning, Maintenance and Reminders source is untouched.

## Decisions applied (approved specs; noted in `finance-v6.js`)

| Topic | Decision |
|---|---|
| S1 | Opening = one `op_{account}` dated `openingDate`. Positive → incoming; negative → outgoing (overdraft); zero → none. Never income. |
| F1 | Balance = Σ records dated ≥ `openingDate` (counted once). Pre-V6 wallets keep the V5 formula. |
| S4 | No pending state. Visa = `debit_card` on the **bank** account (rules + model). |
| Budget | One manual household cap per period; half-open, immutable, non-overlapping (serialized `budgetHead`). No carry-forward; no adjustments in remaining. Late entry → current open period (R1); gaps → unbudgeted (R2). Household aggregates exclude private records. |
| S3 | `refundLedgers/{expenseId}` (monotonic `refundSeq`, `refundedMinor` ≤ original). Void only the latest created refund, with a reason, in an open period. Refunded expenses' money fields are frozen. |
| S2 | Savings pairing: money compares minor units + currency; metal compares cost; mg is never compared with money; metal `transfer_out` denied. |
| B1 / Zakat | Finance can't void `sv_*`, openings or `zk_*`, nor re-price `zk_*`. |
| B5 | Refund counters are kept off the expense document. The privacy-only expense arm drops provably redundant checks. The refund branch was slimmed to meet the **750** `walletMovements` tripwire. |
| OD-3 (pending) | Zakat expenses stay **out** of the budget (V5 behaviour). One predicate: `budgetEligible`. |

## Implemented

- **Pure model** (`finance-v6.js`); **store** methods (account + opening, income, reconcile, period + head, close, refund, refund void), each one atomic batch.
- **Rules:** new `refundLedgers`, `budgetPeriods`, `budgetHead`; extended `wallets` / `expenses` / `walletMovements`.
- **UI:** a **Household** tab (accounts, spendable, budget allowance, income, reconcile, expense "paid with", refunds).
- **Unchanged (byte-identical):** the 26 protected rule blocks (Savings, Zakat, Cleaning, Maintenance, Reminders, membership, Devices, Rooms, settings).

## Tests

| Suite | Result |
|---|---|
| `npm test` | **331/331 PASS** (+9) |
| Browser E2E | **118/118 PASS** (+V6-UI: the canonical figures EN / AR, refund / void, 2nd member) |
| Rules-file check (JavaScript only) | 139 tests; L14 whitelisted |
| **Emulator Normal / Strict** | **NOT RUN** (no `firebase-tools` / network). New: V6-1…V6-6 (expected **139/139**) |
| Rule cost (estimator) | max 1,026; `walletMovements` create 726 / 750; expenses update 969 |

**Existing tests updated, intentionally and kept exact:**
- listener count 12 → 14 (two household-only collections);
- the privacy guard **extended** to the new collections;
- the Finance tab count 5 → 6.

**Defects caught by tests:**
- the V6 state survived `dispose()`;
- an unconstrained budget listener (privacy guard);
- the rule-cost overruns;
- a `field()` misuse.

## Remaining / blockers

1. **Run** the Normal + Strict emulator and `rules:limits`. **B0-style gate:** both must pass before any deploy.
2. **OD-3:** Zakat expenses in the budget (yes / no).
3. **Deferred:**
   - cap edits mid-period (needs an audit record);
   - retiring the per-wallet cycles and `funding` / `adjustment` (still used by the existing UI);
   - an account rename / UI for more accounts;
   - the clean-start procedure.
