import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { cashBank, sourceOptions, currentSource, editPaymentMethod } from '../../src/modules/expenses/wallet-choice.js';
import { narrow, historyRows } from '../../src/modules/expenses/finance-monthly.js';
import { createFinanceStore } from '../../src/modules/expenses/finance-store.js';

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const W = (id, x) => ({ id, active: true, visibility: 'household', readers: [], ...x });

test('V621 tabs: no 10-day budget / Advanced / Household entry points; files and labels retired; data code kept', () => {
  const page = src('src/modules/expenses/page.js');
  assert.match(page, /const TABS = Object\.freeze\(\['overview', 'history', 'commitments', 'wallets'\]\)/);
  for (const gone of ['tab-budget', 'tab-household', 'fin-advanced', "tab = 'budget'", "tab = 'household'", "budget: ()", "household: ()", 'renderBudgetTab', 'renderHouseholdTab', 'activeCycles'])
    assert.ok(!page.includes(gone), `page.js still references ${gone}`);
  for (const f of ['tab-budget.js', 'tab-household.js']) assert.equal(existsSync(new URL(`../../src/modules/expenses/${f}`, import.meta.url)), false, f);
  for (const l of ['en', 'ar']) for (const k of ['finance.tab.budget', 'finance.tab.household', 'finance.v62.advanced']) assert.ok(!src(`src/core/i18n/locales/${l}.js`).includes(`'${k}'`), `${l}: ${k}`);
  const store = src('src/modules/expenses/finance-store.js');
  for (const keep of ['cycleStats', 'createPeriod', 'createAccount']) assert.ok(store.includes(keep), `ledger logic kept: ${keep}`);
  assert.ok(src('src/modules/expenses/tab-wallets.js').includes("id: 'v6-setup'"), 'Cash / Bank setup moved to Wallets');
});

test('V621 one transaction renderer: Overview and History both use historyCard; table has date · name · category · wallet · signed amount · actions', () => {
  const m = src('src/modules/expenses/tab-monthly.js');
  assert.equal((m.match(/historyCard\(env, \{ setUi, filters: (true|false) \}\)/g) || []).length, 2, 'used by renderMonthlyTab and renderHistoryTab');
  assert.equal((m.match(/role: 'table'/g) || []).length, 1, 'exactly one table renderer');
  assert.match(m, /\['date', 'name', 'category', 'wallet', 'amount'\]/);
  assert.match(m, /`−\$\{fmt\(e\.amountMinor\)\}`/);
  assert.ok(m.includes("class: 'fm-scroll'"), 'wide table scrolls inside its card');
  const p = src('src/modules/expenses/page.js');
  assert.ok(p.includes('history: () => renderHistoryTab(env)') && !p.includes('fin-row--expense'), 'old grouped list renderer removed');
});

test('V621 wallet is the only expense source: no payment-method control in any entry path', () => {
  for (const f of ['expense-form.js', 'tab-monthly.js']) {
    const s = src(`src/modules/expenses/${f}`);
    for (const gone of ["'ex-pm'", "'fm-ex-pm'", "'fm-pay-pm'", 'PAYMENT_METHODS', 'methodOpts', 'walletFor(']) assert.ok(!s.includes(gone), `${f}: ${gone}`);
  }
  const f = src('src/modules/expenses/expense-form.js');
  assert.ok(f.includes("walletSelect('qa-wallet'") && f.includes("walletSelect('ex-wallet'"), 'quick add + dialog');
  assert.ok(src('src/modules/expenses/tab-monthly.js').includes("walletSelect('fm-ex-wallet'"), 'overview add');
});

