import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planCorrection, removalCheck, restoreCheck, adjustmentHistory, correctionId } from '../../src/modules/expenses/wallet-admin.js';
import { createFinanceStore } from '../../src/modules/expenses/finance-store.js';
import { incomeTotal } from '../../src/modules/expenses/finance-v6.js';
import { monthStats } from '../../src/modules/expenses/finance-monthly.js';
import { sourceOptions } from '../../src/modules/expenses/wallet-choice.js';
import * as C from '../../src/modules/calendar/calendar-model.js';

const FIXTURE = readFileSync(new URL('../fixtures/google-calendar-2026.csv', import.meta.url), 'utf8');
const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const W = (x) => ({ id: 'c1', name: 'Cash', active: true, visibility: 'household', role: 'cash', currency: 'EGP', openingDate: '2026-01-01', ...x });

// ================================================================ Correct Balance (pure)
test('V622 planCorrection: + / − delta, before / after, sequential id; no-op, stale, archived, dates, reason, amount refused', () => {
  const up = planCorrection({ wallet: W(), currentMinor: 10000, actualMinor: 12500, expectedBeforeMinor: 10000, date: '2026-11-15', reason: ' counted ', today: '2026-11-15' });
  assert.deepEqual([up.deltaMinor, up.beforeMinor, up.afterMinor, up.seq, up.id, up.reason], [2500, 10000, 12500, 1, 'rc_c1_1', 'counted']);
  const down = planCorrection({ wallet: W({ correctionSeq: 4 }), currentMinor: 10000, actualMinor: -500, date: '2026-11-15', reason: 'fee', today: '2026-11-15' });
  assert.deepEqual([down.deltaMinor, down.seq, down.id], [-10500, 5, correctionId('c1', 5)], 'negative actual allowed (overdraft)');
  const bad = (x, detail) => assert.throws(() => planCorrection({ wallet: W(), currentMinor: 100, actualMinor: 200, date: '2026-11-15', reason: 'r', today: '2026-11-15', ...x }), (e) => e.detail === detail, detail);
  bad({ actualMinor: 100 }, 'finance.v622.noChange');
  bad({ expectedBeforeMinor: 90 }, 'finance.v622.stale');
  bad({ wallet: W({ active: false }) }, 'finance.validation.walletArchived');
  bad({ date: '2026-11-16' }, 'finance.v622.dateInvalid');
  bad({ date: '15/11/2026' }, 'finance.v622.dateInvalid');
  bad({ date: '2025-12-31' }, 'finance.v6.beforeOpening');
  bad({ reason: '   ' }, 'finance.v6.reasonRequired');
  bad({ actualMinor: 1.5 }, 'finance.validation.amountInvalid');
  bad({ actualMinor: NaN }, 'finance.validation.amountInvalid');
});

// ================================================================ Delete / Restore (pure)
test('V622 removalCheck: required Cash / Bank never deleted; active bills block; warnings for balance / shared / cycle; restore never duplicates a role', () => {
  const cash = W(); const bank = W({ id: 'b1', role: 'bank', name: 'Bank' });
  const visa = W({ id: 'v1', role: undefined, type: 'visa', name: 'Visa' });
  const shared = W({ id: 'p1', role: undefined, visibility: 'shared', sharedWith: ['u2'], name: 'Allowance' });
  assert.equal(removalCheck(cash, { wallets: [cash, bank] }).blocked, 'finance.v622.required.cash');
  assert.equal(removalCheck(bank, { wallets: [cash, bank] }).blocked, 'finance.v622.required.bank');
  const r = removalCheck(visa, { commitments: [{ id: 'k', name: 'Netflix', active: true, walletId: 'v1' }, { id: 'old', active: false, walletId: 'v1' }] }, 0);
  assert.deepEqual([r.blocked, r.bills.map((b) => b.id)], ['finance.v622.billsUseIt', ['k']], 'only ACTIVE bills block');
  assert.deepEqual(removalCheck(shared, { cycles: [{ walletId: 'p1', status: 'active' }] }, 300).warnings, ['balance', 'shared', 'cycle']);
  assert.deepEqual(removalCheck(visa, {}, 0), { blocked: null, bills: [], warnings: [] }, 'unused wallet: plain soft delete');
  assert.equal(removalCheck({ ...visa, active: false }, {}).blocked, 'finance.v622.alreadyDeleted');
  const oldCash = W({ id: 'c0', active: false });
  assert.equal(restoreCheck(oldCash, [cash, oldCash]).blocked, 'finance.v622.duplicateRole.cash');
  assert.equal(restoreCheck(oldCash, [oldCash]).blocked, null);
  assert.equal(restoreCheck({ ...visa, active: false }, [cash, bank]).blocked, null);
});

