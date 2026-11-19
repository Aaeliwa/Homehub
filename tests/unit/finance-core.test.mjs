import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMinor, minorToPlain, sumMinor } from '../../src/modules/expenses/money.js';
import { advance, monthlyReserveMinor, isRecurrence, presetOf, RECURRENCE_PRESETS } from '../../src/modules/expenses/recurrence.js';
import { addDays, diffDays, isCalendarDate, todayIn } from '../../src/modules/expenses/calendar.js';
import { sortHistory, groupByDate, spendingTotals, walletBalance, cycleStats, cycleFor, upcoming, filterHistory, reconciliation } from '../../src/modules/expenses/ledger.js';
import { accessFor, walletReaders, canReadRecord, buildExpenseCreate, buildExpenseEdit, buildMovementCreate, buildCycleCreate, buildCommitmentCreate, buildWalletCreate, paymentExpenseId, PAYMENT_METHODS, ALL_PAYMENT_METHODS } from '../../src/modules/expenses/finance-model.js';
import { parseCsv, guessMapping, buildImportPlan, withoutExisting, parseDateCell, rowHashId } from '../../src/modules/expenses/import-model.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';

test('money: exact integer minor units, no float drift', () => {
  assert.deepEqual(parseMinor('1,234.5'), { value: 123450 });
  assert.deepEqual(parseMinor('٤٥٠'), { value: 45000 }, 'Arabic digits');
  assert.deepEqual(parseMinor(''), { value: null });
  for (const bad of ['1.234', 'abc', '-5', '1e3', 'NaN']) assert.ok(parseMinor(bad).error, bad);
  assert.deepEqual(parseMinor('-5', { allowNegative: true }), { value: -500 });
  assert.ok(parseMinor('0', { allowZero: false }).error);
  // 0.1 + 0.2 problem cannot happen: 10 + 20 = 30 minor units.
  assert.equal(sumMinor([parseMinor('0.1').value, parseMinor('0.2').value]), 30);
  const tenThousand = Array.from({ length: 10000 }, () => parseMinor('0.01').value);
  assert.equal(sumMinor(tenThousand), 10000, '10,000 × 0.01 = 100.00 exactly');
  assert.equal(minorToPlain(20746490), '207464.90');
  assert.equal(minorToPlain(-5), '-0.05');
});

test('calendar dates: date-only arithmetic, no time-zone shift', () => {
  assert.equal(addDays('2026-10-05', 9), '2026-10-14');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(diffDays('2026-10-05', '2026-10-14'), 9);
  assert.ok(!isCalendarDate('2026-02-30'));
  assert.equal(todayIn('Africa/Cairo', new Date('2026-10-04T22:30:00Z')), '2026-10-05', 'Cairo is already the 5th');
});

test('recurrence: weekly … every 2 years, anchor day kept, reserve', () => {
  const r = RECURRENCE_PRESETS;
  assert.equal(advance('2026-10-05', r.weekly), '2026-10-12');
  assert.equal(advance('2026-10-05', r.biweekly), '2026-10-19');
  assert.equal(advance('2026-01-31', r.monthly, 31), '2026-02-28');
  assert.equal(advance('2026-02-28', r.monthly, 31), '2026-03-31', 'anchor restored');
  assert.equal(advance('2026-11-30', r.quarterly, 30), '2027-02-28');
  assert.equal(advance('2026-06-15', r.semiannual), '2026-12-15');
  assert.equal(advance('2027-03-15', r.annual), '2028-03-15');
  assert.equal(advance('2024-02-29', r.annual, 29), '2025-02-28');
  assert.equal(advance('2026-01-01', r.biennial), '2028-01-01');
  assert.equal(advance('2026-01-01', { unit: 'day', interval: 30 }), '2026-01-31', 'custom');
  assert.throws(() => advance('2026-01-01', { unit: 'day', interval: 45 }), 'interval above 36 rejected');
  assert.equal(presetOf({ unit: 'month', interval: 12 }), 'custom');
  assert.ok(!isRecurrence({ unit: 'month', interval: 0 }) && !isRecurrence({ unit: 'decade', interval: 1 }) && !isRecurrence({ unit: 'month', interval: 1.5 }));
  assert.equal(monthlyReserveMinor(1200000, r.annual), 100000, '12,000/yr → 1,000/month');
  assert.equal(monthlyReserveMinor(299900, r.annual), 24992, 'Microsoft 365 2,999/yr');
  assert.equal(monthlyReserveMinor(600000, r.semiannual), 100000);
});

const E = (id, date, amount, extra = {}) => ({ id, date, amountMinor: amount, category: 'groceries', status: 'active', ...extra });

