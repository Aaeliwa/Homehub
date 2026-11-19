/**
 * V6.2 — the daily Finance Overview (V6 homes with Cash / Bank accounts):
 *   search (ALL months) → month navigator → money card (all-time balances + this month's spending)
 *   → one budget bar (collapsed; category limits inside) → Add expense → due bills → history.
 * Every number comes from finance-monthly.js (pure) over the shared Finance store; every write is a
 * confirmed store call (formDialog shows success only after the server confirmed it).
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { formDialog, val } from './dialogs.js';
import { amountInput, field, select, money, catLabel, walletLabel } from './finance-ui.js';
import { parseMinor, minorToPlain } from './money.js';
import { formatDateShort, formatMonth } from './calendar.js';
import { EXPENSE_CATEGORIES } from './finance-model.js';
import { openExpenseDialog, sourcesFor, walletSelect, missingText } from './expense-form.js';
import * as v6 from './finance-v6.js';
import * as M from './finance-monthly.js';

const F = (...a) => field(...a).root;
const fail = (detail) => Object.assign(new Error(detail), { detail });
const minor = (raw, opts) => { const r = parseMinor(raw, opts); if (r.error || r.value === null) throw fail(r.error || 'finance.validation.amountRequired'); return r.value; };
const BUDGET_CATS = EXPENSE_CATEGORIES.filter((c) => c.id !== 'zakat');

/** Shared page-session controls: global search (ALL months) + month navigator / picker. */
function controls(env) {
  const { today, locale, ui } = env; const ym = ui.ym;
  const setUi = (patch) => { if (['q', 'ym', 'cal', 'cat', 'wallet'].some((k) => k in patch)) patch.limit = PAGE; Object.assign(ui, patch); env.rerender(); };
  const search = h('div', { class: 'fm-search' },
    h('input', { id: 'fm-search', class: 'input', type: 'search', value: ui.q, placeholder: t('finance.v62.searchPh'), 'aria-label': t('finance.v62.search'), dir: 'auto',
      onInput: (e) => setUi({ q: e.target.value }) }));
  const picker = ui.picker ? h('div', { class: 'fm-picker', id: 'fm-picker', role: 'dialog', 'aria-label': t('finance.v62.pickMonth') },
    select('fm-pick-month', Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1).padStart(2, '0'), label: formatMonth(`2026-${String(i + 1).padStart(2, '0')}`, locale).replace(/\s*\d{4}\s*/, '') })), ym.slice(5)),
    h('input', { id: 'fm-pick-year', class: 'input', type: 'number', min: 2000, max: 2100, value: ym.slice(0, 4), 'aria-label': t('finance.v62.year') }),
    h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'fm-pick-go', onClick: (e) => { const box = e.currentTarget.parentElement;
      const y = Number(box.querySelector('#fm-pick-year').value); if (!Number.isInteger(y) || y < 2000 || y > 2100) return;
      setUi({ ym: `${y}-${box.querySelector('#fm-pick-month').value}`, picker: false }); } }, t('finance.v62.go'))) : null;
  const nav = h('div', { class: 'fm-nav', role: 'group', 'aria-label': t('finance.v62.month') },
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'fm-prev', 'aria-label': t('finance.v62.prevMonth'), onClick: () => setUi({ ym: M.shiftYm(ym, -1) }) }, document.dir === 'rtl' ? '›' : '‹'),
    h('button', { type: 'button', class: 'fm-nav__label', id: 'fm-month', 'aria-expanded': String(!!ui.picker), onClick: () => setUi({ picker: !ui.picker }) }, formatMonth(ym, locale)),
    h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'fm-next', 'aria-label': t('finance.v62.nextMonth'), onClick: () => setUi({ ym: M.shiftYm(ym, 1) }) }, document.dir === 'rtl' ? '‹' : '›'),
    ym !== today.slice(0, 7) ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'fm-this-month', onClick: () => setUi({ ym: today.slice(0, 7) }) }, t('finance.v62.thisMonth')) : null);
  return { search, nav, picker, setUi };
}
const PAGE = 50;
const hhAccounts = (snap) => snap.wallets.filter((w) => w.active === true && w.role && w.visibility === 'household');

