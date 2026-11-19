/** Maintenance dashboard widget (Phase 5.5): the shared summary-card (same component as the others). */
import { h } from '../../core/utils/dom.js';
import { t, formatNumber } from '../../core/i18n/i18n.js';
import { todayIn } from '../expenses/calendar.js';
import { getMaintenanceStore } from './maintenance-service.js';
import { planStatus } from './maintenance-model.js';

export function mount(slot, ctx) {
  const state = ctx.getState();
  let store;
  try { store = getMaintenanceStore(ctx); } catch { slot.remove(); return () => {}; }
  const value = h('span', { class: 'summary-card__value' }, '…');
  const label = h('span', { class: 'summary-card__label' }, t('common.loading'));
  const extra = h('span', { class: 'summary-card__extra', id: 'mt-widget-extra' });
  slot.replaceChildren(h('a', { class: 'summary-card accent-violet', href: '#/m/maintenance', id: 'mt-widget' },
    h('span', { class: 'summary-card__icon', 'aria-hidden': 'true' }, '🔧'),
    h('span', { class: 'summary-card__body' }, h('span', { class: 'summary-card__title' }, t('module.maintenance.name')), h('span', { class: 'summary-card__figure' }, value, label), extra)));
  return store.subscribe((snap) => {
    if (snap.status === 'error') { value.textContent = '—'; label.textContent = t('maintenance.loadError'); extra.textContent = ''; return; }
    if (snap.status !== 'ready') return;
    const today = todayIn(state.home.timezone);
    const st = snap.plans.map((p) => planStatus(p, today));
    const due = st.filter((s) => s === 'overdue' || s === 'dueToday').length;
    const open = snap.faults.filter((f) => ['open', 'inProgress', 'resolved'].includes(f.status)).length;
    value.textContent = formatNumber(due); label.textContent = t('maintenance.widget.due');
    extra.textContent = [st.includes('overdue') ? t('maintenance.widget.overdue', { n: st.filter((s) => s === 'overdue').length }) : '', open ? t('maintenance.widget.openFaults', { n: open }) : ''].filter(Boolean).join(' · ');
  });
}
