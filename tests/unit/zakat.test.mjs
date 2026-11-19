import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, nisabAt, ownerHoldings, validateProfile, DEFAULT_PROFILE } from '../../src/modules/savings/zakat-engine.js';
import { createSavingsStore } from '../../src/modules/savings/savings-store.js';
import { createContextScope } from '../../src/core/lifecycle/context-scope.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';
import { defaultRoles } from '../../src/modules/index.js';
import { createPermissionSet } from '../../src/core/permissions/resolver.js';
import { upgradeRolePermissions, ROLE_TEMPLATE_VERSION, TEMPLATE_CHANGES } from '../../src/core/permissions/roles.js';

const at = (d) => Date.parse(`${d}T10:00:00Z`);
const gold21 = (d, p) => ({ id: `g21${d}`, kind: 'metal', key: 'gold-21', priceMinor: p, currency: 'EGP', source: 'manual', observedAt: at(d) });
const silver = (d, p) => ({ id: `s${d}`, kind: 'metal', key: 'silver-999', priceMinor: p, currency: 'EGP', source: 'manual', observedAt: at(d) });
const cash = (id, owner, extra = {}) => ({ id, type: 'cash', scope: 'personal', ownerUid: owner, currency: 'EGP', active: true, zakatTreatment: 'included', visibility: 'private', readers: [owner], ...extra });
const ev = (id, assetId, date, qty) => ({ id, assetId, date, qty, status: 'active' });
const run = (o) => assess({ ownerUid: 'ahmed', today: '2026-10-06', homeCurrency: 'EGP', nowMs: at('2026-10-06'), ...o });

test('defaults are a labelled, configurable methodology: 85 g 21K, Hijri, reset, 2.5%', () => {
  assert.deepEqual([DEFAULT_PROFILE.nisabBasis, DEFAULT_PROFILE.goldMg, DEFAULT_PROFILE.goldPurity, DEFAULT_PROFILE.hawlCalendar, DEFAULT_PROFILE.belowNisabPolicy, DEFAULT_PROFILE.rateBps], ['gold', 85000, '21', 'hijri', 'reset', 250]);
  assert.deepEqual(validateProfile(DEFAULT_PROFILE), {});
  assert.ok(validateProfile({ ...DEFAULT_PROFILE, nisabBasis: 'manual', manualNisabMinor: null }).manualNisabMinor);
  assert.ok(validateProfile({ ...DEFAULT_PROFILE, rateBps: 0 }).rateBps);
});

test('Nisab: gold 85 g, silver 595 g, manual; missing price is "unavailable", never assumed', () => {
  const qs = [gold21('2026-01-01', 400000), silver('2026-01-01', 5000)];
  assert.equal(nisabAt(DEFAULT_PROFILE, qs, '2026-02-01').valueMinor, 34000000, '85 × 4,000 = 340,000 EGP');
  assert.equal(nisabAt({ ...DEFAULT_PROFILE, nisabBasis: 'silver' }, qs, '2026-02-01').valueMinor, 2975000, '595 × 50 = 29,750 EGP');
  assert.equal(nisabAt({ ...DEFAULT_PROFILE, nisabBasis: 'manual', manualNisabMinor: 25000000 }, [], null).valueMinor, 25000000);
  assert.equal(nisabAt({ ...DEFAULT_PROFILE, goldMg: 87480 }, qs, '2026-02-01').valueMinor, 34992000, 'configurable grams');
  assert.equal(nisabAt(DEFAULT_PROFILE, [], '2026-02-01').status, 'unavailable');
});

test('below / equal / above Nisab', () => {
  const qs = [gold21('2026-01-01', 400000)];
  for (const [amount, expect] of [[33999999, 'belowNisab'], [34000000, 'inProgress'], [50000000, 'inProgress']]) {
    assert.equal(run({ assets: [cash('c', 'ahmed')], events: [ev('1', 'c', '2026-02-01', amount)], quotes: qs }).status, expect, String(amount));
  }
  assert.equal(run({ assets: [cash('c', 'ahmed')], events: [ev('1', 'c', '2026-02-01', 50000000)], quotes: [] }).status, 'unknown');
});