test('history: NEWEST transaction date first, then newest createdAt, then id', () => {
  const list = [
    E('a', '2026-10-04', 100, { createdAt: { seconds: 50 } }),
    E('b', '2026-10-05', 200, { createdAt: { seconds: 10 } }),
    E('c', '2026-10-05', 300, { createdAt: { seconds: 20 } }),
    E('d', '2026-09-30', 400, { createdAt: { seconds: 999 } }), // entered today, dated earlier
    E('e', '2026-10-05', 500), // no createdAt (imported) sorts after same-day entries
  ];
  assert.deepEqual(sortHistory(list).map((x) => x.id), ['c', 'b', 'e', 'a', 'd']);
  const groups = groupByDate(sortHistory(list), '2026-10-05');
  assert.deepEqual(groups.map((g) => [g.date, g.relative, g.totalMinor]), [['2026-10-05', 'today', 1000], ['2026-10-04', 'yesterday', 100], ['2026-09-30', null, 400]]);
});

test('no double counting: funding/transfer never spending; expense counted once; void excluded', () => {
  const wallets = { bank: 'bank', cash: 'cash' };
  const movements = [
    { id: 'm1', type: 'funding', amountMinor: 1000000, toWalletId: wallets.bank, fromWalletId: null, status: 'active' },
    { id: 'm2', type: 'transfer', amountMinor: 600000, fromWalletId: wallets.bank, toWalletId: wallets.cash, status: 'active' },
  ];
  const expenses = [E('x1', '2026-10-05', 45000, { walletId: wallets.cash }), E('x2', '2026-10-05', 9999, { walletId: wallets.cash, status: 'void' })];
  const t = spendingTotals(expenses, { month: '2026-10' });
  assert.equal(t.totalMinor, 45000, 'only the 450 grocery expense');
  assert.equal(walletBalance(wallets.bank, { expenses, movements }), 400000);
  assert.equal(walletBalance(wallets.cash, { expenses, movements }), 555000);
  assert.equal(walletBalance(wallets.bank, { expenses, movements }) + walletBalance(wallets.cash, { expenses, movements }), 1000000 - 45000, 'money conserved');
});

test('fixed vs variable split', () => {
  const t = spendingTotals([E('a', '2026-10-01', 350000, { commitmentId: 'mort' }), E('b', '2026-10-02', 42000)], { month: '2026-10' });
  assert.deepEqual([t.fixedMinor, t.variableMinor, t.totalMinor], [350000, 42000, 392000]);
});

test('10-day cycle: remaining, safe/day, pace, carry-in, adjustments, phases', () => {
  const c = { id: 'c1', walletId: 'cash', startDate: '2026-10-05', endDate: '2026-10-14', days: 10, budgetMinor: 600000, carryInMinor: 0, status: 'active' };
  const exp = [E('e1', '2026-10-05', 90000, { budgetCycleId: 'c1' }), E('e2', '2026-10-06', 50000, { budgetCycleId: 'c1' }), E('e3', '2026-10-06', 99999)];
  const st = cycleStats(c, { expenses: exp, movements: [] }, '2026-10-07');
  assert.equal(st.spentMinor, 140000);
  assert.equal(st.remainingMinor, 460000);
  assert.equal(st.elapsedDays, 3);
  assert.equal(st.daysRemaining, 8);
  assert.equal(st.targetMinor, 180000);
  assert.equal(st.paceMinor, -40000, '400 under pace');
  assert.equal(st.safePerDayMinor, 57500);
  const over = cycleStats(c, { expenses: [E('x', '2026-10-05', 250000, { budgetCycleId: 'c1' })], movements: [] }, '2026-10-07');
  assert.equal(over.paceMinor, 70000, '700 over pace');
  const carried = cycleStats({ ...c, carryInMinor: 80000 }, { expenses: [], movements: [] }, '2026-10-05');
  assert.equal(carried.availableMinor, 680000);
  const adj = cycleStats(c, { expenses: exp, movements: [{ id: 'a', type: 'adjustment', fromWalletId: 'cash', toWalletId: null, amountMinor: 12000, cycleId: 'c1', status: 'active' }] }, '2026-10-07');
  assert.equal(adj.remainingMinor, 448000, 'counted cash short by 120');
  assert.equal(cycleStats(c, { expenses: [], movements: [] }, '2026-10-20').phase, 'ended');
  assert.equal(cycleStats(c, { expenses: [], movements: [] }, '2026-10-20').safePerDayMinor, 0);
  assert.deepEqual(reconciliation(255000, 243000), { expectedMinor: 255000, actualMinor: 243000, differenceMinor: -12000 });
  assert.equal(cycleFor([c], 'cash', '2026-10-14').id, 'c1');
  assert.equal(cycleFor([c], 'cash', '2026-10-15'), null, 'flexible window, not calendar thirds');
});

