import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewBudget, previewBudgetEdit, buildBudgetEdit, revisionOf, adjustmentId } from '../../src/modules/expenses/budget-edit.js';
import { createFinanceStore } from '../../src/modules/expenses/finance-store.js';

const C = (extra = {}) => ({ id: 'c1', walletId: 'cash', startDate: '2026-10-05', endDate: '2026-10-14', days: 10, budgetMinor: 1000000, carryInMinor: 0, status: 'active', currency: 'EGP', audience: 'household', readers: [], ...extra });
const spent = (amt) => ({ expenses: [{ id: 'e', status: 'active', budgetCycleId: 'c1', amountMinor: amt, walletId: 'cash', date: '2026-10-06' }], movements: [] });

test('your example: 10,000 budget, 2,500 spent, revised to 12,000 → remaining 9,500 (budget + carry-in − spent)', () => {
  const p = previewBudgetEdit(C(), 1200000, spent(250000), '2026-10-07');
  assert.equal(p.before.remainingMinor, 750000);
  assert.equal(p.after.remainingMinor, 950000);
  assert.equal(p.deltaMinor, 200000);
  assert.equal(p.after.days, 10, 'duration unchanged');
  assert.ok(p.after.safePerDayMinor > p.before.safePerDayMinor, 'daily allowance recalculated');
});

test('decrease, including below the amount spent → over-budget shown, nothing deleted', () => {
  const p = previewBudgetEdit(C(), 200000, spent(250000), '2026-10-07');
  assert.equal(p.after.remainingMinor, -50000);
  assert.equal(p.overBudget, true);
  assert.equal(p.after.safePerDayMinor, 0, 'never a negative daily allowance');
});

test('validation: zero allowed (non-negative); negative, >2 decimals, text, empty, unchanged rejected', () => {
  assert.deepEqual(parseNewBudget('0', C()), { value: 0 });
  assert.deepEqual(parseNewBudget('12,000', C()), { value: 1200000 });
  for (const bad of ['-1', '1.234', 'abc', '', '   ', null, 'Infinity', 'NaN']) assert.ok(parseNewBudget(bad, C()).error, String(bad));
  assert.equal(parseNewBudget('10000', C()).error, 'finance.budget.unchanged');
});

test('write set: amount + revision only; append-only record with old/new/delta/editor/reason; dates immutable', () => {
  const w = buildBudgetEdit({ cycle: C(), newBudgetMinor: 1200000, reason: '  extra   guests ', uid: 'ahmed', now: 'NOW' });
  assert.deepEqual(Object.keys(w.cyclePatch).sort(), ['budgetMinor', 'budgetRevision', 'updatedAt', 'updatedBy']);
  assert.equal(w.revision, 1, 'older cycles without budgetRevision start at 0 → 1');
  assert.deepEqual(w.adjustment.data, { cycleId: 'c1', walletId: 'cash', revision: 1, oldBudgetMinor: 1000000, newBudgetMinor: 1200000, deltaMinor: 200000,
    currency: 'EGP', reason: 'extra guests', editorUid: 'ahmed', createdAt: 'NOW', audience: 'household', readers: [], schemaVersion: 1 });
  assert.equal(w.adjustment.id, 'c1_r1');
  assert.equal(buildBudgetEdit({ cycle: C({ budgetRevision: 4 }), newBudgetMinor: 5, uid: 'u', now: 'N' }).adjustment.id, 'c1_r5');
  assert.equal(revisionOf({}), 0); assert.equal(adjustmentId('x', 2), 'x_r2');
  assert.throws(() => buildBudgetEdit({ cycle: C({ status: 'closed' }), newBudgetMinor: 5, uid: 'u', now: 'N' }), (e) => e.detail === 'finance.budget.notActive');
  assert.throws(() => buildBudgetEdit({ cycle: C(), newBudgetMinor: -5, uid: 'u', now: 'N' }));
  assert.throws(() => buildBudgetEdit({ cycle: C(), newBudgetMinor: 1000000, uid: 'u', now: 'N' }), (e) => e.detail === 'finance.budget.unchanged');
  assert.equal(buildBudgetEdit({ cycle: C({ audience: 'restricted', readers: ['w'] }), newBudgetMinor: 1, uid: 'w', now: 'N' }).adjustment.data.readers.join(), 'w', 'privacy labels copied');
});

