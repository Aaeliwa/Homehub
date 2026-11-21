/**
 * Dashboard "Upcoming" panel (V6.4.1 Stage B). One chronological list across Calendar (events, tasks, contact
 * activities), Finance commitments, Cleaning and Maintenance — overdue / today / next 7 days — from the Home's
 * shared Upcoming sources hub (no listener of its own). Each row opens its module. Independent of reminder
 * preferences and of read / dismissed / snoozed state. This is NOT the old Reminders card (that stays removed).
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { formatDateLong } from '../../modules/expenses/calendar.js';
import { money } from '../../modules/expenses/finance-ui.js';
import { getUpcomingSources } from '../../core/upcoming/upcoming-sources.js';
import { canSeeReminders } from '../../core/upcoming/access.js';
import { deriveUpcoming, homeCareItems, DASHBOARD_HORIZON, BUCKETS } from '../../core/upcoming/upcoming-model.js';
import { setCalendarFocus } from '../../modules/calendar/calendar-focus.js';
import { setFinanceFocus } from '../../modules/expenses/finance-focus.js';
import { setCleaningFocus } from '../../modules/cleaning/cleaning-service.js';
import { setMaintenanceFocus } from '../../modules/maintenance/maintenance-service.js';

const ICON = { calendar: '📅', contactActivity: '👤', commitment: '💳', cleaning: '🧹', maintenancePlan: '🛠' };
const COLLAPSED = 6;

export const canSeeUpcoming = canSeeReminders;

/** Pure-ish: the items for a hub snapshot (exported for tests). */
export function itemsFor(src) {
  if (!src || src.status !== 'ready') return [];
  const homeCare = homeCareItems({ cleaning: src.cleaning, maintenance: src.maintenance, today: src.today, tz: src.tz, uid: src.uid, can: src.can, isChild: src.isChild,
    isVisible: src.isVisible, roomOf: src.roomOf, deviceOf: src.deviceOf, horizonDays: DASHBOARD_HORIZON });
  return deriveUpcoming({ events: src.events, commitments: src.commitments, homeCare, today: src.today, horizonDays: DASHBOARD_HORIZON, showAmounts: src.flags.totals });
}

export function mountUpcomingPanel(slot, ctx) {
  const state = ctx.getState();
  if (!canSeeUpcoming(state.permissions)) { slot.remove(); return () => {}; }
  let hub; try { hub = getUpcomingSources(ctx); } catch { slot.remove(); return () => {}; }
  let expanded = false; let src = null;
  const body = h('div', { class: 'up-body', id: 'up-body', 'aria-live': 'polite' });
  const card = h('section', { class: 'card up-card', id: 'up-panel', 'aria-labelledby': 'up-title' },
    h('div', { class: 'card__head' }, h('h2', { class: 'card__title', id: 'up-title' }, t('upcoming.title')),
      h('p', { class: 'card__hint' }, t('upcoming.hint', { n: DASHBOARD_HORIZON }))), body);
  slot.replaceChildren(card);

  function open(it) {
    const homeId = state.home.id; const tg = it.target || {};
    if (tg.module === 'calendar') { setCalendarFocus({ homeId, date: tg.date, eventId: tg.eventId }); ctx.navigate('/m/calendar'); }
    else if (tg.module === 'expenses') { setFinanceFocus({ homeId, tab: 'commitments', commitmentId: tg.commitmentId }); ctx.navigate('/m/expenses'); }
    else if (tg.module === 'cleaning') { setCleaningFocus({ homeId, view: tg.view, highlightTaskId: tg.taskId }); ctx.navigate('/m/cleaning'); }
    else if (tg.module === 'maintenance') { setMaintenanceFocus({ homeId, planId: tg.planId || null, faultId: null }); ctx.navigate('/m/maintenance'); }
  }
  const locale = () => getLocale();
  const dateText = (it) => (it.bucket === 'today' ? t('upcoming.today') : formatDateLong(it.date, locale()));
  const category = (it) => (it.source === 'calendar' ? t(`calendar.type.${it.category}`) : t(`upcoming.src.${it.source}`));
  const status = (it) => (it.bucket === 'overdue' ? t('upcoming.overdue') : it.source === 'contactActivity' ? t(`calendar.status.${it.status}`)
    : it.status === 'open' ? t('calendar.open') : it.bucket === 'today' ? t('upcoming.dueToday') : t('upcoming.scheduled'));
  function row(it) {
    const title = it.titleKey ? t(it.titleKey) : it.title;
    const extra = it.source === 'cleaning' && it.count ? t('reminders.cleaningBody', { n: it.count, rooms: it.rooms }) : null;
    const amount = it.amountMinor !== null && it.amountMinor !== undefined ? money(it.amountMinor, it.currency) : null;
    return h('li', { class: `up-item up-item--${it.bucket}`, dataset: { key: it.key, source: it.source, bucket: it.bucket } },
      h('button', { type: 'button', class: 'up-item__btn', 'aria-label': t('upcoming.openX', { title, when: dateText(it), what: category(it) }), onClick: () => open(it) },
        h('span', { class: 'up-item__icon', 'aria-hidden': 'true' }, ICON[it.source] || '•'),
        h('span', { class: 'up-item__text' },
          h('span', { class: 'up-item__title', dir: 'auto' }, title, it.private ? h('span', { class: 'up-item__lock', title: t('calendar.private') }, ' 🔒') : null),
          h('span', { class: 'up-item__meta' }, [dateText(it), it.time, category(it), extra, amount ? h('span', { dir: 'ltr' }, amount) : null].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x])))),
        h('span', { class: ['pill', 'up-item__status', it.bucket === 'overdue' && 'pill--warn'] }, status(it))));
  }
  function render() {
    if (!src || src.status === 'idle' || src.status === 'loading') { body.replaceChildren(h('p', { class: 'muted', role: 'status', id: 'up-loading' }, t('common.loading'))); return; }
    if (src.status === 'error') { body.replaceChildren(h('p', { class: 'field__error', role: 'alert', id: 'up-error' }, t('upcoming.error'))); return; }
    const items = itemsFor(src);
    if (!items.length) { body.replaceChildren(h('p', { class: 'empty', id: 'up-empty' }, t('upcoming.empty', { n: DASHBOARD_HORIZON }))); return; }
    const shown = expanded ? items : items.slice(0, COLLAPSED);
    body.replaceChildren(
      ...BUCKETS.map((b) => { const list = shown.filter((it) => it.bucket === b); return list.length ? h('div', { class: 'up-group', id: `up-g-${b}` },
        h('h3', { class: 'up-group__title' }, t(`upcoming.group.${b}`, { n: DASHBOARD_HORIZON })), h('ul', { class: 'up-list' }, list.map(row))) : null; }).filter(Boolean),
      items.length > COLLAPSED ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'up-more', 'aria-expanded': String(expanded),
        onClick: () => { expanded = !expanded; render(); } }, expanded ? t('upcoming.less') : t('upcoming.more', { n: items.length - COLLAPSED })) : '');
  }
  const off = hub.subscribe((s) => { src = s; render(); });
  return () => off();
}
