import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCleanStartPlan } from '../../tools/clean-start-dryrun.mjs';

test('clean-start dry run: exact Home-scoped paths; zk_* / sv_* / Savings / Zakat / V6 accounts preserved; pairing audit; stable checksum', () => {
  const docs = {
    expenses: [{ id: 'e1' }, { id: 'zk_r1' }, { id: 'zk_orphan' }],
    walletMovements: [{ id: 'm1' }, { id: 'sv_t1', savingsTransferId: 't1' }, { id: 'sv_t9', savingsTransferId: 't9' }],
    wallets: [{ id: 'old', active: true }, { id: 'gone', active: false }, { id: 'bank', active: true, role: 'bank' }],
    spendingCycles: [{ id: 'c1' }], budgetAdjustments: [{ id: 'c1_r1' }], commitments: [{ id: 'k1' }],
    savingsEvents: [{ id: 't1_in' }], zakatRecords: [{ id: 'r1', linkedExpenseId: 'zk_r1' }],
  };
  const p = buildCleanStartPlan({ id: 'H1', name: 'My Home' }, docs);
  assert.deepEqual(p.delete.paths, ['homes/H1/expenses/e1', 'homes/H1/walletMovements/m1', 'homes/H1/spendingCycles/c1', 'homes/H1/budgetAdjustments/c1_r1', 'homes/H1/commitments/k1']);
  assert.ok(p.delete.paths.every((x) => x.startsWith('homes/H1/')), 'Home-scoped');
  assert.ok(!p.delete.paths.some((x) => /\/(zk_|sv_)/.test(x)), 'Zakat / Savings links never listed for deletion');
  assert.deepEqual(p.archive.paths, ['homes/H1/wallets/old'], 'active pre-V6 wallets only');
  assert.deepEqual(p.preserve.v6Accounts, ['homes/H1/wallets/bank']);
  assert.deepEqual([p.preserve.zakatExpenses.length, p.preserve.savingsMovements.length, p.preserve.counts.savingsEvents, p.preserve.counts.zakatRecords], [2, 2, 1, 1]);
  assert.deepEqual([p.pairingAudit.orphanSavingsMovements, p.pairingAudit.orphanZakatExpenses, p.pairingAudit.ok], [['homes/H1/walletMovements/sv_t9'], ['homes/H1/expenses/zk_orphan'], false]);
  assert.equal(p.delete.sha256, buildCleanStartPlan({ id: 'H1', name: 'My Home' }, docs).delete.sha256, 'checksum is deterministic (re-run comparison)');
  assert.notEqual(p.delete.sha256, buildCleanStartPlan({ id: 'H1', name: 'My Home' }, { ...docs, commitments: [] }).delete.sha256);
});
