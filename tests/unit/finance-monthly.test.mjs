import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../src/modules/expenses/finance-monthly.js';

const ACC = [{ id: 'bank', role: 'bank' }, { id: 'cash', role: 'cash' }];
const E = (id, date, amountMinor, walletId, extra = {}) => ({ id, date, amountMinor, walletId, category: 'groceries', audience: 'household', status: 'active', note: id, ...extra });

test('monthly KPIs: by the transaction’s own date; Cash / Bank split; refunds; Zakat / private / void excluded; backdated', () => {
  const snap = { expenses: [E('a', '2026-11-02', 10000, 'cash'), E('b', '2026-11-30', 25000, 'bank'), E('c', '2026-10-31', 99900, 'bank'),
      E('back', '2026-11-01', 500, 'cash', { createdAt: '2026-12-05T00:00:00Z' }), E('zk_1', '2026-11-05', 70000, 'bank', { category: 'zakat' }),
      E('p', '2026-11-05', 1, 'cash', { audience: 'restricted' }), E('v', '2026-11-05', 7, 'cash', { status: 'void' })],
    movements: [{ id: 'r1', type: 'refund', refundOf: 'c', amountMinor: 900, toWalletId: 'bank', date: '2026-11-03', audience: 'household', status: 'active' },
      { id: 't1', type: 'transfer', amountMinor: 5000, fromWalletId: 'bank', toWalletId: 'cash', date: '2026-11-03', audience: 'household', status: 'active' }] };
  const s = M.monthStats(snap, ACC, '2026-11');
  assert.deepEqual([s.cashMinor, s.bankMinor, s.totalMinor], [10500, 25000 - 900, 10500 + 24100], 'backdated counted in its own month; refund in its month; transfer / Zakat / private / void not spending');
  assert.equal(M.monthStats(snap, ACC, '2026-10').totalMinor, 99900);
});

test('budget baseline: explicit per month, inherited forward, past months keep theirs; no budget → no percentage; category limits only when set', () => {
  const docs = [{ id: '2026-09', budgetMinor: 1000000, categoryLimits: {} }, { id: '2026-11', budgetMinor: 2000000, categoryLimits: { food: 50000 } }];
  assert.equal(M.effectiveMonthly(docs, '2026-10').budgetMinor, 1000000); assert.equal(M.effectiveMonthly(docs, '2026-10').inherited, true);
  assert.equal(M.effectiveMonthly(docs, '2026-12').budgetMinor, 2000000);
  assert.equal(M.effectiveMonthly(docs, '2026-09').budgetMinor, 1000000, 'a later change never rewrites an earlier month');
  assert.equal(M.effectiveMonthly([], '2026-11').budgetMinor, null);
  assert.equal(M.progress(5000, null), null, 'no baseline → no misleading percentage');
  assert.deepEqual(M.progress(2500000, 2000000), { spentMinor: 2500000, budgetMinor: 2000000, pct: 125, over: true, remainingMinor: -500000 });
  assert.deepEqual(M.categoryProgress({ byCategory: { food: 60000 } }, {}), [], 'no limits → no category bars');
  const cp = M.categoryProgress({ byCategory: { food: 60000 } }, { food: 50000, fuel: 0 });
  assert.deepEqual(cp.map((c) => [c.cat, c.pct, c.over]), [['food', 120, true]]);
});

test('history: newest first (stable tie-break); search spans ALL months/years; month default; work / vacation filter', () => {
  const ex = [E('Rice', '2025-03-01', 1, 'cash'), E('rice cooker', '2026-11-02', 1, 'bank', { createdAt: '2026-11-02T10:00:00Z' }),
    E('Bread', '2026-11-02', 1, 'cash', { createdAt: '2026-11-02T09:00:00Z' }), E('Milk', '2026-11-05', 1, 'cash')];
  const m = M.historyRows(ex, { ym: '2026-11' });
  assert.deepEqual([m.scope, m.rows.map((r) => r.id)], ['month', ['Milk', 'rice cooker', 'Bread']]);
  const s = M.historyRows(ex, { q: 'RICE', ym: '2026-11' });
  assert.deepEqual([s.scope, s.rows.map((r) => r.id)], ['all', ['rice cooker', 'Rice']], 'case-insensitive, across years, ignores the month');
  assert.deepEqual(M.historyRows(ex, { q: 'zzz', ym: '2026-11' }).rows, []);
  const vac = { mode: 'vacation', ivs: [{ start: '2026-11-02', end: '2026-11-02' }] };
  assert.deepEqual(M.historyRows(ex, { ym: '2026-11', cal: vac }).rows.map((r) => r.id), ['rice cooker', 'Bread'], 'first / last vacation day inclusive');
  const old = M.historyRows(ex, { ym: '2026-11', cal: { mode: 'vacation', ivs: [{ start: '2025-03-01', end: '2025-03-01' }] } });
  assert.deepEqual([old.scope, old.rows.map((r) => r.id)], ['interval', ['Rice']], 'an interval in another month/year is found without changing the month');
  assert.deepEqual(M.historyRows(ex, { q: 'rice', ym: '2026-11', cal: vac }).rows.map((r) => r.id), ['rice cooker'], 'search THEN interval');
  assert.equal(M.shiftYm('2026-12', 1), '2027-01');
});

test('vacation summary: total / Cash / Bank / categories, overlapping intervals counted once', () => {
  const snap = { expenses: [E('a', '2026-01-09', 1000, 'cash'), E('b', '2026-01-10', 2000, 'bank', { category: 'food' }), E('c', '2026-01-20', 5, 'cash')], movements: [] };
  const ivs = [{ start: '2026-01-09', end: '2026-01-10' }, { start: '2026-01-10', end: '2026-01-11' }];
  const sel = M.selectSpending(snap, (d) => ivs.some((i) => i.start <= d && d <= i.end));
  const s = M.summarize(sel.exp, sel.refunds, ACC);
  assert.deepEqual([s.totalMinor, s.cashMinor, s.bankMinor, s.byCategory.food], [3000, 1000, 2000, 2000]);
});

test('bills: due / overdue actionable; upcoming within the selected month', () => {
  const c = [{ id: 'x', active: true, nextDueDate: '2026-11-10' }, { id: 'y', active: true, nextDueDate: '2026-11-20' }, { id: 'z', active: false, nextDueDate: '2026-11-01' }, { id: 'w', active: true, nextDueDate: '2027-01-01' }];
  const b = M.bills(c, '2026-11-14', '2026-11');
  assert.deepEqual([b.due.map((x) => x.id), b.upcoming.map((x) => x.id)], [['x'], ['y']]);
});
