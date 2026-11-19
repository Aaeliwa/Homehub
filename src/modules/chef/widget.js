/**
 * Dashboard: compact active-timer panel (V6.1) — the SAME store, panel and alarm coordinator as cooking
 * mode. V6.1.1: the WHOLE widget is hidden while no timer is running, paused or ringing.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { getChefStore } from './chef-service.js';
import { mountTimersPanel } from './timers-panel.js';
import { isActive } from './timer-model.js';

export function mount(slot, ctx) {
  let store; try { store = getChefStore(ctx); } catch { slot.remove(); return () => {}; }
  const panel = h('div', { id: 'ck-widget-panel' });
  slot.replaceChildren(h('section', { class: 'card fin-card accent-orange', id: 'ck-widget' },
    h('div', { class: 'page-head--row' }, h('h3', { class: 'card__title' }, `⏱ ${t('timers.title')}`), h('a', { href: '#/m/chef', class: 'btn btn--ghost btn--sm', id: 'ck-widget-open' }, t('module.chef.name'))),
    panel));
  const sync = (snap) => { const any = snap.timers.some((x) => isActive(x, Date.now())); slot.style.display = any ? '' : 'none'; slot.toggleAttribute('data-empty', !any); };
  const off = store.subscribe(sync);
  const offPanel = mountTimersPanel(panel, store, { compact: true, title: false });
  return () => { off(); offPanel(); };
}
