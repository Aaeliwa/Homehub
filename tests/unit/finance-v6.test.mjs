import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v6 from '../../src/modules/expenses/finance-v6.js';

const D = '2026-11-10';
const bank = { id: 'bank', role: 'bank', currency: 'EGP', visibility: 'household', active: true, openingDate: D };
const cash = { id: 'cash', role: 'cash', currency: 'EGP', visibility: 'household', active: true, openingDate: D };
const mv = (x) => ({ status: 'active', audience: 'household', currency: 'EGP', fromWalletId: null, toWalletId: null, ...x });
const ex = (x) => ({ status: 'active', audience: 'household', currency: 'EGP', category: 'groceries', ...x });
const P1 = { id: 'p_20261101', startDate: '2026-11-01', endDateExclusive: '2026-12-01', capMinor: 2000000, status: 'open' };

test('canonical (AT1/AT2): Visa debit reduces Bank only; budget is an allowance; no income, no debt', () => {
  const movements = [mv({ id: 'op_bank', type: 'opening', amountMinor: 6000000, date: D, toWalletId: 'bank' }), mv({ id: 'op_cash', type: 'opening', amountMinor: 300000, date: D, toWalletId: 'cash' })];
  const visa = ex({ id: 'e1', walletId: 'bank', paymentMethod: 'debit_card', amountMinor: 300000, date: D, periodId: P1.id });
  const data = { expenses: [visa], movements };
  assert.deepEqual([v6.accountBalance(bank, data), v6.accountBalance(cash, data), v6.spendable([bank, cash], data)], [5700000, 300000, 6000000]);
  assert.equal(v6.incomeTotal(movements), 0, 'openings are not income');
  assert.equal(v6.budgetStatus(P1, data).remainingMinor, 1700000);
  assert.ok(v6.paymentOk('debit_card', bank)); assert.ok(!v6.paymentOk('debit_card', cash), 'Visa only from a bank account');
  const viaCash = { expenses: [{ ...visa, walletId: 'cash', paymentMethod: 'cash' }], movements };
  assert.deepEqual([v6.accountBalance(bank, viaCash), v6.accountBalance(cash, viaCash), v6.budgetStatus(P1, viaCash).remainingMinor], [6000000, 0, 1700000]);
});

test('S1/F1 openings: +55,000 / 0 / −1,200; counted once; pre-cutoff excluded; legacy wallets keep V5', () => {
  assert.deepEqual(v6.openingFields(bank, 5500000), { type: 'opening', amountMinor: 5500000, currency: 'EGP', date: D, fromWalletId: null, toWalletId: 'bank' });
  assert.equal(v6.openingFields(bank, 0), null);
  const neg = v6.openingFields(bank, -120000); assert.deepEqual([neg.fromWalletId, neg.toWalletId, neg.amountMinor], ['bank', null, 120000]);
  const ops = [mv({ id: 'op_bank', ...neg })];
  assert.equal(v6.accountBalance(bank, { movements: ops }), -120000);
  assert.equal(v6.accountBalance(bank, { movements: [...ops, mv({ type: 'income', amountMinor: 1000000, date: D, toWalletId: 'bank' })] }), 880000);
  const pos = [mv({ type: 'opening', amountMinor: 5500000, date: D, toWalletId: 'bank' }), mv({ type: 'savings', amountMinor: 500000, date: '2026-11-05', fromWalletId: 'bank' })];
  assert.equal(v6.accountBalance(bank, { movements: pos }), 5500000, 'pre-D savings transfer excluded (already in the real balance)');
  assert.equal(v6.accountBalance(bank, { movements: [...pos, mv({ type: 'savings', amountMinor: 200000, date: D, fromWalletId: 'bank' })] }), 5300000, 'on D: counted');
  assert.equal(v6.datedOk(bank, '2026-11-09'), false);
  const legacy = { id: 'w', currency: 'EGP' };
  assert.equal(v6.accountBalance(legacy, { movements: [mv({ type: 'funding', amountMinor: 100, date: '2020-01-01', toWalletId: 'w' })] }), 100, 'no openingDate → V5 formula');
});