test('V621 Cash / Bank mapping: role accounts first; else the unique typed wallet; ambiguity → not configured (no guess by name)', () => {
  const roles = [W('b1', { role: 'bank', type: 'bank', name: 'My Bank' }), W('c1', { role: 'cash', type: 'cash', name: 'Pocket' }), W('x', { type: 'cash', name: 'Cash' })];
  assert.deepEqual([cashBank(roles).cash.id, cashBank(roles).bank.id], ['c1', 'b1'], 'role wins over a wallet merely NAMED Cash');
  const typed = [W('hb', { type: 'bank', name: 'Household Bank' }), W('dc', { type: 'cash', name: 'Daily Cash' }), W('p', { type: 'cash', visibility: 'private', readers: ['u'] })];
  assert.deepEqual([cashBank(typed).cash.id, cashBank(typed).bank.id], ['dc', 'hb'], 'private wallets never count');
  const two = [...typed, W('dc2', { type: 'cash', name: 'Cash 2' })];
  assert.deepEqual([cashBank(two).cash, cashBank(two).ambiguous.cash, cashBank(two).bank.id], [null, true, 'hb']);
  assert.equal(cashBank([W('n', { type: 'bank', name: 'Cash', active: false })]).bank, null, 'archived → not configured');
  const o = sourceOptions(roles, { uid: 'u', canHousehold: true, canPersonal: true });
  assert.deepEqual([o.kind, o.options.map((x) => [x.slot, x.id]), o.missing], ['household', [['cash', 'c1'], ['bank', 'b1']], []], 'exactly Cash and Bank, by id');
  assert.deepEqual(sourceOptions([roles[0]], { uid: 'u', canHousehold: true }).missing, ['cash'], 'missing slot reported, not defaulted');
  assert.deepEqual(sourceOptions([], { uid: 'u', canHousehold: true }).options, []);
});

test('V621 personal entry (child / Mine scope): own writable wallets only; none → explicit missing', () => {
  const ws = [W('c1', { role: 'cash' }), W('al', { visibility: 'shared', readers: ['kid', 'mum'], name: 'Allowance' }), W('mp', { visibility: 'private', readers: ['mum'] })];
  assert.deepEqual(sourceOptions(ws, { uid: 'kid', canHousehold: false, canPersonal: true }).options.map((x) => x.id), ['al']);
  assert.deepEqual(sourceOptions(ws, { uid: 'mum', canHousehold: true, canPersonal: true, scope: 'mine' }).options.map((x) => x.id), ['al', 'mp']);
  assert.deepEqual(sourceOptions(ws, { uid: 'kid', canHousehold: false, canPersonal: false }).missing, ['personal']);
});

test('V621 edit: existing wallet state is explicit (listed / other / none / unknown); older payment-method kept unless the wallet changes', () => {
  const opts = [{ id: 'c1' }, { id: 'b1' }]; const by = (id) => (['c1', 'b1', 'arch'].includes(id) ? { id } : null);
  assert.equal(currentSource({ walletId: 'c1' }, opts, by), 'listed');
  assert.equal(currentSource({ walletId: 'arch' }, opts, by), 'other');
  assert.equal(currentSource({ walletId: null }, opts, by), 'none');
  assert.equal(currentSource({ walletId: 'deleted' }, opts, by), 'unknown', 'never silently defaulted');
  assert.equal(editPaymentMethod({ walletId: 'b1', paymentMethod: 'visa' }, 'b1'), 'visa', 'older field untouched');
  assert.equal(editPaymentMethod({ walletId: 'b1', paymentMethod: 'debit_card' }, 'c1'), null, 'wallet changed → wallet is the source');
  assert.equal(editPaymentMethod({ walletId: null, paymentMethod: 'cash' }, ''), 'cash');
});