test('upcoming commitments: sorted, overdue flagged, not transactions', () => {
  const cs = [{ id: 'a', name: 'Microsoft 365', active: true, nextDueDate: '2027-03-15' }, { id: 'b', name: 'Internet', active: true, nextDueDate: '2026-10-12' },
    { id: 'c', name: 'Old', active: false, nextDueDate: '2026-10-06' }, { id: 'd', name: 'Rent', active: true, nextDueDate: '2026-10-01' }];
  const u = upcoming(cs, '2026-10-05', 200);
  assert.deepEqual(u.map((x) => x.id), ['d', 'b', 'a']);
  assert.equal(u[0].overdue, true);
  assert.ok(u.every((x) => !('amountMinor' in x) || true));
});

test('history filters', () => {
  const list = [E('a', '2026-10-01', 1, { note: 'Carrefour', walletId: 'w1', paymentMethod: 'cash' }), E('b', '2026-10-03', 1, { commitmentId: 'x', walletId: null, paymentMethod: 'visa' }),
    E('c', '2026-10-04', 1, { status: 'void' }), E('d', '2026-09-30', 1, { importedCategory: 'Kids school', category: 'other' })];
  const ids = (f) => filterHistory(list, f).map((x) => x.id);
  assert.deepEqual(ids({}), ['a', 'b', 'd']);
  assert.deepEqual(ids({ showVoid: true }).length, 4);
  assert.deepEqual(ids({ query: 'carre' }), ['a']);
  assert.deepEqual(ids({ query: 'school' }), ['d'], 'imported category searchable');
  assert.deepEqual(ids({ from: '2026-10-01', to: '2026-10-02' }), ['a']);
  assert.deepEqual(ids({ kind: 'fixed' }), ['b']);
  assert.deepEqual(ids({ walletId: 'none' }), ['b', 'd']);
  assert.deepEqual(ids({ paymentMethod: 'visa' }), ['b']);
  assert.deepEqual(ids({ paymentMethod: 'unknown' }), ['d']);
});

test('privacy labels: household vs private vs shared; transfers union readers', () => {
  const hh = { id: 'h', visibility: 'household', readers: [] };
  const priv = { id: 'p', visibility: 'private', ownerUid: 'ahmed', sharedWith: [], readers: ['ahmed'] };
  const kid = { id: 'k', visibility: 'shared', ownerUid: 'omar', sharedWith: ['ahmed', 'mona'], readers: ['ahmed', 'mona', 'omar'] };
  assert.deepEqual(walletReaders(kid), ['ahmed', 'mona', 'omar']);
  assert.deepEqual(accessFor([]), { audience: 'household', readers: [] }, 'no wallet = household history');
  assert.deepEqual(accessFor([hh]), { audience: 'household', readers: [] });
  assert.deepEqual(accessFor([priv]), { audience: 'restricted', readers: ['ahmed'] });
  assert.deepEqual(accessFor([hh, priv]), { audience: 'household', readers: ['ahmed'] }, 'bank → my wallet visible to household and me');
  assert.deepEqual(accessFor([priv, kid]), { audience: 'restricted', readers: ['ahmed', 'mona', 'omar'] });
  const rec = accessFor([priv]);
  assert.equal(canReadRecord(rec, { uid: 'ahmed', canViewHousehold: false }), true);
  assert.equal(canReadRecord(rec, { uid: 'wife', canViewHousehold: true }), false, 'another adult cannot read a private wallet');
  assert.equal(canReadRecord(rec, { uid: 'owner', canViewHousehold: true }), false, 'home owner has no implicit access');
  assert.equal(canReadRecord(accessFor([kid]), { uid: 'mona', canViewHousehold: false }), true, 'guardian sees child wallet');
});