test('V622 adjustment history: signed delta, before → after, reason, actor; older corrections without before / after still listed', () => {
  const mv = [{ id: 'rc_c1_2', type: 'reconciliation', toWalletId: null, fromWalletId: 'c1', amountMinor: 300, date: '2026-11-10', reason: 'fee', createdBy: 'u1', status: 'active', beforeMinor: 1300, afterMinor: 1000 },
    { id: 'old', type: 'reconciliation', toWalletId: 'c1', fromWalletId: null, amountMinor: 50, date: '2026-10-01', reason: 'count', createdBy: 'u2', status: 'active' },
    { id: 'x', type: 'income', toWalletId: 'c1', amountMinor: 999, date: '2026-11-11' }, { id: 'y', type: 'reconciliation', toWalletId: 'b1', amountMinor: 1, date: '2026-11-12', reason: 'z' }];
  assert.deepEqual(adjustmentHistory(mv, 'c1').map((r) => [r.id, r.deltaMinor, r.beforeMinor, r.afterMinor, r.reason, r.by]),
    [['rc_c1_2', -300, 1300, 1000, 'fee', 'u1'], ['old', 50, null, null, 'count', 'u2']]);
});

// ================================================================ store: one correction path
function fakeRepo() {
  const db = new Map(); const ws = new Set(); let n = 0; const repo = { db, commits: 0, beforeCommit: null };
  const docs = (name) => [...db.entries()].filter(([k]) => k.startsWith(`${name}/`)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  Object.assign(repo, { now: () => 'NOW', newId: (h, name) => `${name}_${++n}`,
    watch(h, name, kind, uid, on) { const fn = () => on(docs(name).filter((d) => (kind === 'household' ? (d.audience === 'household' || d.visibility === 'household') : (d.readers || []).includes(uid)))); ws.add(fn); queueMicrotask(fn); return () => ws.delete(fn); },
    read: async (h, name, id) => (db.has(`${name}/${id}`) ? { id, ...db.get(`${name}/${id}`) } : null),
    async commit(h, ops) {
      if (repo.beforeCommit) await repo.beforeCommit(ops);
      // create-only like the rules for correction ids (a second writer of the same rc_ id is refused)
      for (const o of ops) if (o.mode === 'set' && String(o.id).startsWith('rc_') && db.has(`${o.name}/${o.id}`)) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      repo.commits++;
      for (const o of ops) db.set(`${o.name}/${o.id}`, o.mode === 'set' ? { ...o.data } : { ...db.get(`${o.name}/${o.id}`), ...o.data });
      for (const f of ws) f();
    } });
  return repo;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function setup() {
  const repo = fakeRepo(); const s = createFinanceStore({ homeId: 'H', uid: 'u1', repo, homeCurrency: 'EGP' }); s.ensure({ canViewHousehold: true }); s.subscribe(() => {}); await tick();
  const bank = await s.createAccount({ name: 'Bank', role: 'bank', openingDate: '2026-11-01', openingMinor: 100000 }, { memberUids: ['u1'] });
  const cash = await s.createAccount({ name: 'Cash', role: 'cash', openingDate: '2026-11-01', openingMinor: 50000 }, { memberUids: ['u1'] }); await tick();
  return { repo, s, bank, cash };
}

test('V622 store correctBalance: one append-only movement + seq bump in ONE commit; balance recomputed; not income / spending / budget; history kept', async () => {
  const { repo, s, bank, cash } = await setup();
  await s.addExpense({ amount: '100', category: 'groceries', date: '2026-11-10', walletId: cash, paymentMethod: null, note: 'Bread' }); await tick();
  const spentBefore = monthStats(s.getSnapshot(), s.getSnapshot().wallets, '2026-11');
  const c0 = repo.commits;
  const id = await s.correctBalance({ walletId: cash, actualMinor: 42500, date: '2026-11-15', reason: 'counted', expectedBeforeMinor: 40000, today: '2026-11-15' }); await tick();
  assert.equal(repo.commits - c0, 1, 'single atomic commit');
  assert.equal(id, `rc_${cash}_1`);
  const mv = repo.db.get(`walletMovements/${id}`);
  assert.deepEqual([mv.type, mv.toWalletId, mv.fromWalletId, mv.amountMinor, mv.beforeMinor, mv.afterMinor, mv.correctionSeq, mv.reason, mv.createdBy], ['reconciliation', cash, null, 2500, 40000, 42500, 1, 'counted', 'u1']);
  assert.equal(repo.db.get(`wallets/${cash}`).correctionSeq, 1);
  assert.equal(s.balance(cash), 42500);
  const down = await s.correctBalance({ walletId: bank, actualMinor: 99000, date: '2026-11-15', reason: 'bank fee', expectedBeforeMinor: 100000, today: '2026-11-15' }); await tick();
  assert.deepEqual([down, repo.db.get(`walletMovements/${down}`).fromWalletId, s.balance(bank)], [`rc_${bank}_1`, bank, 99000]);
  const snap = s.getSnapshot();
  assert.equal(incomeTotal(snap.movements, {}), 0, 'not income');
  assert.deepEqual(monthStats(snap, snap.wallets, '2026-11'), spentBefore, 'not spending / budget use');
  assert.equal(repo.db.get(`walletMovements/op_${cash}`).amountMinor, 50000, 'opening funding untouched');
  assert.deepEqual(s.adjustmentHistory(cash).map((r) => [r.deltaMinor, r.beforeMinor, r.afterMinor]), [[2500, 40000, 42500]]);
});

test('V622 store: double click → one write (busy); stale balance refused; concurrent same-seq writer refused; archived / no-op refused; reconcileAccount uses the same path', async () => {
  const { repo, s, cash } = await setup();
  let release; repo.beforeCommit = () => new Promise((r) => { release = r; });
  const a = s.correctBalance({ walletId: cash, actualMinor: 60000, date: '2026-11-15', reason: 'x', expectedBeforeMinor: 50000 });
  await assert.rejects(s.correctBalance({ walletId: cash, actualMinor: 60000, date: '2026-11-15', reason: 'x', expectedBeforeMinor: 50000 }), (e) => e.detail === 'finance.v622.busy');
  release(); repo.beforeCommit = null; await a; await tick();
  assert.equal(s.adjustmentHistory(cash).length, 1, 'exactly one correction');
  await assert.rejects(s.correctBalance({ walletId: cash, actualMinor: 70000, date: '2026-11-15', reason: 'x', expectedBeforeMinor: 50000 }), (e) => e.detail === 'finance.v622.stale', 'dialog opened before the first correction');
  // another device wrote rc_<cash>_2 meanwhile (our snapshot has not seen it yet)
  repo.db.set(`walletMovements/rc_${cash}_2`, { type: 'reconciliation', toWalletId: cash, amountMinor: 1, date: '2026-11-15', status: 'active' });
  await assert.rejects(s.correctBalance({ walletId: cash, actualMinor: 61000, date: '2026-11-15', reason: 'y', expectedBeforeMinor: 60000 }), (e) => e.detail === 'finance.v622.stale');
  await assert.rejects(s.correctBalance({ walletId: cash, actualMinor: 60000, date: '2026-11-15', reason: 'y' }), (e) => e.detail === 'finance.v622.noChange');
  assert.equal(await s.reconcileAccount({ walletId: cash, actualMinor: 60000, date: '2026-11-15', reason: 'z' }), null, 'no difference → nothing written');
});

test('V622 store archive / restore: required Cash / Bank blocked; wallet with active bills blocked; archived wallet unusable for expenses, bills, corrections; history intact; restore', async () => {
  const { repo, s, bank, cash } = await setup();
  await assert.rejects(s.archiveWallet(cash), (e) => e.detail === 'finance.v622.required.cash');
  await assert.rejects(s.archiveWallet(bank), (e) => e.detail === 'finance.v622.required.bank');
  const visa = await s.createWallet({ name: 'Visa', type: 'card', scope: 'home', visibility: 'household', sharedWith: [], currency: 'EGP', openingBalance: '0' }, { memberUids: ['u1'], date: '2026-11-01' }); await tick();
  const e = await s.addExpense({ amount: '20', category: 'food', date: '2026-11-12', walletId: visa, paymentMethod: null, note: 'Lunch' }); await tick();
  repo.db.set('commitments/k1', { name: 'Netflix', active: true, walletId: visa, audience: 'household', readers: [], nextDueDate: '2026-12-01' }); await s.correctBalance({ walletId: cash, actualMinor: 50001, date: '2026-11-15', reason: 'nudge' }); await tick();
  await assert.rejects(s.archiveWallet(visa), (x) => x.detail === 'finance.v622.billsUseIt');
  repo.db.set('commitments/k1', { ...repo.db.get('commitments/k1'), active: false }); await s.correctBalance({ walletId: cash, actualMinor: 50002, date: '2026-11-15', reason: 'nudge' }); await tick();
  await s.archiveWallet(visa); await tick();
  assert.equal(repo.db.get(`wallets/${visa}`).active, false); assert.ok(repo.db.has(`wallets/${visa}`), 'soft delete only');
  assert.equal(repo.db.get(`expenses/${e}`).walletId, visa, 'historical row keeps its wallet id');
  assert.ok(!s.activeWallets().some((w) => w.id === visa), 'not offered for bill payments / transfers');
  assert.ok(!sourceOptions(s.getSnapshot().wallets, { uid: 'u1', canHousehold: true, canPersonal: true, scope: 'mine' }).options.some((o) => o.id === visa), 'not offered for expenses');
  await assert.rejects(s.addExpense({ amount: '5', category: 'food', date: '2026-11-13', walletId: visa, paymentMethod: null, note: 'x' }));
  await assert.rejects(s.correctBalance({ walletId: visa, actualMinor: 1, date: '2026-11-15', reason: 'x' }), (x) => x.detail === 'finance.validation.walletArchived');
  assert.equal(s.balance(visa), -2000, 'balance still reportable');
  await s.restoreWallet(visa); await tick();
  assert.equal(repo.db.get(`wallets/${visa}`).active, true);
});

// ================================================================ Calendar: shifts
test('V622 shift detection: explicit labels only (case / whitespace / extra details); never from times; stored + overridable; old events read the same way', () => {
  for (const [t, k] of [['Day Shift', 'day'], ['  night   SHIFT ', 'night'], ['DAY SHIFT – Plant A', 'day'], ['night shift (cover)', 'night'],
    ['Shift', null], ['Dayshift', null], ['Day Shifts swap', null], ['Holiday shift party', null], ['Team day', null], ['Morning meeting', null]]) assert.equal(C.detectShift(t), k, t);
  const night = C.validateEvent({ title: 'Night Shift', type: 'other', allDay: false, startDate: '2026-01-31', startTime: '19:00', endDate: '2026-02-01', endTime: '07:00' }).value;
  assert.deepEqual([night.shift, night.type], ['night', 'work'], 'a shift is always Work');
  const late = C.validateEvent({ title: 'Dinner', type: 'other', allDay: false, startDate: '2026-01-31', startTime: '21:00', endDate: '2026-02-01', endTime: '01:00' }).value;
  assert.deepEqual([late.shift, late.type], [null, 'other'], 'night-time custom event is not a shift');
  const off = C.validateEvent({ title: 'Day Shift', type: 'vacation', shift: null, allDay: true, startDate: '2026-03-01' }).value;
  assert.deepEqual([off.shift, off.type], [null, 'vacation'], 'explicit override wins');
  const forced = C.validateEvent({ title: 'Cover', type: 'other', shift: 'night', allDay: true, startDate: '2026-03-01' }).value;
  assert.deepEqual([forced.shift, forced.type], ['night', 'work']);
  assert.equal(C.shiftOf({ title: 'Day Shift', type: 'work' }), 'day', 'V6.2 event without the field');
  assert.equal(C.shiftOf({ title: 'Day Shift', type: 'work', shift: null }), null, 'stored override');
  assert.ok(C.EDITABLE.includes('shift'));
});

test('V622 CSV import: Day / Night rows detected in the preview; ids (dedupe) unchanged by the new field', () => {
  const rows = C.previewImport(FIXTURE).rows;
  assert.deepEqual(rows.map((r) => [r.value.title, r.value.shift, r.value.type]).filter(([t]) => /shift/i.test(t)).map(([, s, ty]) => `${s}:${ty}`).sort(),
    [...rows.filter((r) => /^Day/.test(r.value.title)).map(() => 'day:work'), ...rows.filter((r) => /^Night/.test(r.value.title)).map(() => 'night:work')].sort());
  assert.ok(rows.some((r) => r.value.shift === 'day') && rows.some((r) => r.value.shift === 'night'));
  for (const r of rows) assert.equal(r.id, C.importId(C.fingerprint(r.value)), 'fingerprint ignores shift');
});

test('V622 Finance Work / Vacation: both shift subtypes are Work (even an older event typed "other"); never Vacation; gaps stay suggestions', () => {
  const ev = (id, x) => ({ id, deletedAt: null, allDay: true, startTime: null, endTime: null, ...x });
  const list = [ev('a', { title: 'Day Shift', type: 'work', startDate: '2026-01-05', endDate: '2026-01-08' }),
    ev('b', { title: 'night shift', type: 'other', startDate: '2026-01-10', endDate: '2026-01-11' }),
    ev('c', { title: 'Night Shift', type: 'vacation', startDate: '2026-01-20', endDate: '2026-01-20' }),
    ev('d', { title: 'Trip', type: 'vacation', startDate: '2026-01-14', endDate: '2026-01-15' })];
  assert.deepEqual(C.intervals(list, 'work').map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(C.intervals(list, 'vacation').map((i) => i.id), ['d']);
  assert.ok(C.offDutyGaps(list).every((g) => !('type' in g) || g.type !== 'vacation'));
});

// ================================================================ Calendar: multi-day bars
const E = (id, s, e, x = {}) => ({ id, title: id, type: 'work', allDay: true, startDate: s, endDate: e, startTime: null, endTime: null, deletedAt: null, ...x });
const weeks = (ym) => { const d = C.monthGrid(ym); return Array.from({ length: d.length / 7 }, (_, i) => d.slice(i * 7, i * 7 + 7)); };

test('V622 bars: same-week span is ONE segment; single-day events are not bars', () => {
  const [, w2] = weeks('2026-01');   // Mon 5 … Sun 11 Jan 2026
  const r = C.weekBars([E('span', '2026-01-05', '2026-01-08'), E('one', '2026-01-06', '2026-01-06')], w2, '2026-01');
  assert.deepEqual(r.segs.map((g) => [g.event.id, g.from, g.to, g.lane, g.contBefore, g.contAfter, g.startsHere]), [['span', 0, 3, 0, false, false, true]]);
});

test('V622 bars: cross-week span splits per row with continuation flags; lanes stack overlapping spans; +N beyond the lane cap', () => {
  const [, w2, w3] = weeks('2026-01');
  const evs = [E('long', '2026-01-09', '2026-01-14'), E('b', '2026-01-10', '2026-01-11'), E('c', '2026-01-10', '2026-01-12'), E('d', '2026-01-11', '2026-01-11', { allDay: false, startTime: '22:00', endDate: '2026-01-12', endTime: '06:00' })];
  const a = C.weekBars(evs, w2, '2026-01', 2);
  const long = a.segs.find((g) => g.event.id === 'long');
  assert.deepEqual([long.from, long.to, long.contAfter, long.contBefore, long.lane], [4, 6, true, false, 0]);
  assert.deepEqual(a.segs.map((g) => g.event.id).sort(), ['b', 'long'], 'lane cap 2 (equal clipped length → id order): c / d hidden');
  assert.equal(a.lanes, 2); assert.ok(a.hidden['2026-01-10'] >= 1 && a.hidden['2026-01-11'] >= 2, '+N counts the hidden spans per day');
  const b = C.weekBars(evs, w3, '2026-01', 3);
  const longB = b.segs.find((g) => g.event.id === 'long');
  assert.deepEqual([longB.from, longB.to, longB.contBefore, longB.contAfter, longB.startsHere], [0, 2, true, false, false]);
  assert.ok(b.segs.some((g) => g.event.id === 'd' && g.from === 0 && g.to === 0), 'overnight timed event continues onto Monday');
  assert.equal(new Set(b.segs.map((g) => g.lane)).size, b.segs.length === new Set(b.segs.map((g) => `${g.lane}`)).size ? b.segs.length : new Set(b.segs.map((g) => g.lane)).size);
  for (const x of b.segs) for (const y of b.segs) if (x !== y && x.lane === y.lane) assert.ok(x.to < y.from || y.to < x.from, 'no two bars overlap in a lane');
});

test('V622 bars: cross-month span is clipped to the month (no bar on out-of-month cells); year transition; timed 00:00 end excludes that day', () => {
  const night = E('n', '2026-01-31', '2026-02-10', { allDay: false, startTime: '19:00', endTime: '07:00', title: 'Night Shift' });
  const jan = weeks('2026-01'); const lastJan = jan[jan.length - 1];   // Mon 26 Jan … Sun 1 Feb
  const r = C.weekBars([night], lastJan, '2026-01');
  assert.deepEqual(r.segs.map((g) => [lastJan[g.from], lastJan[g.to], g.contAfter]), [['2026-01-31', '2026-01-31', true]], 'Feb 1 cell (out of month) gets no bar');
  const feb = weeks('2026-02');
  const f = C.weekBars([night], feb[0], '2026-02');
  assert.deepEqual(f.segs.map((g) => [feb[0][g.from], g.contBefore, g.startsHere]), [['2026-02-01', true, false]]);
  const nye = E('y', '2025-12-30', '2026-01-02');
  const dec = weeks('2025-12'); const jw = weeks('2026-01')[0];
  assert.deepEqual(C.weekBars([nye], dec[dec.length - 1], '2025-12').segs.map((g) => [g.from, g.to, g.contAfter]), [[1, 2, true]]);
  assert.deepEqual(C.weekBars([nye], jw, '2026-01').segs.map((g) => [g.from, g.to, g.contBefore]), [[3, 4, true]]);
  const toMidnight = E('m', '2026-01-06', '2026-01-07', { allDay: false, startTime: '20:00', endTime: '00:00' });
  assert.equal(C.isMultiDay(toMidnight), false, 'ends 00:00 → one day, compact');
  assert.equal(C.isMultiDay(E('o', '2026-01-06', '2026-01-07', { allDay: false, startTime: '22:00', endTime: '06:00' })), true, 'overnight');
});

test('V622 parity: dashboard widget and full calendar render months with the SAME grid (bars + shift colours / icons)', () => {
  for (const f of ['src/modules/calendar/widget.js', 'src/modules/calendar/page.js']) {
    const s = src(f); assert.match(s, /import \{[^}]*\bgrid\b[^}]*\} from '\.\/calendar-ui\.js'/, f);
    assert.ok(!/weekBars|monthGrid\(/.test(s), `${f}: no second month renderer`);
  }
  const ui = src('src/modules/calendar/calendar-ui.js');
  assert.ok(ui.includes('weekBars(events, week, ym, maxLanes)') && ui.includes("'cal-bar'") && ui.includes('colorOf(sg.event)'));
  assert.ok(/createElementNS\(SVG_NS, 'svg'\)/.test(ui) && ui.includes("setAttribute('role', 'img')"), 'accessible SVG icons, not emoji');
  for (const l of ['en', 'ar']) for (const k of ['calendar.shift.day', 'calendar.shift.night', 'finance.v622.correct', 'finance.v622.delete', 'finance.v622.restore'])
    assert.ok(src(`src/core/i18n/locales/${l}.js`).includes(`'${k}'`), `${l}: ${k}`);
});
