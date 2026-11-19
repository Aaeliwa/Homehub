import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFinanceStore } from '../../src/modules/expenses/finance-store.js';

/** Minimal fake repo: in-memory docs; commit applies ops; watch delivers per collection/kind. */
function fakeRepo() {
  const db = new Map(); const ws = new Set(); let n = 0; const commits = [];
  const docs = (name) => [...db.entries()].filter(([k]) => k.startsWith(`${name}/`)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  return { db, commits,
    now: () => 'NOW', newId: (h, name) => `${name}_${++n}`,
    watch(h, name, kind, uid, on) { const fn = () => on(docs(name).filter((d) => kind === 'household' ? (d.audience === 'household' || d.visibility === 'household') : (d.readers || []).includes(uid))); ws.add(fn); queueMicrotask(fn); return () => ws.delete(fn); },
    read: async (h, name, id) => (db.has(`${name}/${id}`) ? { id, ...db.get(`${name}/${id}`) } : null),
    async commit(h, ops) { commits.push(ops.map((o) => `${o.mode}:${o.name}/${o.id}`)); for (const o of ops) db.set(`${o.name}/${o.id}`, o.mode === 'set' ? { ...o.data } : { ...db.get(`${o.name}/${o.id}`), ...o.data }); for (const fn of ws) fn(); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function setup() {
  const repo = fakeRepo(); const s = createFinanceStore({ homeId: 'H', uid: 'u1', repo, homeCurrency: 'EGP' });
  s.ensure({ canViewHousehold: true }); s.subscribe(() => {}); await tick(); return { repo, s };
}
const M = { memberUids: ['u1'] };

test('V6 store: accounts with direction-signed openings; balances; Visa only from bank; attribution', async () => {
  const { repo, s } = await setup();
  const bank = await s.createAccount({ name: 'Bank', role: 'bank', openingDate: '2026-11-10', openingMinor: 6000000 }, M);
  const cash = await s.createAccount({ name: 'Cash', role: 'cash', openingDate: '2026-11-10', openingMinor: 0 }, M);
  const od = await s.createAccount({ name: 'Overdrawn', role: 'other', openingDate: '2026-11-10', openingMinor: -120000 }, M);
  await tick();
  assert.deepEqual(repo.commits[0], [`set:wallets/${bank}`, `set:walletMovements/op_${bank}`]);
  assert.deepEqual(repo.commits[1], [`set:wallets/${cash}`], 'zero opening → no movement');
  assert.equal(repo.db.get(`walletMovements/op_${od}`).fromWalletId, od, 'negative opening is an outflow');
  assert.deepEqual([s.balance(bank), s.balance(cash), s.balance(od)], [6000000, 0, -120000]);
  await s.createPeriod({ startDate: '2026-11-01', endDateExclusive: '2026-12-01', capMinor: 2000000 }); await tick();
  assert.deepEqual(repo.commits.at(-1), ['set:budgetPeriods/p_20261101', 'set:budgetHead/primary']);
  assert.equal(repo.db.get('budgetHead/primary').rev, 1);
  await assert.rejects(s.createPeriod({ startDate: '2026-11-20', endDateExclusive: '2026-12-20', capMinor: 1 }), (e) => /periodOverlap/.test(e.message + e.detail), 'refused before any write');
  await assert.rejects(s.addExpense({ amount: '30', category: 'groceries', date: '2026-11-11', walletId: cash, paymentMethod: 'debit_card' }), (e) => /visaBankOnly/.test(e.detail));
  const e1 = await s.addExpense({ amount: '3000', category: 'groceries', date: '2026-11-11', walletId: bank, paymentMethod: 'debit_card' }); await tick();
  assert.deepEqual([repo.db.get(`expenses/${e1}`).periodId, repo.db.get(`expenses/${e1}`).lateEntry], ['p_20261101', false]);
  assert.equal(s.balance(bank), 5700000);
  await assert.rejects(s.addExpense({ amount: '1', category: 'groceries', date: '2026-11-09', walletId: bank, paymentMethod: 'cash' }), (e) => /beforeOpening/.test(e.detail));
  // Income and reconciliation are balance-only movements of their own types.
  await s.addIncome({ walletId: bank, amountMinor: 1500000, date: '2026-11-12', today: '2026-11-12', source: 'Salary' }); await tick();
  assert.equal(s.balance(bank), 7200000);
  assert.equal(await s.reconcileAccount({ walletId: cash, actualMinor: 0, date: '2026-11-12', reason: 'count' }), null, 'no difference → nothing written');
  await s.reconcileAccount({ walletId: bank, actualMinor: 7190000, date: '2026-11-12', reason: 'fee not recorded' }); await tick();
  assert.equal(s.balance(bank), 7190000);
});

test('V6 store: refunds pair movement + ledger (set, then update); latest-only void with reason', async () => {
  const { repo, s } = await setup();
  const bank = await s.createAccount({ name: 'Bank', role: 'bank', openingDate: '2026-11-10', openingMinor: 6000000 }, M);
  await s.createPeriod({ startDate: '2026-11-01', endDateExclusive: '2026-12-01', capMinor: 2000000 }); await tick();
  const e1 = await s.addExpense({ amount: '3000', category: 'groceries', date: '2026-11-11', walletId: bank, paymentMethod: 'debit_card' }); await tick();
  const r1 = await s.refundExpense(e1, { amountMinor: 100000, date: '2026-11-12' }); await tick();
  assert.deepEqual(repo.commits.at(-1), [`set:refundLedgers/${e1}`, `set:walletMovements/${e1}_rf1`]);
  const r2 = await s.refundExpense(e1, { amountMinor: 50000, date: '2026-11-13' }); await tick();
  assert.deepEqual(repo.commits.at(-1), [`update:refundLedgers/${e1}`, `set:walletMovements/${e1}_rf2`]);
  assert.deepEqual([r1, r2], [`${e1}_rf1`, `${e1}_rf2`]);
  assert.deepEqual([repo.db.get(`refundLedgers/${e1}`).refundSeq, repo.db.get(`refundLedgers/${e1}`).refundedMinor], [2, 150000]);
  assert.equal(s.balance(bank), 6000000 - 300000 + 150000);
  await assert.rejects(s.refundExpense(e1, { amountMinor: 150001, date: '2026-11-13' }), (e) => /refundTooLarge/.test(e.message + e.detail));
  await assert.rejects(s.voidRefund(r1, 'mistake'), (e) => /refundNotLatest/.test(e.message + e.detail));
  await assert.rejects(s.voidRefund(r2, ' '), (e) => /reasonRequired/.test(e.message + e.detail));
  await s.voidRefund(r2, 'entered twice'); await tick();
  assert.deepEqual([repo.db.get(`walletMovements/${r2}`).status, repo.db.get(`walletMovements/${r2}`).voidReason], ['void', 'entered twice']);
  assert.deepEqual([repo.db.get(`refundLedgers/${e1}`).refundSeq, repo.db.get(`refundLedgers/${e1}`).refundedMinor], [2, 100000], 'seq never decreases');
});

test('batch 2 store: transfer neutral; rename; audited cap edit (one batch); V6 mode — no cycle link; re-attribution; closed-period and Zakat locks', async () => {
  const { repo, s } = await setup();
  const bank = await s.createAccount({ name: 'Bank', role: 'bank', openingDate: '2026-11-10', openingMinor: 6000000 }, M);
  const cash = await s.createAccount({ name: 'Cash', role: 'cash', openingDate: '2026-11-10', openingMinor: 300000 }, M);
  await s.createPeriod({ startDate: '2026-11-01', endDateExclusive: '2026-12-01', capMinor: 2000000 }); await tick();
  assert.equal(s.isV6(), true);
  const total = () => s.balance(bank) + s.balance(cash);
  await s.transferBetween({ fromId: bank, toId: cash, amountMinor: 200000, date: '2026-11-11' }); await tick();
  assert.deepEqual([s.balance(bank), s.balance(cash), total()], [5800000, 500000, 6300000], 'ATM: balances move, total unchanged');
  await assert.rejects(s.transferBetween({ fromId: bank, toId: cash, amountMinor: 1, date: '2026-11-09' }), (e) => /beforeOpening/.test(e.detail));
  await s.renameAccount(bank, 'Main bank'); await tick();
  assert.deepEqual(Object.keys(repo.commits.at(-1)), ['0']); assert.equal(repo.db.get(`wallets/${bank}`).name, 'Main bank');
  assert.equal(repo.db.get(`wallets/${bank}`).role, 'bank', 'identity unchanged');
  const cid = await s.editCap('p_20261101', { toMinor: 2500000, reason: 'Guests' }); await tick();
  assert.deepEqual(repo.commits.at(-1), ['update:budgetPeriods/p_20261101', 'set:budgetCapChanges/p_20261101_r2']);
  assert.deepEqual([repo.db.get(`budgetCapChanges/${cid}`).fromMinor, repo.db.get(`budgetCapChanges/${cid}`).toMinor, repo.db.get(`budgetCapChanges/${cid}`).actorUid], [2000000, 2500000, 'u1']);
  const e = await s.addExpense({ amount: '100', category: 'groceries', date: '2026-11-12', walletId: cash, paymentMethod: 'cash', budgetCycleId: 'auto' }); await tick();
  assert.deepEqual([repo.db.get(`expenses/${e}`).budgetCycleId, repo.db.get(`expenses/${e}`).periodId], [null, 'p_20261101'], 'V6 mode: no wallet-cycle link');
  await s.createPeriod({ startDate: '2026-12-01', endDateExclusive: '2027-01-01', capMinor: 100 }); await tick();
  await s.editExpense(e, { amount: '100', category: 'groceries', date: '2026-12-02', walletId: cash, paymentMethod: 'cash' }); await tick();
  assert.equal(repo.db.get(`expenses/${e}`).periodId, 'p_20261201', 'date change → re-attributed');
  repo.db.set('budgetPeriods/p_20261201', { ...repo.db.get('budgetPeriods/p_20261201'), status: 'closed' }); await repo.commit('H', []); await tick();
  await assert.rejects(s.editExpense(e, { amount: '200', category: 'groceries', date: '2026-12-02', walletId: cash, paymentMethod: 'cash' }), (x) => /periodClosed/.test(x.detail));
  await assert.rejects(s.voidExpense(e, 'x'), (x) => /periodClosed/.test(x.detail));
  repo.db.set('expenses/zk_1', { ...repo.db.get(`expenses/${e}`), category: 'zakat', periodId: null }); await repo.commit('H', []); await tick();
  await assert.rejects(s.voidExpense('zk_1', 'x'), (x) => /zakatOwned/.test(x.detail));
});

test('batch 3 store: funding / adjustment refused on V6 accounts before any write; pre-V6 wallets unchanged', async () => {
  const { repo, s } = await setup();
  const bank = await s.createAccount({ name: 'Bank', role: 'bank', openingDate: '2026-11-10', openingMinor: 0 }, M); await tick();
  const n = repo.commits.length;
  await assert.rejects(s.addMovement({ type: 'funding', amount: '10', date: '2026-11-11', toWalletId: bank }), (e) => /useIncome/.test(e.detail));
  await assert.rejects(s.addMovement({ type: 'adjustment', amount: '10', date: '2026-11-11', toWalletId: bank }), (e) => /useReconcile/.test(e.detail));
  assert.equal(repo.commits.length, n, 'nothing written');
});

test('V6.2 store: monthly budget setting — one doc per month, rev + 1, Zakat / zero limits dropped, invalid refused before any write', async () => {
  const { repo, s } = await setup();
  await s.setMonthly('2026-11', { budgetMinor: 2000000, categoryLimits: { food: 50000, zakat: 9, fuel: 0 } }); await tick();
  assert.deepEqual(repo.commits.at(-1), ['set:financeMonthly/2026-11']);
  const d = repo.db.get('financeMonthly/2026-11');
  assert.deepEqual([d.budgetMinor, d.categoryLimits, d.rev, d.audience, d.readers], [2000000, { food: 50000 }, 1, 'household', []]);
  await s.setMonthly('2026-11', { budgetMinor: null, categoryLimits: {} }); await tick();
  assert.deepEqual([repo.db.get('financeMonthly/2026-11').rev, repo.db.get('financeMonthly/2026-11').budgetMinor], [2, null]);
  const n = repo.commits.length;
  await assert.rejects(s.setMonthly('2026-13', { budgetMinor: 1, categoryLimits: {} }));
  await assert.rejects(s.setMonthly('2026-12', { budgetMinor: -1, categoryLimits: {} }));
  await assert.rejects(s.setMonthly('2026-12', { budgetMinor: 1.5, categoryLimits: {} }));
  assert.equal(repo.commits.length, n, 'nothing written');
});