test('V621 history filters: search spans all months; category / wallet narrowing after it; interval still defines its range', () => {
  const ex = [{ id: 'a', date: '2026-01-05', note: 'Rice', category: 'groceries', walletId: 'c1', amountMinor: 1 }, { id: 'b', date: '2026-11-02', note: 'Rice', category: 'food', walletId: 'b1', amountMinor: 1 },
    { id: 'c', date: '2026-11-03', note: 'Fuel', category: 'fuel', walletId: 'c1', amountMinor: 1 }, { id: 'd', date: '2026-11-04', note: 'Rice', category: 'groceries', walletId: 'c1', amountMinor: 1, status: 'void' }];
  const all = historyRows(ex, { q: 'rice', ym: '2026-11' }).rows;
  assert.deepEqual(all.map((e) => e.id), ['b', 'a'], 'all months, newest first, voided excluded');
  assert.deepEqual(narrow(all, { category: 'groceries' }).map((e) => e.id), ['a']);
  assert.deepEqual(narrow(all, { walletId: 'b1' }).map((e) => e.id), ['b']);
  assert.deepEqual(narrow(all, {}).length, 2);
});

/* ---------- store: wallet-only writes hit the ledger exactly once ---------- */
function fakeRepo() {
  const db = new Map(); const ws = new Set(); let n = 0;
  const docs = (name) => [...db.entries()].filter(([k]) => k.startsWith(`${name}/`)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  return { db, now: () => 'NOW', newId: (h, name) => `${name}_${++n}`,
    watch(h, name, kind, uid, on) { const fn = () => on(docs(name).filter((d) => (kind === 'household' ? (d.audience === 'household' || d.visibility === 'household') : (d.readers || []).includes(uid)))); ws.add(fn); queueMicrotask(fn); return () => ws.delete(fn); },
    read: async (h, name, id) => (db.has(`${name}/${id}`) ? { id, ...db.get(`${name}/${id}`) } : null),
    async commit(h, ops) { for (const o of ops) db.set(`${o.name}/${o.id}`, o.mode === 'set' ? { ...o.data } : { ...db.get(`${o.name}/${o.id}`), ...o.data }); for (const f of ws) f(); } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('V621 store: wallet-only add deducts once; switching Cash ↔ Bank moves it once; older paymentMethod kept when the wallet is unchanged', async () => {
  const repo = fakeRepo(); const s = createFinanceStore({ homeId: 'H', uid: 'u1', repo, homeCurrency: 'EGP' }); s.ensure({ canViewHousehold: true }); s.subscribe(() => {}); await tick();
  const bank = await s.createAccount({ name: 'Bank', role: 'bank', openingDate: '2026-11-01', openingMinor: 100000 }, { memberUids: ['u1'] });
  const cash = await s.createAccount({ name: 'Cash', role: 'cash', openingDate: '2026-11-01', openingMinor: 50000 }, { memberUids: ['u1'] }); await tick();
  const id = await s.addExpense({ amount: '100', category: 'groceries', date: '2026-11-10', walletId: cash, paymentMethod: null, note: 'Bread' }); await tick();
  assert.deepEqual([s.balance(cash), s.balance(bank), repo.db.get(`expenses/${id}`).paymentMethod], [40000, 100000, null]);
  const e = s.getSnapshot().expenses.find((x) => x.id === id);
  await s.editExpense(id, { amount: '100', category: 'groceries', date: '2026-11-10', walletId: bank, paymentMethod: editPaymentMethod(e, bank), note: 'Bread' }, e); await tick();
  assert.deepEqual([s.balance(cash), s.balance(bank)], [50000, 90000], 'moved once, no double deduction');
  // an older record with a Visa label on the bank: editing only the note keeps the label
  const old = await s.addExpense({ amount: '50', category: 'food', date: '2026-11-11', walletId: bank, paymentMethod: 'debit_card', note: 'Lunch' }); await tick();
  const o = s.getSnapshot().expenses.find((x) => x.id === old);
  await s.editExpense(old, { amount: '50', category: 'food', date: '2026-11-11', walletId: bank, paymentMethod: editPaymentMethod(o, bank), note: 'Team lunch' }, o); await tick();
  assert.deepEqual([repo.db.get(`expenses/${old}`).paymentMethod, repo.db.get(`expenses/${old}`).note, s.balance(bank)], ['debit_card', 'Team lunch', 85000]);
  s.dispose && s.dispose();
});
