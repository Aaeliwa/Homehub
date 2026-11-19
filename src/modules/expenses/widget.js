/**
 * Finance dashboard widget. Consumes only store.summary() (no record internals) from the
 * shared scope-bound store. Amounts appear only with expenses.viewFinancialTotals; otherwise
 * the card shows non-financial status (an active budget exists / next commitment date).
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { getFinanceStore } from './finance-service.js';
import { todayIn, formatDateShort } from './calendar.js';
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
    const c = s.activeCycles[0];
    lines.replaceChildren(
      h('span', { class: 'summary-card__title' }, t('module.expenses.name')),
      totals ? h('span', { class: 'summary-card__figure' }, h('span', { class: 'summary-card__value', id: 'fin-widget-month' }, money(s.monthTotalMinor, s.currency)), h('span', { class: 'summary-card__label' }, t('finance.widget.thisMonth'))) : '',
      s.v6 ? h('span', { class: 'summary-card__extra', id: 'fin-widget-v6' }, totals ? t('finance.v6.widget', { remaining: money(s.v6.remainingMinor, s.currency) }) : t('finance.v6.widgetActive'))
      : c ? h('span', { class: 'summary-card__extra', id: 'fin-widget-cycle' }, totals ? t('finance.widget.cycle', { remaining: money(c.remainingMinor, c.currency), perDay: money(c.safePerDayMinor, c.currency) }) : t('finance.widget.cycleActive', { days: c.daysRemaining }))
        : h('span', { class: 'summary-card__extra' }, t('finance.widget.noCycle')),
      s.nextCommitment ? h('span', { class: 'summary-card__extra' }, t('finance.widget.next', { name: s.nextCommitment.name, date: formatDateShort(s.nextCommitment.nextDueDate, getLocale()) })) : '');
  });
}
