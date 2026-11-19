# Home-scoped clean start (V6) — procedure (nothing here was executed)

**Scope:**
- **one Home** `homes/{H}`;
- **never** other Homes, `users/*` or `invites/*`.

**Disposable trial Finance data in H:**
- `expenses` **except `zk_*`** (Zakat-linked);
- `walletMovements` **except `sv_*`** (Savings-linked);
- `spendingCycles`, `budgetAdjustments`, `commitments`.

**Preserved:**
- Savings / Zakat (`savingsAssets`, `savingsEvents`, `zakatRecords`, `priceQuotes`), `zk_*`, `sv_*`;
- every wallet (**archived, not deleted**);
- members / roles;
- Rooms, Devices, Cleaning, Maintenance, Reminders.

## Steps

1. **Dry run (read-only):**

   ```
   node tools/clean-start-dryrun.mjs --project <id> --home <H> --confirm-name "<Home name>" --out plan.json
   ```

   It refuses to run unless the stored name matches. `plan.json` lists the **exact paths** (`delete.paths`, `archive.paths`, `preserve.*`), `delete.sha256` and the **`pairingAudit`**. Review every path; if `pairingAudit.ok` is false, stop.
2. **Written approval** of H, `plan.json` (by its `delete.sha256`), and the start date D. **This is separate from any deployment approval.**
3. **Archive-first freeze:** archive the listed old wallets in the app (Wallets → Archive). Rules then refuse every wallet-linked write to them.
4. **Re-run the dry run;** `delete.sha256` must equal the approved one (the same set of paths).
5. **Deletion — a separately approved Admin step, not provided here:**
   - delete only the paths in the approved `plan.json`;
   - batches ≤ 400;
   - log every id.
6. **In the app:** Household → Set up accounts (openings = the real balances), then New budget period.
7. **Post-check:** re-run the dry run. `delete.paths` must be empty, `preserve` unchanged, Zakat assessments identical.

**Rollback:** keep the step-1 JSON and an export taken before step 5. An Admin re-create of the logged ids is the only undo; writes made after step 6 aren't covered.
