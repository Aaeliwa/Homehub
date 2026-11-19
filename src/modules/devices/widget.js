/**
 * Devices count for the Dashboard's Your Home card (V6.4 — replaces the standalone Devices tile).
 * Consumes ONLY the summary contract { activeCount, needsAttentionCount } from the shared store — no
 * extra reads. Shows ACTIVE devices only (archived devices are not counted).
 */
import { h } from '../../core/utils/dom.js';
import { t, tp, formatNumber } from '../../core/i18n/i18n.js';
import { getDevicesStore } from './devices-service.js';

export function mountCount(dd, ctx) {
  let store;
  try { store = getDevicesStore(ctx); } catch { dd.textContent = '—'; return () => {}; }
  const link = h('a', { class: 'text-link facts__count', href: '#/m/devices', id: 'home-devices-count' }, t('common.loading'));
  const attention = h('span', { class: 'facts__note', id: 'home-devices-attention' });
  dd.replaceChildren(link, attention);
  return store.subscribe((snap) => {
    if (snap.status === 'error') { link.textContent = t('devices.widget.unavailable'); attention.textContent = ''; return; }
    if (snap.status !== 'ready') return;
    const s = store.summary();
    link.dataset.count = String(s.activeCount);
    link.textContent = s.activeCount ? `${formatNumber(s.activeCount)} ${tp('devices.widget.activeLabel', s.activeCount)}` : t('devices.widget.none');
    attention.textContent = s.needsAttentionCount ? tp('devices.widget.attention', s.needsAttentionCount) : '';
  });
}
