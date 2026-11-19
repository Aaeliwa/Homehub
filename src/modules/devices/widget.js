/**
 * Devices dashboard widget. Consumes ONLY the summary contract
 * { activeCount, needsAttentionCount, outOfServiceCount, archivedCount } from the shared store.
 */
import { h } from '../../core/utils/dom.js';
import { t, tp, formatNumber } from '../../core/i18n/i18n.js';
import { getDevicesStore } from './devices-service.js';

export function mount(slot, ctx) {
  let store;
  try { store = getDevicesStore(ctx); } catch { slot.remove(); return () => {}; }
  const value = h('span', { class: 'summary-card__value' }, '…');
  const label = h('span', { class: 'summary-card__label' }, t('common.loading'));
  const attention = h('span', { class: 'summary-card__extra summary-card__extra--attention' });
  const extra = h('span', { class: 'summary-card__extra' });
  slot.replaceChildren(h('a', { class: 'summary-card accent-cyan', href: '#/m/devices' },
    h('span', { class: 'summary-card__icon', 'aria-hidden': 'true' }, '🔌'),
    h('span', { class: 'summary-card__body' },
      h('span', { class: 'summary-card__title' }, t('module.devices.name')),
      h('span', { class: 'summary-card__figure' }, value, label), attention, extra)));

  return store.subscribe((snap) => {
    if (snap.status === 'error') { value.textContent = '—'; label.textContent = t('devices.widget.unavailable'); attention.textContent = ''; extra.textContent = ''; return; }
    if (snap.status !== 'ready') return;
    const s = store.summary();
    if (s.activeCount === 0) { value.textContent = ''; label.textContent = t('devices.widget.none'); }
    else { value.textContent = formatNumber(s.activeCount); label.textContent = tp('devices.widget.activeLabel', s.activeCount); }
    attention.textContent = s.needsAttentionCount ? tp('devices.widget.attention', s.needsAttentionCount) : '';
    extra.textContent = s.archivedCount ? tp('devices.widget.archived', s.archivedCount) : '';
  });
}
