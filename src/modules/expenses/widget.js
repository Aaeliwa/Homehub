/**
 * Finance dashboard widget. Consumes only store.summary() (no record internals) from the
 * shared scope-bound store. V6.4: primary value = remaining CURRENT MONTHLY budget (+ usage bar / %).
 * Amounts and percentages appear only with expenses.viewFinancialTotals; otherwise the card shows
 * non-financial status (a monthly budget is set or not / next commitment date).
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale, formatNumber } from '../../core/i18n/i18n.js';
import { getFinanceStore } from './finance-service.js';
import { todayIn, formatDateShort, formatMonth } from './calendar.js';
import { money } from './finance-ui.js';

export function mount(slot, ctx) {
  // The Dashboard card is a HOUSEHOLD summary: shown only with expenses.view. Members who only
  // have personal wallets (children) use the Finance page for their own allowance.
  if (!ctx.getState().permissions.can('expenses.view')) { slot.remove(); return () => {}; }
  let store;
  try { store = getFinanceStore(ctx); } catch { slot.remove(); return () => {}; }
  const { permissions, home } = ctx.getState();
  const totals = permissions.can('expenses.viewFinancialTotals');
  const lines = h('span', { class: 'summary-card__body' });
  slot.replaceChildren(h('a', { class: 'summary-card summary-card--finance accent-emerald', href: '#/m/expenses' },
    h('span', { class: 'summary-card__icon', 'aria-hidden': 'true' }, '💰'), lines));
  return store.subscribe((snap) => {
    const today = todayIn(home.timezone);
    if (snap.status === 'error') { lines.replaceChildren(h('span', { class: 'summary-card__title' }, t('module.expenses.name')), h('span', { class: 'summary-card__label' }, t('finance.widget.unavailable'))); return; }
    if (snap.status !== 'ready') return;
    const s = store.summary(today);
    // V6.4: the tile shows the CURRENT MONTHLY budget (Monthly tab selectors). No 10-day / period budget.
    const mb = s.monthBudget;
    const month = formatMonth(mb.ym, getLocale());
    const out = [h('span', { class: 'summary-card__title' }, t('finance.widget.monthTitle', { month }))];
    if (!totals) {
      out.push(h('span', { class: 'summary-card__extra', id: 'fin-widget-status' }, t(mb.hasBudget ? 'finance.widget.budgetSet' : 'finance.widget.noBudget')));
    } else if (mb.hasBudget) {
      const neg = mb.remainingMinor < 0;
      out.push(
        h('span', { class: 'summary-card__figure' },
          h('span', { class: ['summary-card__value', neg && 'is-negative'], id: 'fin-widget-remaining', dir: 'ltr' }, money(mb.remainingMinor, s.currency)),
          h('span', { class: 'summary-card__label' }, t(neg ? 'finance.widget.overBy' : 'finance.widget.remaining'))),
        h('span', { class: ['fin-budget-bar', mb.over && 'is-over'], role: 'progressbar', id: 'fin-widget-bar',
          'aria-label': t('finance.widget.used'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(mb.fillPct),
          'aria-valuetext': mb.pct === null ? t('finance.widget.zeroBudget') : t(mb.over ? 'finance.widget.pctOver' : 'finance.widget.pct', { pct: formatNumber(mb.pct) }) },
          h('span', { class: 'fin-budget-bar__fill', style: `inline-size:${mb.fillPct}%` })),
        h('span', { class: ['summary-card__extra', 'fin-budget-pct', mb.over && 'is-over'], id: 'fin-widget-pct' },
          mb.pct === null ? t('finance.widget.zeroBudget') : t(mb.over ? 'finance.widget.pctOver' : 'finance.widget.pct', { pct: formatNumber(mb.pct) })),
        h('span', { class: 'summary-card__extra', id: 'fin-widget-spent' }, t('finance.widget.spentOf', { spent: money(mb.spentMinor, s.currency), budget: money(mb.budgetMinor, s.currency) })));
    } else {
      out.push(
        h('span', { class: 'summary-card__figure' }, h('span', { class: 'summary-card__value', id: 'fin-widget-month', dir: 'ltr' }, money(mb.spentMinor, s.currency)), h('span', { class: 'summary-card__label' }, t('finance.widget.spentLabel'))),
        h('span', { class: 'summary-card__extra', id: 'fin-widget-status' }, t('finance.widget.noBudget')));
    }
    if (s.nextCommitment) out.push(h('span', { class: 'summary-card__extra' }, t('finance.widget.next', { name: s.nextCommitment.name, date: formatDateShort(s.nextCommitment.nextDueDate, getLocale()) })));
    lines.replaceChildren(...out);
  });
}