function fakeRepo({ denyCommit = false } = {}) {
  const data = new Map(); const ws = new Set(); const commits = []; let n = 0;
  return { data, commits, now: () => 'NOW', newId: () => `id${++n}`,
    watch(home, name, kind, uid, onValue) {
      const w = () => onValue([...data.entries()].filter(([k]) => k.startsWith(`${home}/${name}/`)).map(([k, d]) => ({ id: k.split('/')[2], ...d }))
        .filter((d) => (kind === 'household' ? (name === 'wallets' ? d.visibility === 'household' : (d.audience ?? 'household') === 'household') : (d.readers || []).includes(uid))));
      ws.add(w); queueMicrotask(w); return () => ws.delete(w);
    },
    async commit(home, ops) {
      if (this.deny) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      commits.push(ops.map((o) => `${o.mode}:${o.name}:${o.id}`));
      for (const o of ops) { const k = `${home}/${o.name}/${o.id}`; data.set(k, o.mode === 'set' ? { ...o.data } : { ...data.get(k), ...o.data }); }
      for (const w of ws) w();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function withCycle(opts) {
  const repo = fakeRepo(opts); const s = createFinanceStore({ homeId: 'H', uid: 'ahmed', repo, homeCurrency: 'EGP' });
  s.ensure({ canViewHousehold: true }); s.subscribe(() => {}); await tick();
  repo.data.set('H/wallets/cash', { name: 'Cash', type: 'cash', scope: 'home', visibility: 'household', readers: [], currency: 'EGP', active: true });
  repo.data.set('H/walletMovements/m1', { type: 'funding', amountMinor: 1000000, toWalletId: 'cash', fromWalletId: null, status: 'active', audience: 'household', readers: [] });
  repo.data.set('H/spendingCycles/c1', C());
  repo.data.set('H/expenses/e1', { amountMinor: 250000, budgetCycleId: 'c1', walletId: 'cash', date: '2026-10-06', status: 'active', audience: 'household', readers: [], category: 'food' });
  await repo.commit('H', []);
  await tick();
  return { repo, s };
}

test('store.editBudget: ONE batch (cycle + adjustment); wallet balance, movements and expenses unchanged', async () => {
  const { repo, s } = await withCycle();
  const balance = s.balance('cash');
  const others = JSON.stringify([...repo.data.entries()].filter(([k]) => !k.includes('spendingCycles') && !k.includes('budgetAdjustments')));
  await s.editBudget('c1', { newBudgetMinor: 1200000, reason: 'guests' }); await tick();
  assert.deepEqual(repo.commits.at(-1), ['update:spendingCycles:c1', 'set:budgetAdjustments:c1_r1']);
  assert.equal(s.balance('cash'), balance, 'a budget is a target, not cash');
  assert.equal(JSON.stringify([...repo.data.entries()].filter(([k]) => !k.includes('spendingCycles') && !k.includes('budgetAdjustments'))), others, 'no movement, expense or wallet change');
  const c = s.getSnapshot().cycles[0];
  assert.deepEqual([c.budgetMinor, c.budgetRevision, c.startDate, c.endDate, c.days], [1200000, 1, '2026-10-05', '2026-10-14', 10]);
  assert.equal(s.cycleStats(c, '2026-10-07').remainingMinor, 950000);
  await s.editBudget('c1', { newBudgetMinor: 200000 }); await tick();
  assert.deepEqual(s.adjustmentsFor('c1').map((a) => [a.revision, a.oldBudgetMinor, a.newBudgetMinor, a.deltaMinor]), [[2, 1200000, 200000, -1000000], [1, 1000000, 1200000, 200000]], 'append-only history, newest first');
});

test('store.editBudget: a rules denial (stale revision / concurrent edit / no permission) surfaces as a conflict', async () => {
  const { repo, s } = await withCycle();
  repo.deny = true;   // the rules now refuse the write (e.g. someone else saved revision 1 first)
  await assert.rejects(s.editBudget('c1', { newBudgetMinor: 1200000 }), (e) => e.detail === 'finance.budget.conflict');
});