/** V6.2.1 History tab: the SAME controls and table as the Overview (one renderer), for the current scope. */
export function renderHistoryTab(env) {
  const { search, nav, picker, setUi } = controls(env);
  return h('div', { id: 'fm', class: 'fm' }, search, nav, picker, historyCard(env, { setUi, filters: true }));
}

export function renderMonthlyTab(env) {
  const { store, today, locale, home, can, ctx, ui, budgetAdmin } = env;
  const snap = store.getSnapshot(); const cur = home.currency; const fmt = (m) => money(m, cur);
  const container = ctx.financeRoot;
  const accounts = hhAccounts(snap);
  const bank = accounts.find((w) => w.role === 'bank'); const cash = accounts.find((w) => w.role === 'cash');
  const ym = ui.ym;
  const { search, nav, picker, setUi } = controls(env);
  const src = sourcesFor(store, ctx, 'home');

  // ---- 3. money card: all-time balances + this month's spending
  const bal = (w) => (w ? store.balance(w.id) : 0);
  const stats = M.monthStats(snap, accounts, ym);
  const moneyCard = h('section', { class: 'card fin-card fm-money', id: 'fm-money' },
    h('p', { class: 'fm-label' }, t('finance.v62.available')),
    h('p', { class: 'fm-big', id: 'fm-available', dir: 'ltr' }, fmt(v6.spendable(accounts, snap))),
    h('div', { class: 'fm-row' },
      h('span', null, `💵 ${t('finance.v62.cash')} `, h('b', { id: 'fm-cash', dir: 'ltr' }, fmt(bal(cash)))),
      h('span', null, `🏦 ${t('finance.v62.bank')} `, h('b', { id: 'fm-bank', dir: 'ltr' }, fmt(bal(bank))))),
    h('p', { class: 'fm-label' }, t('finance.v62.spentIn', { month: formatMonth(ym, locale) })),
    h('div', { class: 'fm-row' },
      h('span', null, `${t('finance.v62.cash')} `, h('b', { id: 'fm-spent-cash', dir: 'ltr' }, fmt(stats.cashMinor))),
      h('span', null, `${t('finance.v62.bank')} `, h('b', { id: 'fm-spent-bank', dir: 'ltr' }, fmt(stats.bankMinor))),
      h('span', null, `${t('finance.v62.total')} `, h('b', { id: 'fm-spent-total', dir: 'ltr' }, fmt(stats.totalMinor)))),
    h('p', { class: 'field__hint' }, t('finance.v62.balanceNote')),
    h('div', { class: 'cl-item__actions' },
      can('expenses.create') ? h('button', { type: 'button', class: 'btn btn--primary', id: 'fm-add', onClick: addExpense }, `＋ ${t('finance.v62.addExpense')}`) : null,
      can('expenses.transfer') ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'fm-add-money', onClick: addMoney }, t('finance.v62.addMoney')) : null,
      can('expenses.transfer') && bank && cash ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'fm-transfer', onClick: transfer }, t('finance.v62.transfer')) : null));

  // ---- 4. one budget bar (collapsed) with category limits inside
  const setting = M.effectiveMonthly(snap.monthly || [], ym);
  const prog = M.progress(stats.totalMinor, setting.budgetMinor);
  const cats = M.categoryProgress(stats, setting.categoryLimits);
  const bar = (p, id) => h('div', { class: `fm-bar${p.over ? ' fm-bar--over' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.min(100, Math.max(0, p.pct)), id },
    h('span', { style: `inline-size:${Math.min(100, Math.max(0, p.pct))}%` }));
  const pastMonth = ym < today.slice(0, 7);
  const budgetCard = h('section', { class: 'card fin-card', id: 'fm-budget' },
    prog ? h('button', { type: 'button', class: 'fm-budget__head', id: 'fm-budget-toggle', 'aria-expanded': String(!!ui.budgetOpen), 'aria-controls': 'fm-cats', onClick: () => setUi({ budgetOpen: !ui.budgetOpen }) },
      h('span', { class: 'fm-label' }, `${ui.budgetOpen ? '▾' : '▸'} ${t('finance.v62.budget')}`),
      h('span', { id: 'fm-budget-text', dir: 'ltr' }, `${fmt(prog.spentMinor)} / ${fmt(prog.budgetMinor)} · ${prog.pct}%`),
      bar(prog, 'fm-budget-bar'),
      prog.over ? h('span', { class: 'fin-warn', role: 'alert', id: 'fm-over' }, t('finance.v62.over', { amount: fmt(-prog.remainingMinor) })) : null)
      : h('p', { class: 'fm-label', id: 'fm-no-budget' }, t('finance.v62.noBudget', { amount: fmt(stats.totalMinor) })),
    prog && ui.budgetOpen && cats.length ? h('ul', { class: 'fin-list', id: 'fm-cats' }, cats.map((c) => h('li', { class: 'fm-cat', dataset: { cat: c.cat } },
      h('span', null, catLabel(c.cat)), h('span', { dir: 'ltr' }, `${fmt(c.spentMinor)} / ${fmt(c.budgetMinor)}`), bar(c, null),
      c.over ? h('span', { class: 'fin-warn' }, t('finance.v62.over', { amount: fmt(-c.remainingMinor) })) : null))) : null,
    setting.inherited ? h('p', { class: 'field__hint' }, t('finance.v62.inherited', { month: formatMonth(setting.inheritedFrom, locale) })) : null,
    budgetAdmin && !pastMonth ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'fm-budget-edit', onClick: editBudget }, t(prog ? 'finance.v62.editBudget' : 'finance.v62.setBudget')) : null);

  // ---- 5. bills: due / overdue now, upcoming collapsed
  const b = M.bills(snap.commitments.filter((c) => (c.audience ?? 'household') === 'household'), today, ym);
  const billRow = (c, due) => h('li', { class: 'fin-row', dataset: { bill: c.id } },
    h('span', { class: 'fin-row__main', dir: 'auto' }, c.name, h('span', { class: 'fin-row__sub' }, `${formatDateShort(c.nextDueDate, locale)}${due && c.nextDueDate < today ? ` · ${t('finance.v62.overdue')}` : ''}`)),
    h('span', { class: 'fin-row__amount', dir: 'ltr' }, fmt(c.amountMinor)),
    due && can('expenses.create') ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-action': 'pay', onClick: () => payBill(c) }, t('finance.v62.markPaid')) : null);
  const billsCard = b.due.length || b.upcoming.length ? h('section', { class: 'card fin-card', id: 'fm-bills' },
    b.due.length ? h('div', null, h('h2', { class: 'card__title' }, t('finance.v62.billsDue')), h('ul', { class: 'fin-list', id: 'fm-bills-due' }, b.due.map((c) => billRow(c, true)))) : null,
    b.upcoming.length ? h('details', { class: 'form-section', id: 'fm-bills-upcoming' }, h('summary', { class: 'form-section__summary' }, t('finance.v62.billsUpcoming', { n: b.upcoming.length })),
      h('ul', { class: 'fin-list' }, b.upcoming.map((c) => billRow(c, false)))) : null) : null;

  const history = historyCard(env, { setUi, filters: false });
  return h('div', { id: 'fm', class: 'fm' }, search, nav, picker, moneyCard, budgetCard, billsCard, history);

  // ---------------------------------------------------------------- dialogs
  function addExpense() {
    formDialog({ title: t('finance.v62.addExpense'), id: 'fm-exp-form', submitLabel: t('common.save'), container,
      fields: [F(t('finance.v62.name'), h('input', { id: 'fm-ex-name', class: 'input', maxlength: 200, dir: 'auto', required: true }), { id: 'fm-ex-name' }),
        F(t('finance.field.amount'), amountInput('fm-ex-amount'), { id: 'fm-ex-amount' }),
        F(t('finance.field.category'), select('fm-ex-cat', BUDGET_CATS.map((c) => ({ value: c.id, label: `${c.icon} ${catLabel(c.id)}` })), 'groceries'), { id: 'fm-ex-cat' }),
        F(t('finance.field.wallet'), walletSelect('fm-ex-wallet', src, (src.options[0] || {}).id), { id: 'fm-ex-wallet', hint: src.missing.length ? missingText(src) : '' }),
        F(t('finance.field.date'), h('input', { id: 'fm-ex-date', type: 'date', class: 'input', value: today, max: today }), { id: 'fm-ex-date', hint: t('finance.v62.dateHint') })],
      onSubmit: async () => {
        const r = document.getElementById('fm-exp-form'); const name = val(r, '#fm-ex-name').trim();
        if (!name) throw fail('finance.v62.nameRequired');
        minor(val(r, '#fm-ex-amount'));   // positive, minor-unit precision (store re-validates)
        const walletId = val(r, '#fm-ex-wallet'); if (!src.options.some((o) => o.id === walletId)) throw fail('finance.v621.setupWallets');
        await store.addExpense({ amount: val(r, '#fm-ex-amount'), category: val(r, '#fm-ex-cat'), date: val(r, '#fm-ex-date'), paymentMethod: null, walletId, note: name });
        return 'finance.v6.toast.expense';
      } });
  }
  function addMoney() {
    formDialog({ title: t('finance.v62.addMoney'), id: 'fm-money-form', submitLabel: t('common.save'), container,
      fields: [h('p', { class: 'field__hint' }, t('finance.v62.addMoneyHint')),
        F(t('finance.field.amount'), amountInput('fm-mo-amount'), { id: 'fm-mo-amount' }),
        F(t('finance.v6.into'), select('fm-mo-acct', accounts.map((w) => ({ value: w.id, label: w.name })), (bank || cash).id), { id: 'fm-mo-acct' }),
        F(t('finance.v6.source'), h('input', { id: 'fm-mo-src', class: 'input', maxlength: 60, dir: 'auto' }), { id: 'fm-mo-src' }),
        F(t('finance.field.date'), h('input', { id: 'fm-mo-date', type: 'date', class: 'input', value: today, max: today }), { id: 'fm-mo-date' })],
      onSubmit: async () => { const r = document.getElementById('fm-money-form');
        await store.addIncome({ walletId: val(r, '#fm-mo-acct'), amountMinor: minor(val(r, '#fm-mo-amount')), date: val(r, '#fm-mo-date'), today, source: val(r, '#fm-mo-src') });
        return 'finance.v6.toast.income'; } });
  }
  function transfer() {
    formDialog({ title: t('finance.v6.transfer'), id: 'fm-tr-form', submitLabel: t('common.save'), container,
      fields: [h('p', { class: 'field__hint' }, t('finance.v6.transferHint')),
        F(t('finance.v6.transferKind'), select('fm-tr-kind', [{ value: 'atm', label: t('finance.v6.atm') }, { value: 'deposit', label: t('finance.v6.deposit') }], 'atm'), { id: 'fm-tr-kind' }),
        F(t('finance.field.amount'), amountInput('fm-tr-amount'), { id: 'fm-tr-amount' }),
        F(t('finance.field.date'), h('input', { id: 'fm-tr-date', type: 'date', class: 'input', value: today }), { id: 'fm-tr-date' })],
      onSubmit: async () => { const r = document.getElementById('fm-tr-form'); const atm = val(r, '#fm-tr-kind') === 'atm';
        await store.transferBetween({ fromId: atm ? bank.id : cash.id, toId: atm ? cash.id : bank.id, amountMinor: minor(val(r, '#fm-tr-amount')), date: val(r, '#fm-tr-date'), note: t(atm ? 'finance.v6.atm' : 'finance.v6.deposit') });
        return 'finance.v6.toast.transfer'; } });
  }
  function editBudget() {
    const lim = setting.categoryLimits || {};
    formDialog({ title: t('finance.v62.budgetFor', { month: formatMonth(ym, locale) }), id: 'fm-budget-form', submitLabel: t('common.save'), container,
      fields: [h('p', { class: 'field__hint' }, t('finance.v62.budgetHint')),
        F(t('finance.v62.monthlyBudget'), amountInput('fm-bu-total', setting.budgetMinor != null ? minorToPlain(setting.budgetMinor) : ''), { id: 'fm-bu-total', hint: t('finance.v62.budgetEmpty') }),
        h('details', { class: 'form-section', open: Object.keys(lim).length > 0 }, h('summary', { class: 'form-section__summary' }, t('finance.v62.catLimits')),
          h('p', { class: 'field__hint' }, t('finance.v62.catLimitsHint')),
          h('div', { class: 'fm-limits' }, BUDGET_CATS.map((c) => F(`${c.icon} ${catLabel(c.id)}`, amountInput(`fm-lim-${c.id}`, lim[c.id] ? minorToPlain(lim[c.id]) : ''), { id: `fm-lim-${c.id}` }))))],
      onSubmit: async () => {
        const r = document.getElementById('fm-budget-form'); const raw = val(r, '#fm-bu-total').trim();
        const limits = {}; for (const c of BUDGET_CATS) { const v = val(r, `#fm-lim-${c.id}`).trim(); if (v) limits[c.id] = minor(v, { allowZero: true }); }
        await store.setMonthly(ym, { budgetMinor: raw ? minor(raw) : null, categoryLimits: limits });
        return 'finance.v62.toast.budget';
      } });
  }
  function payBill(c) {
    formDialog({ title: t('finance.v62.payTitle', { name: c.name }), id: 'fm-pay-form', submitLabel: t('finance.v62.markPaid'), container,
      fields: [h('p', { class: 'field__hint' }, t('finance.v62.payHint', { amount: fmt(c.amountMinor), date: formatDateShort(c.nextDueDate, locale) })),
        F(t('finance.field.wallet'), walletSelect('fm-pay-wallet', src, (bank || cash).id), { id: 'fm-pay-wallet' }),
        F(t('finance.field.date'), h('input', { id: 'fm-pay-date', type: 'date', class: 'input', value: today, max: today }), { id: 'fm-pay-date' })],
      onSubmit: async () => { const r = document.getElementById('fm-pay-form'); const walletId = val(r, '#fm-pay-wallet');
        if (!src.options.some((o) => o.id === walletId)) throw fail('finance.v621.setupWallets');
        await store.payCommitment(c.id, { date: val(r, '#fm-pay-date'), walletId, paymentMethod: '' });   // '' = no method label (the wallet is the source)
        return 'finance.v62.toast.paid'; } });
  }
}

