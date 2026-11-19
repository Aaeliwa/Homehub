/**
 * Rooms count for the Dashboard's Your Home card (V6.4 — replaces the standalone Rooms tile).
 * Consumes ONLY the module's summary contract ({ activeCount }) from the shared, scope-bound store —
 * no extra reads. Shows ACTIVE rooms only (archived rooms are not counted).
 */
import { h } from '../../core/utils/dom.js';
import { t, tp, formatNumber } from '../../core/i18n/i18n.js';
import { getRoomsStore } from './rooms-service.js';

export function mountCount(dd, ctx) {
  let store;
  try { store = getRoomsStore(ctx); } catch { dd.textContent = '—'; return () => {}; }
  const link = h('a', { class: 'text-link facts__count', href: '#/m/rooms', id: 'home-rooms-count' }, t('common.loading'));
  dd.replaceChildren(link);
  return store.subscribe((snap) => {
    if (snap.status === 'error') { link.textContent = t('rooms.widget.unavailable'); return; }
    if (snap.status !== 'ready') return;
    const { activeCount } = store.summary();
    link.dataset.count = String(activeCount);
    link.textContent = activeCount ? `${formatNumber(activeCount)} ${tp('rooms.widget.activeLabel', activeCount)}` : t('rooms.widget.none');
  });
}