test('Hawl from HISTORY: Jan above, Jun below, Sep above (reset vs continue policies)', () => {
  const qs = [gold21('2026-01-01', 400000)];
  const events = [ev('1', 'c', '2026-01-10', 40000000), ev('2', 'c', '2026-06-01', -20000000), ev('3', 'c', '2026-09-01', 20000000)];
  const reset = run({ assets: [cash('c', 'ahmed')], events, quotes: qs });
  assert.deepEqual([reset.status, reset.hawlStart, reset.hawlEnd], ['inProgress', '2026-09-01', '2027-08-21'], 'Hijri year ≈ 354 days');
  const cont = run({ assets: [cash('c', 'ahmed')], events, quotes: qs, profile: { belowNisabPolicy: 'continue' } });
  assert.equal(cont.hawlStart, '2026-01-10');
  const greg = run({ assets: [cash('c', 'ahmed')], events, quotes: qs, profile: { hawlCalendar: 'gregorian' } });
  assert.equal(greg.hawlEnd, '2027-09-01', 'Gregorian year when selected');
});

test('completed Hawl: due on wealth AT ITS END, configurable rate, next Hawl starts; history preserved', () => {
  const qs = [gold21('2025-01-01', 400000)];
  const events = [ev('1', 'c', '2025-01-10', 40000000), ev('2', 'c', '2026-03-01', 10000000)];
  const r = run({ assets: [cash('c', 'ahmed')], events, quotes: qs });
  assert.equal(r.status, 'complete');
  assert.deepEqual([r.due.start, r.due.end, r.due.zakatableMinor, r.due.estimateMinor], ['2025-01-10', '2025-12-30', 40000000, 1000000], 'later deposit not counted for the past Hawl');
  assert.equal(r.hawlStart, '2025-12-30', 'next Hawl');
  assert.equal(r.completedCycles.length, 1);
  assert.equal(run({ assets: [cash('c', 'ahmed')], events, quotes: qs, profile: { rateBps: 300 } }).due.estimateMinor, 1200000, 'custom 3%');
});

test('per-owner: Ahmed and Sara never combined; child separate; inclusion/exclusion; shared allocation', () => {
  const qs = [gold21('2026-01-01', 400000)];
  const assets = [cash('a1', 'ahmed'), cash('s1', 'sara'), cash('o1', 'omar'), cash('a2', 'ahmed', { zakatTreatment: 'excluded' }),
    { id: 'h1', type: 'cash', scope: 'home', ownerUid: null, currency: 'EGP', active: true, zakatTreatment: 'included', visibility: 'household', allocations: [{ uid: 'ahmed', bps: 6000 }, { uid: 'sara', bps: 4000 }] },
    { id: 'h2', type: 'cash', scope: 'home', ownerUid: null, currency: 'EGP', active: true, zakatTreatment: 'included', visibility: 'household', allocations: [] }];
  const events = [ev('1', 'a1', '2026-02-01', 30000000), ev('2', 's1', '2026-02-01', 90000000), ev('3', 'o1', '2026-02-01', 50000000), ev('4', 'a2', '2026-02-01', 70000000), ev('5', 'h1', '2026-02-01', 10000000), ev('6', 'h2', '2026-02-01', 99000000)];
  const ahmed = run({ assets, events, quotes: qs });
  assert.equal(ahmed.zakatableMinor, 36000000, '300,000 own + 60% of 100,000 — not Sara, not Omar, not excluded');
  assert.deepEqual(ahmed.excluded.map((x) => [x.asset.id, x.reason]).sort(), [['a2', 'markedExcluded'], ['h2', 'noAllocation']]);
  assert.equal(run({ ownerUid: 'sara', assets, events, quotes: qs }).zakatableMinor, 94000000);
  assert.equal(run({ ownerUid: 'omar', assets, events, quotes: qs }).zakatableMinor, 50000000, 'child assessed on own assets only');
  assert.equal(ownerHoldings('ahmed', assets).included.find((x) => x.asset.id === 'h1').bps, 6000);
});

