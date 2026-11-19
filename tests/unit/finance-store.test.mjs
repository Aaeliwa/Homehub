import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFinanceStore } from '../../src/modules/expenses/finance-store.js';
import { createContextScope } from '../../src/core/lifecycle/context-scope.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';
import { defaultRoles } from '../../src/modules/index.js';
import { createPermissionSet } from '../../src/core/permissions/resolver.js';
import { upgradeRolePermissions, ROLE_TEMPLATE_VERSION } from '../../src/core/permissions/roles.js';

/** Shared in-memory "Firestore" with the SAME two query shapes the rules allow. */
function fakeDb() {
  const data = new Map(); // `${home}/${name}/${id}` -> doc
  const watchers = new Set();
  const calls = { watch: 0, unwatch: 0, commits: [] };
  let n = 0;
  const matches = (name, kind, uid, d) => (kind === 'household'
    ? (name === 'wallets' ? d.visibility === 'household' : (d.audience ?? 'household') === 'household')
    : Array.isArray(d.readers) && d.readers.includes(uid));
  const fire = () => { for (const w of watchers) w.fire(); };
  const repo = {
    now: () => 'NOW',
    newId: () => `id${++n}`,
    watch(home, name, kind, uid, onValue) {
      calls.watch++;
      const w = { fire: () => onValue([...data.entries()].filter(([k]) => k.startsWith(`${home}/${name}/`)).map(([k, d]) => ({ id: k.split('/')[2], ...d })).filter((d) => matches(name, kind, uid, d))) };
      watchers.add(w); queueMicrotask(w.fire);
      return () => { calls.unwatch++; watchers.delete(w); };
    },
    async commit(home, ops) {
      calls.commits.push(ops.map((o) => `${o.mode}:${o.name}`));
      for (const o of ops) {
        const k = `${home}/${o.name}/${o.id}`;
        if (o.mode === 'set' && data.has(k) && o.name === 'expenses') throw Object.assign(new Error('exists'), { code: 'permission-denied' });
        data.set(k, o.mode === 'set' ? { ...o.data } : { ...data.get(k), ...o.data });
      }
      fire();
    },
  };
  return { repo, data, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function store(db, uid = 'ahmed', canViewHousehold = true, homeId = 'H') {
  const s = createFinanceStore({ homeId, uid, repo: db.repo, homeCurrency: 'EGP' });
  s.ensure({ canViewHousehold });
  s.subscribe(() => {});
  await tick();
  return s;
}
const MEMBERS = { memberUids: ['ahmed', 'mona', 'omar'], date: '2026-10-05' };

test('listeners: 6 "mine" + 8 "household" (one per collection; Phase 5.3 adds budgetAdjustments; V6 adds household-only budgetPeriods + budgetHead; V6.2 adds financeMonthly), shared by every consumer', async () => {
  const db = fakeDb(); const s = await store(db);
  assert.equal(s.listenerCount(), 15);   // V6.2: + financeMonthly (household)
  s.subscribe(() => {}); s.subscribe(() => {}); s.ensure({ canViewHousehold: true });
  assert.equal(db.calls.watch, 15, 'no extra listeners for more consumers');
  const child = await store(fakeDb(), 'omar', false);
  assert.equal(child.listenerCount(), 6, 'no household listeners without expenses.view');
});

test('listener cleanup on scope dispose; actions then fail safely', async () => {
  const db = fakeDb();
  const scope = createContextScope({ uid: 'ahmed', homeId: 'H' });
  const s = scope.resource('finance', () => createFinanceStore({ homeId: 'H', uid: 'ahmed', repo: db.repo }));
  s.ensure({ canViewHousehold: true });
  scope.dispose();
  assert.equal(db.calls.unwatch, 15);   // V6: + budgetPeriods, budgetHead; V6.2: + financeMonthly
  assert.equal(s.listenerCount(), 0);
  await assert.rejects(s.addExpense({ amount: '1', category: 'food', date: '2026-10-05' }), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE);
  assert.deepEqual(s.getSnapshot().expenses, [], 'no previous-home data');
  assert.deepEqual([s.getSnapshot().periods, s.getSnapshot().head], [[], null], 'no previous-home budget periods (V6)');
});

test('losing expenses.view stops household listeners', async () => {
  const db = fakeDb(); const s = await store(db);
  s.ensure({ canViewHousehold: false });
  assert.equal(s.listenerCount(), 6);
});

test('wallets: household + personal; privacy enforced by query shape', async () => {
  const db = fakeDb(); const ahmed = await store(db, 'ahmed');
  const cash = await ahmed.createWallet({ name: 'Household cash', type: 'cash', scope: 'home' }, MEMBERS);
  const mine = await ahmed.createWallet({ name: 'Ahmed wallet', type: 'cash', scope: 'personal', visibility: 'private', openingBalance: '1000' }, MEMBERS);
  await tick();
  const mona = await store(db, 'mona', true);
  await tick();
  assert.ok(mona.wallet(cash), 'household wallet visible');
  assert.equal(mona.wallet(mine), null, 'another adult cannot see a private wallet');
  assert.equal(ahmed.balance(mine), 100000, 'opening balance is a funding movement');
  assert.equal(ahmed.totals('2026-10').totalMinor, 0, '…and not spending');
  await ahmed.archiveWallet(cash); await tick();
  assert.equal(ahmed.wallet(cash).active, false);
  await ahmed.restoreWallet(cash); await tick();
  assert.equal(ahmed.wallet(cash).active, true);
});

test('child allowance wallet: child + guardians only; child sees no household data', async () => {
  const db = fakeDb(); const ahmed = await store(db, 'ahmed');
  await ahmed.createWallet({ name: 'Household bank', type: 'bank', scope: 'home' }, MEMBERS);
  const kid = await ahmed.createWallet({ name: 'Omar wallet', type: 'allowance', scope: 'personal', ownerUid: 'omar', visibility: 'shared', sharedWith: ['ahmed', 'mona'], openingBalance: '500' }, MEMBERS);
  const omar = await store(db, 'omar', false);
  await omar.addExpense({ amount: '40', category: 'food', note: 'Snacks', date: '2026-10-05', walletId: kid });
  await omar.addExpense({ amount: '100', category: 'entertainment', note: 'Games', date: '2026-10-05', walletId: kid });
  await tick();
  assert.equal(omar.balance(kid), 36000, '500 − 140 = 360');
  assert.equal(omar.getSnapshot().wallets.length, 1, 'child sees only the allowance wallet');
  const mona = await store(db, 'mona', true); await tick();
  assert.equal(mona.balance(kid), 36000, 'guardian sees it');
  assert.ok(ahmed.getSnapshot().expenses.every((e) => e.readers.includes('omar')));
});

test('expenses: create with audit fields, edit field-level, void (no delete), restore', async () => {
  const db = fakeDb(); const s = await store(db);
  const cash = await s.createWallet({ name: 'Cash', type: 'cash', scope: 'home' }, MEMBERS);
  const id = await s.addExpense({ amount: '420', category: 'groceries', note: 'Carrefour', date: '2026-10-05', walletId: cash, paidBy: 'mona' });
  await tick();
  const e = s.getSnapshot().expenses.find((x) => x.id === id);
  assert.deepEqual([e.createdBy, e.paidBy, e.amountMinor, e.status], ['ahmed', 'mona', 42000, 'active'], 'creator ≠ payer');
  const base = { ...e };
  await db.repo.commit('H', [{ mode: 'update', name: 'expenses', id, data: { merchant: 'Carrefour Maadi' } }]);
  await s.editExpense(id, { ...base, amount: '430', category: 'groceries', date: '2026-10-05', walletId: cash }, base);
  await tick();
  const after = s.getSnapshot().expenses.find((x) => x.id === id);
  assert.equal(after.amountMinor, 43000);
  assert.equal(after.merchant, 'Carrefour Maadi', 'concurrent edit kept');
  await s.voidExpense(id, 'duplicate'); await tick();
  assert.equal(s.totals('2026-10').totalMinor, 0);
  assert.ok(s.getSnapshot().expenses.some((x) => x.id === id), 'still present');
  await assert.rejects(s.editExpense(id, { amount: '1', category: 'food', date: '2026-10-05' }), (x) => x.detail === 'finance.validation.voidReadOnly');
  await s.restoreExpense(id); await tick();
  assert.equal(s.totals('2026-10').totalMinor, 43000);
});

test('10-day cycle: bank withdrawal funds it (not spending); expenses auto-link; carry forward', async () => {
  const db = fakeDb(); const s = await store(db);
  const bank = await s.createWallet({ name: 'Bank', type: 'bank', scope: 'home', openingBalance: '20000' }, MEMBERS);
  const cash = await s.createWallet({ name: 'Daily cash', type: 'cash', scope: 'home' }, MEMBERS);
  await tick();
  const cyc = await s.startCycle({ walletId: cash, startDate: '2026-10-05', days: 10, budget: '6000', fundFrom: bank });
  await tick();
  assert.equal(s.totals('2026-10').totalMinor, 0, 'withdrawal is not an expense');
  assert.equal(s.balance(bank), 1400000);
  assert.equal(s.balance(cash), 600000);
  await s.addExpense({ amount: '450', category: 'groceries', date: '2026-10-06', walletId: cash });
  await s.addExpense({ amount: '4750', category: 'food', date: '2026-10-07', walletId: cash });
  await s.addExpense({ amount: '99', category: 'food', date: '2026-10-20', walletId: cash });
  await tick();
  const c = s.getSnapshot().cycles.find((x) => x.id === cyc);
  const st = s.cycleStats(c, '2026-10-07');
  assert.equal(st.spentMinor, 520000, 'only expenses inside the window link to the cycle');
  assert.equal(s.totals('2026-10').totalMinor, 529900, 'each expense counted once');
  await assert.rejects(s.startCycle({ walletId: cash, startDate: '2026-10-08', budget: '1' }), (e) => e.detail === 'finance.validation.cycleActive');
  const diff = await s.reconcileCycle(cyc, { actual: '680', date: '2026-10-14', today: '2026-10-14' });
  assert.equal(diff, -12000, 'expected 800, counted 680');
  await tick();
  assert.equal(s.totals('2026-10').totalMinor, 529900, 'reconciliation is not an expense');
  const next = await s.closeCycle(cyc, { outcome: 'carry', today: '2026-10-14', next: { budget: '6000' } });
  await tick();
  const nc = s.getSnapshot().cycles.find((x) => x.id === next);
  assert.deepEqual([nc.startDate, nc.endDate, nc.carryInMinor, nc.previousCycleId], ['2026-10-15', '2026-10-24', 68000, cyc]);
  const old = s.getSnapshot().cycles.find((x) => x.id === cyc);
  assert.deepEqual([old.status, old.closeOutcome, old.closingRemainingMinor, old.nextCycleId], ['closed', 'carry', 68000, next]);
});

test('close with return moves the rest by transfer; flexible start date', async () => {
  const db = fakeDb(); const s = await store(db);
  const bank = await s.createWallet({ name: 'Bank', type: 'bank', scope: 'home' }, MEMBERS);
  const cash = await s.createWallet({ name: 'Cash', type: 'cash', scope: 'home' }, MEMBERS);
  await tick();
  const cyc = await s.startCycle({ walletId: cash, startDate: '2026-10-17', days: 7, budget: '1000', fundFrom: 'external' });
  await tick();
  assert.equal(s.getSnapshot().cycles[0].endDate, '2026-10-23');
  await s.closeCycle(cyc, { outcome: 'return', today: '2026-10-23', returnToWalletId: bank });
  await tick();
  assert.equal(s.balance(bank), 100000);
  assert.equal(s.balance(cash), 0);
});

test('commitments: annual subscription; mark paid creates ONE expense and advances; repeat refused', async () => {
  const db = fakeDb(); const s = await store(db);
  const visa = await s.createWallet({ name: 'Household Visa', type: 'card', scope: 'home' }, MEMBERS);
  await tick();
  const id = await s.createCommitment({ name: 'Microsoft 365', amount: '2999', category: 'subscriptions', recurrence: { unit: 'year', interval: 1 }, nextDueDate: '2027-03-15', walletId: visa, paymentMethod: 'credit_card' });
  await tick();
  assert.equal(s.totals('2027-03').totalMinor, 0, 'a commitment is not an expense');
  const exp = await s.payCommitment(id, { date: '2027-03-15', walletId: visa });
  await tick();
  assert.equal(exp, `cm_${id}_20270315`);
  const c = s.getSnapshot().commitments.find((x) => x.id === id);
  assert.deepEqual([c.nextDueDate, c.lastPaidDate], ['2028-03-15', '2027-03-15']);
  assert.equal(s.totals('2027-03').totalMinor, 299900);
  assert.equal(s.totals('2027-03').fixedMinor, 299900);
  // Simulate a stale second device: same due date again → same id → refused by the store and by Firestore.
  await assert.rejects(db.repo.commit('H', [{ mode: 'set', name: 'expenses', id: exp, data: {} }]));
  assert.equal(s.getSnapshot().expenses.filter((e) => e.commitmentId === id).length, 1);
  const monthly = await s.createCommitment({ name: 'Internet', amount: '600', category: 'utilities', recurrence: { unit: 'month', interval: 1 }, nextDueDate: '2026-10-12' });
  await tick();
  // Paid Microsoft 365 is now due 2028-03-15 (outside 200 days); Internet is upcoming.
  assert.deepEqual(s.upcoming('2026-10-05', 200).map((x) => x.name), ['Internet']);
  assert.deepEqual(s.upcoming('2026-10-05', 900).map((x) => x.name), ['Internet', 'Microsoft 365']);
  await s.archiveCommitment(monthly); await tick();
  assert.deepEqual(s.upcoming('2026-10-05', 900).map((x) => x.name), ['Microsoft 365']);
});

test('sharing a personal wallet re-syncs readers of its records in the same batch', async () => {
  const db = fakeDb(); const s = await store(db, 'ahmed');
  const w = await s.createWallet({ name: 'Ahmed', type: 'cash', scope: 'personal', visibility: 'private' }, MEMBERS);
  await tick();
  await s.addExpense({ amount: '50', category: 'food', date: '2026-10-05', walletId: w });
  await tick();
  await s.updateWallet(w, { visibility: 'shared', sharedWith: ['mona'] }, MEMBERS);
  await tick();
  assert.deepEqual(db.calls.commits.at(-1), ['update:wallets', 'update:expenses']);
  const mona = await store(db, 'mona', true); await tick();
  assert.equal(mona.getSnapshot().expenses.length, 1, 'now visible to Mona');
  await s.updateWallet(w, { visibility: 'private', sharedWith: [] }, MEMBERS); await tick();
  const mona2 = await store(db, 'mona', true); await tick();
  assert.equal(mona2.getSnapshot().expenses.length, 0, 'un-shared again');
});

test('home isolation: stores never see another home', async () => {
  const db = fakeDb(); const h1 = await store(db, 'ahmed', true, 'H1');
  await h1.createWallet({ name: 'Cash', type: 'cash', scope: 'home' }, MEMBERS);
  const h2 = await store(db, 'ahmed', true, 'H2'); await tick();
  assert.equal(h2.getSnapshot().wallets.length, 0);
});

test('permissions: role matrix and non-destructive upgrade from v3 (finance grants)', () => {
  const p = Object.fromEntries(defaultRoles().map((r) => [r.id, createPermissionSet(r.permissions)]));
  const A = ['view', 'viewFinancialTotals', 'create', 'edit', 'delete', 'personal', 'manageWallets', 'transfer', 'manageBudgets', 'manageCommitments', 'import'];
  const m = (r) => A.filter((a) => p[r].can(`expenses.${a}`));
  assert.deepEqual(m('owner'), A);
  assert.deepEqual(m('admin'), A.filter((a) => a !== 'import'));
  assert.deepEqual(m('member'), ['view', 'viewFinancialTotals', 'create', 'edit', 'personal', 'transfer'], 'V6 batch 3: no manageBudgets (owner / admin only)');
  assert.deepEqual(m('viewer'), ['view'], 'read-only, no totals');
  assert.deepEqual(m('child'), ['personal'], 'own allowance only');
  assert.ok(ROLE_TEMPLATE_VERSION >= 4, 'v4 introduced finance; Phase 4A is v5');
  const memberV3 = ['expenses.create', 'expenses.delete', 'expenses.edit', 'expenses.view', 'rooms.view', 'devices.view', 'custom.grant'];
  const tpl = defaultRoles().find((r) => r.id === 'member').permissions;
  const up = upgradeRolePermissions({ current: memberV3, template: tpl, from: 3 });
  assert.ok(!up.includes('expenses.delete') && up.includes('expenses.personal') && up.includes('custom.grant') && up.includes('rooms.view'));
});

test('template v7 (V6 batch 3): members lose ONLY expenses.manageBudgets; admins keep it; custom grants survive; idempotent', async () => {
  const { REVOKED_GRANTS, ADDITIVE_VERSIONS } = await import('../../src/core/permissions/roles.js');
  assert.deepEqual(REVOKED_GRANTS[7], ['expenses.manageBudgets']); assert.ok(ADDITIVE_VERSIONS.includes(7));
  const tpl = (id) => defaultRoles().find((r) => r.id === id).permissions;
  const memberV6 = [...tpl('member'), 'expenses.manageBudgets', 'expenses.delete', 'custom.grant'].sort();
  const up = upgradeRolePermissions({ current: memberV6, template: tpl('member'), from: 6 });
  assert.ok(!up.includes('expenses.manageBudgets'), 'revoked from members');
  for (const keep of ['expenses.delete', 'custom.grant', 'expenses.create', 'expenses.view']) assert.ok(up.includes(keep), keep);
  const adminV6 = [...tpl('admin'), 'expenses.import'].sort();
  const upA = upgradeRolePermissions({ current: adminV6, template: tpl('admin'), from: 6 });
  assert.ok(upA.includes('expenses.manageBudgets') && upA.includes('expenses.import'), 'admin keeps manageBudgets and its custom import grant');
  assert.deepEqual(upgradeRolePermissions({ current: up, template: tpl('member'), from: 7 }), up, 'idempotent at v7');
  assert.deepEqual(upgradeRolePermissions({ current: ['*'], template: tpl('owner'), from: 6 }), ['*']);
});

