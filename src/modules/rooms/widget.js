/**
 * Rooms dashboard widget. Consumes ONLY the module's summary contract
 * ({ activeCount, archivedCount }) from the shared, scope-bound store — no extra reads.
 */
import { h } from '../../core/utils/dom.js';
import { t, tp, formatNumber } from '../../core/i18n/i18n.js';
import { getRoomsStore } from './rooms-service.js';

export function mount(slot, ctx) {
  let store;
  try { store = getRoomsStore(ctx); } catch { slot.remove(); return () => {}; }

  const value = h('span', { class: 'summary-card__value' }, '…');
  const label = h('span', { class: 'summary-card__label' }, t('common.loading'));
  const extra = h('span', { class: 'summary-card__extra' });
  slot.replaceChildren(h('a', { class: 'summary-card accent-indigo', href: '#/m/rooms' },
    h('span', { class: 'summary-card__icon', 'aria-hidden': 'true' }, '🚪'),
    h('span', { class: 'summary-card__body' },
      h('span', { class: 'summary-card__title' }, t('module.rooms.name')),
      h('span', { class: 'summary-card__figure' }, value, label),
      extra)));

  return store.subscribe((snap) => {
    if (snap.status === 'error') { value.textContent = '—'; label.textContent = t('rooms.widget.unavailable'); extra.textContent = ''; return; }
    if (snap.status !== 'ready') return;
    const { activeCount, archivedCount } = store.summary();
    if (activeCount === 0) {
      value.textContent = '';
      label.textContent = t('rooms.widget.none');
    } else {
      value.textContent = formatNumber(activeCount);
      label.textContent = tp('rooms.widget.activeLabel', activeCount);
    }
    extra.textContent = archivedCount ? tp('rooms.widget.archived', archivedCount) : '';
  });
}