test('FX and gold assets valued with prices at the date; stale price still shown honestly', () => {
  const qs = [gold21('2026-01-01', 400000), { id: 'usd', kind: 'fx', key: 'USD', priceMinor: 5000, currency: 'EGP', source: 'manual', observedAt: at('2026-01-01') }];
  const assets = [{ id: 'g', type: 'gold', purity: '21', scope: 'personal', ownerUid: 'ahmed', active: true, zakatTreatment: 'included' },
    { id: 'u', type: 'fx', currency: 'USD', scope: 'personal', ownerUid: 'ahmed', active: true, zakatTreatment: 'included' }];
  const r = run({ assets, events: [ev('1', 'g', '2026-02-01', 50000), ev('2', 'u', '2026-02-01', 200000)], quotes: qs });
  assert.equal(r.zakatableMinor, 20000000 + 10000000);
  assert.equal(r.nisab.status, 'stale', 'January price is old by October');
});

// ---------------------------------------------------------------- store (fake repository)
function fakeRepo() {
  const data = new Map(); const watchers = new Set(); const calls = { watch: 0, unwatch: 0, commits: [] }; let n = 0;
  const match = (name, kind, uid, d) => (name === 'priceQuotes' ? true : kind === 'household'
    ? (name === 'savingsAssets' ? d.visibility === 'household' : d.audience === 'household') : (d.readers || []).includes(uid));
  const fire = () => { for (const w of watchers) w(); };
  return { data, calls, now: () => 'NOW', newId: () => `id${++n}`,
    watch(home, name, kind, uid, onValue) {
      calls.watch++;
      const w = () => onValue([...data.entries()].filter(([k]) => k.startsWith(`${home}/${name}/`)).map(([k, d]) => ({ id: k.split('/')[2], ...d })).filter((d) => match(name, kind, uid, d)));
      watchers.add(w); queueMicrotask(w); return () => { calls.unwatch++; watchers.delete(w); };
    },
    async commit(home, ops) {
      calls.commits.push(ops.map((o) => `${o.mode}:${o.name}:${o.id}`));
      for (const o of ops) { const k = `${home}/${o.name}/${o.id}`; if (o.mode === 'set' && data.has(k) && ['expenses', 'savingsEvents', 'zakatRecords'].includes(o.name)) throw Object.assign(new Error('exists'), { code: 'permission-denied' }); data.set(k, o.mode === 'set' ? { ...o.data } : { ...data.get(k), ...o.data }); }
      fire();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function mk(repo, uid = 'ahmed', canViewHousehold = true, homeId = 'H') {
  const s = createSavingsStore({ homeId, uid, repo, homeCurrency: 'EGP', nowMs: () => at('2026-10-06') });
  s.ensure({ canViewHousehold }); s.subscribe(() => {}); await tick(); return s;
}
const M = { memberUids: ['ahmed', 'sara', 'omar'], date: '2026-10-06' };

test('store: listeners (≤6), shared, cleaned up; actions fail safely after dispose', async () => {
  const repo = fakeRepo(); const s = await mk(repo);
  assert.equal(s.listenerCount(), 6);
  s.subscribe(() => {}); s.ensure({ canViewHousehold: true });
  assert.equal(repo.calls.watch, 6);
  assert.equal((await mk(fakeRepo(), 'omar', false)).listenerCount(), 4, 'no household listeners without savings.view');
  const scope = createContextScope({ uid: 'ahmed', homeId: 'H' });
  const s2 = scope.resource('savings', () => createSavingsStore({ homeId: 'H', uid: 'ahmed', repo }));
  s2.ensure({ canViewHousehold: true }); scope.dispose();
  assert.equal(s2.listenerCount(), 0);
  await assert.rejects(s2.createAsset({ name: 'x', type: 'cash' }, M), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE);
});

test('store: private asset invisible to another adult and to the Home owner; share / un-share', async () => {
  const repo = fakeRepo(); const sara = await mk(repo, 'sara');
  const id = await sara.createAsset({ name: 'Sara savings', type: 'bank', scope: 'personal', visibility: 'private', opening: '150000' }, M);
  await tick();
  const owner = await mk(repo, 'ahmed', true); await tick();
  assert.equal(owner.asset(id), null, 'Home owner cannot read');
  assert.equal(owner.portfolio().totalMinor, 0, 'and it never enters his totals');
  await sara.updateAsset(id, { visibility: 'shared', sharedWith: ['ahmed'] }, M); await tick();
  assert.ok((await mk(repo, 'ahmed')).asset(id), 'after sharing: visible');
  assert.ok(repo.calls.commits.at(-1).some((c) => c.startsWith('update:savingsEvents')), 'events re-labelled in the same batch');
  await sara.updateAsset(id, { visibility: 'private', sharedWith: [] }, M); await tick();
  const owner2 = await mk(repo, 'ahmed'); await tick();
  assert.equal(owner2.asset(id), null, 'un-shared: hidden again');
  assert.equal(owner2.getSnapshot().events.length, 0, 'including its history');
});

test('store: contribution, withdrawal (no overdraft), adjustment; metadata edit moves no money', async () => {
  const repo = fakeRepo(); const s = await mk(repo);
  const id = await s.createAsset({ name: 'Emergency', type: 'cash', scope: 'personal', opening: '25000' }, M); await tick();
  await s.addEvent(id, { type: 'contribution', amount: '5000', date: '2026-10-06' });
  await s.addEvent(id, { type: 'withdrawal', amount: '2000', date: '2026-10-06' });
  await s.addEvent(id, { type: 'adjustment', amount: '-120', date: '2026-10-06' }); await tick();
  assert.equal(s.balance(id), 2788000);
  await assert.rejects(s.addEvent(id, { type: 'withdrawal', amount: '999999', date: '2026-10-06' }), (e) => e.detail === 'savings.validation.insufficient');
  const before = s.getSnapshot().events.length;
  await s.updateAsset(id, { name: 'Emergency fund' }, M); await tick();
  assert.equal(s.getSnapshot().events.length, before, 'rename creates no event');
  await s.archiveAsset(id); await tick();
  assert.equal(s.asset(id).active, false); assert.equal(s.balance(id), 2788000, 'archive keeps history');
});

test('store: transfers — two linked legs, cash→gold conversion with cost, wealth unchanged, never expense/income', async () => {
  const repo = fakeRepo(); const s = await mk(repo);
  const cashId = await s.createAsset({ name: 'Cash', type: 'cash', scope: 'personal', opening: '200000' }, M);
  const goldId = await s.createAsset({ name: 'Gold', type: 'gold', scope: 'personal', purity: '21' }, M);
  await s.addQuote({ kind: 'metal', key: 'gold-21', price: '4000' }); await tick();
  const tid = await s.transfer({ fromId: cashId, toId: goldId, amount: '100000', inAmount: '25', date: '2026-10-06' }); await tick();
  const legs = s.getSnapshot().events.filter((e) => e.transferId === tid);
  assert.deepEqual(legs.map((e) => e.type).sort(), ['transfer_in', 'transfer_out']);
  assert.equal(legs.find((e) => e.type === 'transfer_in').costMinor, 10000000);
  assert.equal(s.balance(goldId), 25000);
  assert.equal(s.portfolio().totalMinor, 20000000, '100,000 cash + 25 g × 4,000 = 200,000 (unchanged)');
  assert.ok(!repo.calls.commits.flat().some((c) => c.includes(':expenses:')), 'no expense written');
  await assert.rejects(s.transfer({ fromId: cashId, toId: goldId, amount: '1', date: '2026-10-06' }), (e) => e.detail === 'savings.validation.inAmountRequired');
});

test('store: wallet ↔ savings writes ONE movement + ONE linked event; never an expense', async () => {
  const repo = fakeRepo(); const s = await mk(repo);
  const em = await s.createAsset({ name: 'Emergency', type: 'cash', scope: 'personal' }, M); await tick();
  const wallet = { id: 'bank', visibility: 'household', readers: [], currency: 'EGP', active: true };
  const tid = await s.walletTransfer({ wallet, assetId: em, direction: 'in', amount: '10000', date: '2026-10-06' }); await tick();
  const c = repo.calls.commits.at(-1);
  assert.deepEqual(c.sort(), [`set:savingsEvents:${tid}_in`, `set:walletMovements:sv_${tid}`].sort());
  const mv = repo.data.get(`H/walletMovements/sv_${tid}`);
  assert.deepEqual([mv.type, mv.fromWalletId, mv.toWalletId, mv.amountMinor], ['savings', 'bank', null, 1000000]);
  await s.walletTransfer({ wallet, assetId: em, direction: 'out', amount: '5000', date: '2026-10-06' }); await tick();
  assert.equal(s.balance(em), 500000);
  assert.ok(!c.some((x) => x.includes(':expenses:')));
  await assert.rejects(s.walletTransfer({ wallet: { ...wallet, currency: 'USD' }, assetId: em, direction: 'in', amount: '1', date: '2026-10-06' }), (e) => e.detail === 'savings.validation.currencyMismatch');
});

test('store: Zakat settings versioned (append-only), snapshots kept, payment + ONE linked expense, no duplicates', async () => {
  const repo = fakeRepo(); const s = await mk(repo);
  await s.saveProfile('ahmed', { ...DEFAULT_PROFILE, rateBps: 250 }, { readers: ['ahmed'] });
  await s.saveProfile('ahmed', { ...DEFAULT_PROFILE, nisabBasis: 'silver' }, { readers: ['ahmed'] }); await tick();
  assert.equal(s.profileFor('ahmed').nisabBasis, 'silver'); assert.equal(s.profileFor('ahmed')._version, 2);
  assert.equal(s.getSnapshot().zakat.filter((r) => r.kind === 'profile').length, 2, 'old version kept (audit)');
  const pid = await s.recordPayment('ahmed', { amount: '7125', date: '2026-10-06', readers: ['ahmed'], linkExpense: true }); await tick();
  const exp = repo.data.get(`H/expenses/zk_${pid}`);
  assert.deepEqual([exp.category, exp.amountMinor, exp.paidBy, exp.source], ['zakat', 712500, 'ahmed', 'app']);
  assert.equal(repo.data.get(`H/zakatRecords/${pid}`).linkedExpenseId, `zk_${pid}`);
  await assert.rejects(repo.commit('H', [{ mode: 'set', name: 'expenses', id: `zk_${pid}`, data: {} }]), 'same id cannot be written twice');
  const p2 = await s.recordPayment('ahmed', { amount: '100', date: '2026-10-06', readers: ['ahmed'] });
  assert.equal(repo.data.get(`H/zakatRecords/${p2}`).linkedExpenseId, null, 'link is optional');
  const snap = await s.recordSnapshot('ahmed', s.zakatFor('ahmed', '2026-10-06'), { date: '2026-10-06', readers: ['ahmed'] }); await tick();
  assert.equal(s.snapshots('ahmed')[0].id, snap);
});

test('permissions: matrix + non-destructive v6 upgrade', () => {
  const p = Object.fromEntries(defaultRoles().map((r) => [r.id, createPermissionSet(r.permissions)]));
  const A = ['view', 'viewTotals', 'personal', 'manageHousehold', 'transfer', 'prices', 'zakat'];
  const m = (r) => A.filter((a) => p[r].can(`savings.${a}`));
  assert.deepEqual(m('owner'), A); assert.deepEqual(m('admin'), A);
  assert.deepEqual(m('member'), ['view', 'viewTotals', 'personal', 'transfer', 'prices', 'zakat']);
  assert.deepEqual(m('viewer'), ['view']); assert.deepEqual(m('child'), ['personal'], 'child: own savings only');
  assert.equal(ROLE_TEMPLATE_VERSION, 9); assert.deepEqual(TEMPLATE_CHANGES[9], ['contacts']); assert.deepEqual(TEMPLATE_CHANGES[6], ['savings']); assert.deepEqual(TEMPLATE_CHANGES[7], ['expenses']); assert.deepEqual(TEMPLATE_CHANGES[8], ['calendar']);   // v8: V6.2
  const up = upgradeRolePermissions({ current: ['custom.x', 'expenses.view', 'members.view', 'rooms.view'], template: defaultRoles().find((r) => r.id === 'member').permissions, from: 5 });
  for (const keep of ['custom.x', 'expenses.view', 'members.view', 'rooms.view', 'savings.personal']) assert.ok(up.includes(keep), keep);
});