test('transfers, reconciliation, income: balances move; P&L and budget do not', () => {
  const base = [mv({ type: 'opening', amountMinor: 6000000, date: D, toWalletId: 'bank' }), mv({ type: 'opening', amountMinor: 300000, date: D, toWalletId: 'cash' })];
  const atm = mv({ type: 'transfer', amountMinor: 200000, date: D, fromWalletId: 'bank', toWalletId: 'cash' });
  const rec = mv({ type: 'reconciliation', ...v6.reconciliationFields({ wallet: cash, appBalance: 500000, actualBalance: 480000, date: D, reason: 'counted' }) });
  const data = { expenses: [], movements: [...base, atm, rec] };
  assert.deepEqual([v6.accountBalance(bank, data), v6.accountBalance(cash, data), v6.incomeTotal(data.movements), v6.budgetStatus(P1, data).spentMinor], [5800000, 480000, 0, 0]);
  assert.equal(v6.reconciliationFields({ wallet: cash, appBalance: 5, actualBalance: 5, date: D, reason: 'x' }), null);
  assert.throws(() => v6.reconciliationFields({ wallet: cash, appBalance: 5, actualBalance: 4, date: D, reason: ' ' }), /reasonRequired/);
  const inc = v6.incomeFields({ wallet: bank, amountMinor: 1500000, date: D, today: D, source: 'Salary' });
  assert.equal(v6.incomeTotal([mv(inc)]), 1500000);
  assert.equal(v6.budgetStatus(P1, { expenses: [], movements: [mv(inc)] }).capMinor, 2000000, 'cap is manual — income never changes it');
  assert.throws(() => v6.incomeFields({ wallet: bank, amountMinor: 1, date: '2026-11-13', today: D }), /incomeFuture/);
  assert.throws(() => v6.incomeFields({ wallet: bank, amountMinor: 1, date: '2026-11-09', today: D }), /beforeOpening/);
});

test('periods: half-open, immutable chain, attribution (R1 late entry, R2 gap), close bound, overspend', () => {
  const P2 = { id: 'p_20261201', startDate: '2026-12-01', endDateExclusive: '2027-01-01', capMinor: 100, status: 'open' };
  assert.equal(v6.periodFor([P1, P2], '2026-11-30').id, P1.id); assert.equal(v6.periodFor([P1, P2], '2026-12-01').id, P2.id, 'end is exclusive');
  assert.throws(() => v6.validatePeriod({ startDate: '2026-11-20', endDateExclusive: '2026-12-20', capMinor: 1 }, { endDateExclusive: '2026-12-01' }), /periodOverlap/);
  assert.throws(() => v6.validatePeriod({ startDate: '2026-12-01', endDateExclusive: '2026-12-01', capMinor: 1 }), /periodDates/);
  const closed = { ...P1, status: 'closed' };
  assert.deepEqual(v6.attribute([closed, P2], { lastPeriodId: P2.id }, '2026-11-15'), { periodId: P2.id, lateEntry: true });
  assert.deepEqual(v6.attribute([closed], { lastPeriodId: closed.id }, '2026-11-15'), { periodId: null, lateEntry: true }, 'no open period → unbudgeted late');
  assert.deepEqual(v6.attribute([P1], null, '2027-02-01'), { periodId: null, lateEntry: false }, 'gap → unbudgeted');
  assert.equal(v6.canClose(P1, Date.parse('2026-12-01T11:59:00Z')), false); assert.equal(v6.canClose(P1, Date.parse('2026-12-01T12:00:00Z')), true);
  const over = v6.budgetStatus(P1, { expenses: [ex({ periodId: P1.id, amountMinor: 2100000 })] });
  assert.deepEqual([over.remainingMinor, over.overspent], [-100000, true]);
});

test('privacy and OD-3: private records and Zakat payments never enter household budget / income', () => {
  const data = { expenses: [ex({ periodId: P1.id, amountMinor: 100, audience: 'restricted' }), ex({ id: 'zk_1', category: 'zakat', periodId: P1.id, amountMinor: 999 }), ex({ periodId: P1.id, amountMinor: 50 })],
    movements: [mv({ type: 'income', amountMinor: 7, date: D, toWalletId: 'p', audience: 'restricted' })] };
  assert.equal(v6.budgetStatus(P1, data).spentMinor, 50); assert.equal(v6.incomeTotal(data.movements), 0);
  const priv = { id: 'p', role: 'cash', visibility: 'private', active: true, currency: 'EGP' };
  assert.equal(v6.spendable([priv], { movements: [mv({ type: 'funding', amountMinor: 5, date: D, toWalletId: 'p' })] }), 0);
});

