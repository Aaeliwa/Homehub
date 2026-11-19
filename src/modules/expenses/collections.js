/** Finance collection names (under homes/{homeId}/). Pure constants: no Firebase import. */
export const COL = Object.freeze({
  expenses: 'expenses', movements: 'walletMovements', wallets: 'wallets', cycles: 'spendingCycles', commitments: 'commitments',
  adjustments: 'budgetAdjustments', // Phase 5.3: append-only budget edit history
  periods: 'budgetPeriods', head: 'budgetHead', ledgers: 'refundLedgers',   // V6 batch 1
  capChanges: 'budgetCapChanges',
  monthly: 'financeMonthly',   // V6.2: monthly budget baseline + category limits (owner / admin)   // V6 batch 2: audited cap edits (create-only)
});