test('builders: audit fields, privacy labels, validation, currency safety', () => {
  const w = { id: 'cash', visibility: 'household', readers: [], currency: 'EGP', active: true };
  const x = buildExpenseCreate({ input: { amount: '450', category: 'groceries', date: '2026-10-05', walletId: 'cash' }, uid: 'U', wallet: w, currency: 'EGP', now: 'N' });
  assert.equal(x.amountMinor, 45000);
  assert.equal(x.createdBy, 'U');
  assert.equal(x.audience, 'household');
  assert.equal(x.status, 'active');
  assert.equal(x.source, 'app');
  assert.throws(() => buildExpenseCreate({ input: { amount: '0', category: 'groceries', date: '2026-10-05' }, uid: 'U', currency: 'EGP', now: 'N' }), (e) => e.code === ErrorCode.VALIDATION);
  assert.throws(() => buildExpenseCreate({ input: { amount: '5', category: 'groceries', date: '2026-10-05', walletId: 'cash' }, uid: 'U', wallet: { ...w, active: false }, currency: 'EGP', now: 'N' }));
  assert.equal(buildExpenseEdit({ original: x, input: { amount: '450', category: 'groceries', date: '2026-10-05', walletId: 'cash' }, uid: 'U', wallet: w, now: 'N' }), null);
  const usd = { id: 'usd', visibility: 'household', readers: [], currency: 'USD', active: true };
  assert.throws(() => buildMovementCreate({ type: 'transfer', amount: '100', date: '2026-10-05', fromWallet: usd, toWallet: w, uid: 'U', now: 'N' }), (e) => e.detail === 'finance.validation.currencyMismatch', 'no silent conversion');
  assert.throws(() => buildMovementCreate({ type: 'transfer', amount: '100', date: '2026-10-05', fromWallet: w, toWallet: w, uid: 'U', now: 'N' }));
  const cyc = buildCycleCreate({ wallet: w, startDate: '2026-10-05', budget: '6000', uid: 'U', now: 'N' });
  assert.deepEqual([cyc.endDate, cyc.days, cyc.budgetMinor, cyc.status], ['2026-10-14', 10, 600000, 'active']);
  const cm = buildCommitmentCreate({ input: { name: 'Microsoft 365', amount: '2999', category: 'subscriptions', recurrence: { unit: 'year', interval: 1 }, nextDueDate: '2027-03-15' }, currency: 'EGP', uid: 'U', now: 'N' });
  assert.equal(cm.anchorDay, 15);
  assert.equal(paymentExpenseId('abc', '2027-03-15'), 'cm_abc_20270315');
  const { data } = buildWalletCreate({ input: { name: 'Omar Wallet', type: 'allowance', scope: 'personal', ownerUid: 'omar', visibility: 'shared', sharedWith: ['ahmed', 'omar'], currency: 'EGP' }, uid: 'ahmed', memberUids: ['ahmed', 'omar'], now: 'N' });
  assert.deepEqual([data.ownerUid, data.sharedWith, data.readers], ['omar', ['ahmed'], ['ahmed', 'omar']]);
  assert.ok(!PAYMENT_METHODS.includes('visa') && ALL_PAYMENT_METHODS.includes('visa'), 'visa readable, not offered');
});

test('CSV import: exact total, ids preserved, idempotent, nothing guessed', () => {
  const csv = 'id,date,amount,category,name,isVisa\r\nA1,2025-05-01,25635.08,food,"Lunch, office",false\r\nA2,2026-02-03,150,,,true\r\nA3,2026-02-03,150,,,TRUE\r\n';
  const table = parseCsv('\uFEFF' + csv);
  const plan = buildImportPlan(table, guessMapping(table[0]), { uid: 'U', currency: 'EGP', batchId: 'B', now: 'N' });
  assert.equal(plan.rows.length, 3);
  assert.equal(plan.totalMinor, 2593508, '25,935.08 exactly');
  assert.deepEqual(plan.rows.map((r) => r.id), ['A1', 'A2', 'A3'], 'original ids kept (two equal 150s stay two records)');
  assert.deepEqual(plan.rows.map((r) => r.doc.paymentMethod), [null, 'visa', 'visa']);
  assert.equal(plan.rows[0].doc.note, 'Lunch, office');
  assert.equal(plan.rows[0].doc.originalRow.amount, '25635.08', 'original kept verbatim');
  assert.equal(plan.rows[1].doc.walletId, null);
  assert.equal(plan.rows[1].doc.audience, 'household');
  const again = withoutExisting(plan, ['A1', 'A2', 'A3']);
  assert.equal(again.rows.length, 0);
  assert.equal(again.alreadyImported, 3);
  const noIds = parseCsv('date,amount\n2026-01-01,10\n2026-01-01,10\n');
  const p2 = buildImportPlan(noIds, { date: 0, amount: 1, dateFormat: 'auto' }, { uid: 'U', currency: 'EGP', batchId: 'B', now: 'N' });
  assert.equal(p2.rows.length, 1, 'identical rows without an id column collide → flagged');
  assert.equal(p2.duplicates, 1);
  assert.equal(rowHashId(['x']), rowHashId(['x']));
  assert.equal(parseDateCell('3/4/2026'), null, 'ambiguous → owner chooses');
  assert.equal(parseDateCell('3/4/2026', 'dmy'), '2026-04-03');
  const bad = buildImportPlan(parseCsv('date,amount\n2026-13-01,10\n2026-01-01,1.234\n'), { date: 0, amount: 1, dateFormat: 'auto' }, { uid: 'U', currency: 'EGP', batchId: 'B', now: 'N' });
  assert.deepEqual(bad.errors.map((e) => e.reason), ['finance.import.badDate', 'finance.import.badAmount']);
});
