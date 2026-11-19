/** Reminders dashboard card (Phase 5.6): the shared summary-card; counts are in-app, derived, live. */
import { h } from '../../core/utils/dom.js';
import { t, formatNumber } from '../../core/i18n/i18n.js';
import { createRemindersFeed } from '../../core/reminders/reminders-service.js';

export function mount(slot, ctx) {
  const value = h('span', { class: 'summary-card__value' }, '…');
  const label = h('span', { class: 'summary-card__label' }, t('common.loading'));
  const extra = h('span', { class: 'summary-card__extra', id: 'rm-widget-extra' });
  slot.replaceChildren(h('a', { class: 'summary-card accent-amber', href: '#/reminders', id: 'rm-widget' },
    h('span', { class: 'summary-card__icon', 'aria-hidden': 'true' }, '🔔'),
    h('span', { class: 'summary-card__body' }, h('span', { class: 'summary-card__title' }, t('reminders.title')), h('span', { class: 'summary-card__figure' }, value, label), extra)));
  let feed;
  try {
    feed = createRemindersFeed(ctx, (d) => {
      if (!d) return;
      if (d.status === 'error') { value.textContent = '—'; label.textContent = t('reminders.loadError'); extra.textContent = ''; return; }
      if (d.status !== 'ready') return;
      value.textContent = formatNumber(d.counts.actionable); label.textContent = t('reminders.needAttention');
      const faults = d.items.filter((r) => r.bucket === 'openFault' && (r.presentation === 'unread' || r.presentation === 'read')).length;
      extra.textContent = [d.counts.overdue ? t('reminders.widgetOverdue', { n: d.counts.overdue }) : '', faults ? t('reminders.widgetFaults', { n: faults }) : ''].filter(Boolean).join(' · ');
    });
  } catch { slot.remove(); return () => {}; }
  return () => feed.dispose();
}