/**
 * ONE transaction renderer (Overview + History): search spans ALL months; else the selected month; a
 * work / vacation interval defines its own range. Columns: date · name · category · wallet · signed
 * amount · actions (edit, delete = void with a reason). Paged ("Show more"); mobile scrolls sideways.
 */
function historyCard(env, { setUi, filters }) {
  const { store, today, locale, home, ctx, ui, canEdit, cal } = env;
  const snap = store.getSnapshot(); const fmt = (m) => money(m, home.currency); const ym = ui.ym;
  const accounts = hhAccounts(snap);
  const work = cal ? cal.intervals('work') : []; const vacs = cal ? cal.intervals('vacation') : [];
  let calFilter = null; let calLabel = '';
  if (ui.cal === 'work' && work.length) { calFilter = { mode: 'work', ivs: work }; calLabel = t('finance.v62.calWork'); }
  else if (ui.cal === 'vacation' && vacs.length) { calFilter = { mode: 'vacation', ivs: vacs }; calLabel = t('finance.v62.calVacAll'); }
  else if (String(ui.cal).startsWith('vac:')) { const v = vacs.find((x) => `vac:${x.id}` === ui.cal); if (v) { calFilter = { mode: 'vacation', ivs: [v] }; calLabel = `${v.title} (${formatDateShort(v.start, locale)} – ${formatDateShort(v.end, locale)})`; } }
  const base = env.scope === 'home' ? snap.expenses.filter((e) => (e.audience ?? 'household') === 'household') : env.inScope(snap.expenses);
  const res = M.historyRows(base, { q: ui.q, ym, cal: calFilter, catLabel });
  const rows = filters ? M.narrow(res.rows, { category: ui.cat, walletId: ui.wallet }) : res.rows; const scope = res.scope;
  const limit = ui.limit || PAGE; const shown = rows.slice(0, limit);
  const roleOf = (id) => (accounts.find((w) => w.id === id) || {}).role;
  const walletText = (e) => (roleOf(e.walletId) === 'cash' ? `💵 ${t('finance.v62.cash')}` : roleOf(e.walletId) === 'bank' ? `🏦 ${t('finance.v62.bank')}` : walletLabel(e.walletId, store, e));
  const chips = [scope === 'all' ? h('span', { class: 'pill', id: 'fm-chip-all' }, `🔎 ${t('finance.v62.allMonths')}: “${ui.q.trim()}”`) : scope === 'month' ? h('span', { class: 'pill' }, formatMonth(ym, locale)) : null,
    calFilter ? h('span', { class: 'pill', id: 'fm-chip-cal' }, calLabel) : null,
    scope === 'all' || calFilter ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'fm-clear', onClick: () => setUi({ q: '', cal: 'all' }) }, t('finance.v62.clearFilters')) : null].filter(Boolean);
  let vacSummary = null;
  if (calFilter) {
    const sel = M.selectSpending(snap, (d) => calFilter.ivs.some((i) => i.start <= d && d <= i.end));
    const s = M.summarize(sel.exp, sel.refunds, accounts);
    const top = Object.entries(s.byCategory).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).slice(0, 5);
    vacSummary = h('div', { class: 'fm-vac', id: 'fm-vac-summary' },
      h('p', { class: 'fm-label' }, t(calFilter.mode === 'work' ? 'finance.v62.sumWork' : 'finance.v62.sumVac')),
      h('div', { class: 'fm-row' },
        h('span', null, `${t('finance.v62.total')} `, h('b', { id: 'fm-vac-total', dir: 'ltr' }, fmt(s.totalMinor))),
        h('span', null, `${t('finance.v62.cash')} `, h('b', { id: 'fm-vac-cash', dir: 'ltr' }, fmt(s.cashMinor))),
        h('span', null, `${t('finance.v62.bank')} `, h('b', { id: 'fm-vac-bank', dir: 'ltr' }, fmt(s.bankMinor)))),
      top.length ? h('p', { class: 'fin-row__sub' }, top.map(([c, v]) => `${catLabel(c)} ${fmt(v)}`).join(' · ')) : null,
      h('p', { class: 'field__hint' }, t('finance.v62.dateBasis')));
  }
  const pick = (id, label, opts, value, key) => { const el = select(id, opts, value); el.classList.add('input--sm'); el.addEventListener('change', (e) => setUi({ [key]: e.target.value }));
    return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), el); };
  const walletOpts = [{ value: 'all', label: t('finance.filter.allWallets') }, ...snap.wallets.filter((w) => base.some((e) => e.walletId === w.id)).map((w) => ({ value: w.id, label: walletText({ walletId: w.id }) }))];
  const card = h('section', { class: 'card fin-card', id: 'fm-history' },
    h('h2', { class: 'card__title' }, t('finance.v62.history')),
    h('div', { class: 'fm-filters' },
      cal ? pick('fm-cal', t('finance.v62.calFilter'), [{ value: 'all', label: t('finance.v62.calAll') }, ...(work.length ? [{ value: 'work', label: t('finance.v62.calWork') }] : []),
        ...(vacs.length ? [{ value: 'vacation', label: t('finance.v62.calVacAll') }] : []),
        ...vacs.map((v) => ({ value: `vac:${v.id}`, label: `🌴 ${v.title} · ${formatDateShort(v.start, locale)} – ${formatDateShort(v.end, locale)}` }))], calFilter ? ui.cal : 'all', 'cal') : null,
      filters ? pick('fm-f-cat', t('finance.field.category'), [{ value: 'all', label: t('finance.filter.allCategories') }, ...EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: catLabel(c.id) }))], ui.cat || 'all', 'cat') : null,
      filters ? pick('fm-f-wallet', t('finance.field.wallet'), walletOpts, ui.wallet || 'all', 'wallet') : null,
      h('div', { class: 'fm-chips', 'aria-live': 'polite' }, ...chips)),
    vacSummary,
    shown.length ? h('div', { class: 'fm-scroll' }, h('div', { class: 'fm-table', role: 'table', id: 'fm-rows', 'aria-label': t('finance.v62.history'), 'aria-rowcount': String(rows.length + 1) },
      h('div', { class: 'fm-tr fm-th', role: 'row' }, ...['date', 'name', 'category', 'wallet', 'amount'].map((k) => h('span', { role: 'columnheader' }, t(k === 'wallet' ? 'finance.field.wallet' : `finance.v62.col.${k}`))), h('span', { role: 'columnheader', 'aria-label': t('finance.v621.actions') })),
      ...shown.map((e) => h('div', { class: 'fm-tr', role: 'row', dataset: { expense: e.id } },
        h('span', { role: 'cell', class: 'fm-td-date' }, formatDateShort(e.date, locale)),
        h('span', { role: 'cell', class: 'fm-td-name', dir: 'auto' }, M.nameOf(e) || catLabel(e.category), env.attribution ? h('span', { class: 'fin-row__sub' }, env.attribution(e)) : null),
        h('span', { role: 'cell' }, catLabel(e.category)),
        h('span', { role: 'cell', class: 'fm-td-wallet' }, walletText(e)),
        h('span', { role: 'cell', class: 'fm-td-amount', dir: 'ltr' }, `−${fmt(e.amountMinor)}`),
        h('span', { role: 'cell', class: 'cl-item__actions' },
          canEdit(e) && !e.id.startsWith('zk_') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'edit', 'aria-label': t('finance.v62.editX', { name: M.nameOf(e) }), onClick: () => openExpenseDialog({ store, ctx, today, expense: e }) }, '✎') : null,
          canEdit(e) && !e.id.startsWith('zk_') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'delete', 'aria-label': t('finance.v62.deleteX', { name: M.nameOf(e) }), onClick: () => voidDialog(env, e) }, '🗑') : null)))))
      : h('p', { class: 'empty', id: 'fm-empty' }, t(scope === 'all' ? 'finance.v62.noResults' : 'finance.v62.noneThisMonth')),
    rows.length > shown.length ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'fm-more', onClick: () => setUi({ limit: limit + PAGE }) }, t('finance.v621.showMore', { shown: shown.length, total: rows.length })) : null);
  return card;
}

/** Delete = VOID with a reason (the record stays; balances recompute once). */
function voidDialog(env, e) {
  const fmt = (m) => money(m, env.home.currency);
  formDialog({ title: t('finance.v62.deleteTitle'), id: 'fm-del-form', submitLabel: t('finance.v62.delete'), container: env.ctx.financeRoot,
    fields: [h('p', { class: 'field__hint' }, t('finance.v62.deleteHint', { name: M.nameOf(e) || catLabel(e.category), amount: fmt(e.amountMinor) })),
      F(t('finance.v6.reason'), h('input', { id: 'fm-del-reason', class: 'input', maxlength: 200, dir: 'auto' }), { id: 'fm-del-reason' })],
    onSubmit: async () => { const reason = val(document.getElementById('fm-del-form'), '#fm-del-reason').trim();
      if (!reason) throw fail('finance.v6.reasonRequired');
      await env.store.voidExpense(e.id, reason); return 'finance.v62.toast.deleted'; } });
}