test('S3 refunds (Stage 1b table): sequence, cap, latest-only void with reason, money lock', () => {
  const e = ex({ id: 'e1', walletId: 'bank', amountMinor: 300000, date: D, periodId: P1.id });
  const r1 = v6.refundPlan({ expense: e, ledger: null, amountMinor: 100000, date: D, attribution: { periodId: P1.id } });
  assert.deepEqual([r1.id, r1.ledgerMode, r1.ledger.refundSeq, r1.ledger.refundedMinor, r1.movement.toWalletId], ['e1_rf1', 'set', 1, 100000, 'bank']);
  const L1 = r1.ledger;
  const r2 = v6.refundPlan({ expense: e, ledger: L1, amountMinor: 50000, date: '2026-12-02', attribution: { periodId: 'p_20261201' } });
  assert.deepEqual([r2.id, r2.ledgerMode, r2.ledger.refundedMinor, r2.movement.periodId], ['e1_rf2', 'update', 150000, 'p_20261201']);
  assert.throws(() => v6.refundPlan({ expense: e, ledger: r2.ledger, amountMinor: 150001, date: D, attribution: {} }), /refundTooLarge/);
  assert.throws(() => v6.refundPlan({ expense: { ...e, status: 'void' }, ledger: null, amountMinor: 1, date: D, attribution: {} }), /refundVoided/);
  const rf2 = mv({ ...r2.movement, id: r2.id }); const rf1 = mv({ ...r1.movement, id: r1.id });
  const v = v6.refundVoidPlan({ refund: rf2, ledger: r2.ledger, reason: 'duplicate', periodOpen: true });
  assert.deepEqual([v.ledger.refundSeq, v.ledger.refundedMinor], [2, 100000], 'seq never decreases');
  assert.throws(() => v6.refundVoidPlan({ refund: rf1, ledger: v.ledger, reason: 'x', periodOpen: true }), /refundNotLatest/);
  assert.throws(() => v6.refundVoidPlan({ refund: rf2, ledger: r2.ledger, reason: '', periodOpen: true }), /reasonRequired/);
  assert.throws(() => v6.refundVoidPlan({ refund: rf2, ledger: r2.ledger, reason: 'x', periodOpen: false }), /periodClosed/);
  const data = { expenses: [e], movements: [mv({ type: 'opening', amountMinor: 6000000, date: D, toWalletId: 'bank' }), rf1] };
  assert.deepEqual([v6.accountBalance(bank, data), v6.budgetStatus(P1, data).spentMinor], [5800000, 200000]);
  assert.equal(v6.expenseMoneyLocked(v.ledger), true, 'locked once ever refunded'); assert.equal(v6.expenseVoidable(v.ledger), false);
});

test('S2 savings pairing: units never mixed; amount, currency and direction must match', () => {
  const m = { type: 'savings', savingsTransferId: 't', amountMinor: 500000, currency: 'EGP', fromWalletId: 'bank', toWalletId: null };
  const money = { type: 'transfer_in', transferId: 't', walletId: 'bank', unit: 'minor', qty: 500000, currency: 'EGP', costMinor: null };
  assert.ok(v6.savingsPairOk(money, m));
  assert.ok(!v6.savingsPairOk({ ...money, qty: 5000 }, m), 'major/minor mix-up');
  assert.ok(!v6.savingsPairOk({ ...money, currency: 'USD' }, m));
  assert.ok(!v6.savingsPairOk({ ...money, type: 'transfer_out' }, m), 'direction');
  const metal = { type: 'transfer_in', transferId: 't', walletId: 'bank', unit: 'mg', qty: 10000, costMinor: 500000, costCurrency: 'EGP' };
  assert.ok(v6.savingsPairOk(metal, m)); assert.ok(!v6.savingsPairOk({ ...metal, costMinor: 10000 }, m), 'mg never compared with money');
  assert.ok(!v6.savingsPairOk({ ...metal, type: 'transfer_out' }, { ...m, fromWalletId: null, toWalletId: 'bank' }), 'metal transfer_out denied');
});

test('batch 2: budget breakdown — refunds restore, Zakat excluded but reported; audited cap plan; V6 mode; closed-period lock', () => {
  const P = { id: 'p1', capMinor: 2000000, status: 'open', rev: 1 };
  const data = { expenses: [ex({ periodId: 'p1', amountMinor: 300000 }), ex({ id: 'zk_9', category: 'zakat', periodId: 'p1', amountMinor: 250000 })],
    movements: [mv({ type: 'refund', periodId: 'p1', amountMinor: 100000 })] };
  const b = v6.budgetStatus(P, data);
  assert.deepEqual([b.grossMinor, b.refundsMinor, b.spentMinor, b.remainingMinor, b.excludedMinor], [300000, 100000, 200000, 1800000, 250000]);
  const plan = v6.capChangePlan(P, { toMinor: 2500000, reason: 'Guests this month' });
  assert.deepEqual([plan.id, plan.periodPatch, plan.change.fromMinor, plan.change.toMinor], ['p1_r2', { capMinor: 2500000, rev: 2 }, 2000000, 2500000]);
  assert.equal(v6.capChangePlan(P, { toMinor: 2000000, reason: 'x' }), null, 'same cap → nothing to record');
  assert.throws(() => v6.capChangePlan(P, { toMinor: 1, reason: ' ' }), /reasonRequired/);
  assert.throws(() => v6.capChangePlan({ ...P, status: 'closed' }, { toMinor: 1, reason: 'x' }), /periodClosed/);
  assert.equal(v6.v6Mode({ wallets: [{ role: 'bank' }], periods: [] }), true); assert.equal(v6.v6Mode({ wallets: [{ id: 'w' }], periods: [] }), false);
  assert.equal(v6.periodLocked([{ id: 'p1', status: 'closed' }], 'p1'), true); assert.equal(v6.periodLocked([P], 'p1'), false); assert.equal(v6.periodLocked([P], null), false);
});
