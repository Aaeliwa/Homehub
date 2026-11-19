/**
 * Dashboard Calendar widget (V6.2): a compact, Google Calendar-like Monday-first month grid with
 * coloured dots (expanded: titles), Today, ＋, the selected day's agenda and "Open full calendar".
 * Live-backed by the shared Calendar store — never preview data.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { todayIn, formatMonth } from '../expenses/calendar.js';
import { shiftMonth } from './calendar-model.js';
import { getCalendarStore } from './calendar-service.js';
import { grid, agenda, legend, eventForm } from './calendar-ui.js';

export function mount(slot, ctx) {
  let store; try { store = getCalendarStore(ctx); } catch { slot.remove(); return () => {}; }
  const state = ctx.getState(); const can = (p) => state.permissions.can(p);
  const today = todayIn(state.home.timezone);
  let ym = today.slice(0, 7); let selected = today; let expanded = false;
  const card = h('section', { class: 'card fin-card accent-blue cal-widget', id: 'cal-widget' });
  slot.replaceChildren(card);
  function render(focusDate) {
    const snap = store.getSnapshot();
    const head = h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'calw-prev', 'aria-label': t('calendar.prevMonth'), onClick: () => { ym = shiftMonth(ym, -1); render(); } }, document.dir === 'rtl' ? '›' : '‹'),
      h('h3', { class: 'card__title cal-head__title', id: 'calw-month', 'aria-live': 'polite' }, formatMonth(ym, getLocale())),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'calw-next', 'aria-label': t('calendar.nextMonth'), onClick: () => { ym = shiftMonth(ym, 1); render(); } }, document.dir === 'rtl' ? '‹' : '›'),
      h('span', { class: 'cal-head__spacer' }),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'calw-today', onClick: () => { ym = today.slice(0, 7); selected = today; render(today); } }, t('calendar.today')),
      can('calendar.create') ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'calw-add', 'aria-label': t('calendar.new'), onClick: () => eventForm({ store, container: card, preset: { startDate: selected } }) }, '＋') : null,
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'calw-expand', 'aria-expanded': String(expanded), 'aria-label': t(expanded ? 'calendar.collapse' : 'calendar.expand'), onClick: () => { expanded = !expanded; render(); } }, expanded ? '⤡' : '⤢'));
    const body = snap.status === 'error' ? h('p', { class: 'field__error' }, t('calendar.err.load'))
      : grid({ ym, selected, today, events: snap.events, expanded, idPrefix: 'calw', onSelect: (d, kb) => { selected = d; ym = d.slice(0, 7); render(kb ? d : null); } });
    card.replaceChildren(...[head, body, legend(),
      agenda({ store, date: selected, events: snap.events, can, uid: state.identity.uid, container: card, id: 'calw-agenda' }),
      expanded ? h('a', { href: '#/m/calendar', class: 'btn btn--secondary btn--sm', id: 'calw-open' }, t('calendar.openFull')) : null].filter(Boolean));
    if (focusDate) { const c = card.querySelector(`[data-date="${focusDate}"]`); if (c) c.focus(); }
  }
  const off = store.subscribe(() => render());
  return () => off();
}
