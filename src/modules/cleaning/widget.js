/**
 * Cleaning dashboard widget (Phase 5.3.1: rebuilt on the SHARED summary-card component, exactly like
 * the Rooms / Devices / Finance cards — same layout, spacing, typography, icon treatment, accent and
 * responsive behaviour; no Cleaning-specific card styles). Same store as the page: no extra listeners.
 */
import { h } from '../../core/utils/dom.js';
import { t, formatNumber } from '../../core/i18n/i18n.js';
import { todayIn } from '../expenses/calendar.js';
import { getCleaningStore } from './cleaning-service.js';
import { buildBoard } from './cleaning-model.js';

export function mount(slot, ctx) {
  const state = ctx.getState();
  let store;
  try { store = getCleaningStore(ctx); } catch { slot.remove(); return () => {}; }
  const isChild = state.membership.roleId === 'child' || state.membership.relationship === 'child';

  const value = h('span', { class: 'summary-card__value' }, '…');
  const label = h('span', { class: 'summary-card__label' }, t('common.loading'));
  const extra = h('span', { class: 'summary-card__extra', id: 'cl-widget-extra' });
  slot.replaceChildren(h('a', { class: 'summary-card accent-sky', href: '#/m/cleaning', id: 'cl-widget' },
    h('span', { class: 'summary-card__icon', 'aria-hidden': 'true' }, '🧹'),
    h('span', { class: 'summary-card__body' },
      h('span', { class: 'summary-card__title' }, t('module.cleaning.name')),
      h('span', { class: 'summary-card__figure' }, value, label),
      extra)));

  return store.subscribe((snap) => {
    if (snap.status === 'error') { value.textContent = '—'; label.textContent = t('cleaning.widget.unavailable'); extra.textContent = ''; return; }
    if (snap.status !== 'ready') return;
    const b = buildBoard({ tasks: snap.tasks, occurrences: snap.occurrences, today: todayIn(state.home.timezone), uid: state.identity.uid,
      deviceEvents: snap.deviceEvents || [], deviceStates: snap.deviceStates || new Map(),
      can: (p) => state.permissions.can(p), isChild, tz: state.home.timezone });
    if (!b.progress.total) { value.textContent = ''; label.textContent = t('cleaning.nothingToday'); }
    else { value.textContent = `${formatNumber(b.progress.done)}/${formatNumber(b.progress.total)}`; label.textContent = t('cleaning.widget.doneToday'); }
    extra.textContent = [b.overdue.length ? t('cleaning.widget.overdue', { n: b.overdue.length }) : '', b.mine.length ? t('cleaning.widget.mine', { n: b.mine.length }) : ''].filter(Boolean).join(' · ');
  });
}
