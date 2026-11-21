/**
 * Reminders (#/reminders) — Phase 5.6 / V6.4.1 Stage B. In-app only: derived from Cleaning, Maintenance, Calendar
 * (events with a reminder, once due) and Finance commitments (each shown
 * only with its own view permission). Read / dismiss / snooze are per-user PRESENTATION state and
 * never change a task, plan, fault or cost. Background notifications are not implemented.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { banner, errorText } from '../components/common.js';
import { toast } from '../components/toast.js';
import { formatDateLong, addDays } from '../../modules/expenses/calendar.js';
import { createRemindersFeed, canSeeReminders } from '../../core/reminders/reminders-service.js';
import { isShown, LOOK_AHEAD } from '../../core/reminders/reminders-model.js';
import { setCleaningFocus } from '../../modules/cleaning/cleaning-service.js';
import { setMaintenanceFocus } from '../../modules/maintenance/maintenance-service.js';
import { setCalendarFocus } from '../../modules/calendar/calendar-focus.js';
import { setFinanceFocus } from '../../modules/expenses/finance-focus.js';

const FILTERS = ['all', 'cleaning', 'maintenance', 'calendar', 'bills', 'overdue', 'upcoming', 'faults'];   // V6.4.1 B: + Calendar, Bills
const GROUPS = ['overdue', 'today', 'openFault', 'upcoming'];
const match = (f, r) => f === 'all' || (f === 'cleaning' && r.sourceKind === 'cleaning') || (f === 'maintenance' && (r.sourceKind === 'maintenancePlan' || r.sourceKind === 'maintenanceFault'))
  || (f === 'calendar' && r.sourceKind === 'calendarEvent') || (f === 'bills' && r.sourceKind === 'commitment')
  || (f === 'overdue' && r.bucket === 'overdue') || (f === 'upcoming' && (r.bucket === 'upcoming' || r.bucket === 'today')) || (f === 'faults' && r.bucket === 'openFault');

export function mountReminders(outlet, ctx) {
  const state = ctx.getState();
  const locale = state.profile && state.profile.language === 'ar' ? 'ar-EG' : 'en-GB';
  if (!canSeeReminders(state.permissions)) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', t('reminders.noAccess')))); return { destroy() {} }; }
  const root = h('div', { class: 'page page--reminders', id: 'rm-page' });
  const body = h('div', { id: 'rm-body' });
  let filter = 'all'; let showSettings = false; let data = null;
  root.append(
    h('header', { class: 'page-head' }, h('h1', { class: 'page-head__title' }, t('reminders.title')), h('p', { class: 'page-head__sub' }, t('reminders.sub'))),
    h('p', { class: 'banner banner--info', id: 'rm-delivery', role: 'note' }, t('reminders.inAppOnly')),
    body);
  outlet.replaceChildren(root);

  const act = async (fn, okKey) => { try { await fn(); if (okKey) toast(t(okKey), { tone: 'success' }); } catch (e) { toast(errorText(e), { tone: 'error' }); } };
  async function open(r) {
    try { if (r.presentation === 'unread') await feed.store.mark(r.key, 'read'); } catch { /* opening still works; state is optional */ }
    if (r.target.module === 'cleaning') { setCleaningFocus({ homeId: state.home.id, view: r.target.view, highlightTaskId: r.target.taskId }); ctx.navigate('/m/cleaning'); }
    else if (r.target.module === 'calendar') { setCalendarFocus({ homeId: state.home.id, date: r.target.date, eventId: r.target.eventId }); ctx.navigate('/m/calendar'); }
    else if (r.target.module === 'expenses') { setFinanceFocus({ homeId: state.home.id, tab: 'commitments', commitmentId: r.target.commitmentId }); ctx.navigate('/m/expenses'); }
    else { setMaintenanceFocus({ homeId: state.home.id, planId: r.target.planId || null, faultId: r.target.faultId || null }); ctx.navigate('/m/maintenance'); }
  }
  const typeLabel = (r) => t(r.kind === 'contactActivity' ? 'reminders.kind.contactActivity' : `reminders.kind.${r.sourceKind}`);
  const when = (r) => (r.bucket === 'openFault' ? t('reminders.noDueDate') : r.bucket === 'today' ? [t('reminders.dueToday'), r.time].filter(Boolean).join(' · ') : r.bucket === 'overdue' ? t('reminders.overdueSince', { date: formatDateLong(r.date, locale) }) : [formatDateLong(r.date, locale), r.time].filter(Boolean).join(' · '));
  function item(r, hidden) {
    const where = [data.deviceName(r.deviceId), data.roomName(r.roomId)].filter(Boolean).join(' · ');
    const tag = r.bucket === 'openFault' ? t(`maintenance.severity.${r.severity}`) : r.priority === 'high' ? t('reminders.high') : null;
    return h('li', { class: `cl-item rm-item rm-item--${r.bucket} rm-item--${r.presentation}`, dataset: { key: r.key, kind: r.sourceKind, presentation: r.presentation, bucket: r.bucket } },
      h('div', { class: 'cl-item__main' },
        h('p', { class: 'cl-item__title', dir: 'auto' }, r.titleKey ? t(r.titleKey) : r.title,
          r.titleKey ? h('span', { class: 'cl-item__meta', id: 'rm-cleaning-body' }, t('reminders.cleaningBody', { n: r.count, rooms: r.rooms })) : null, tag ? h('span', { class: 'pill' }, tag) : null, r.presentation === 'unread' && !hidden ? h('span', { class: 'pill pill--warn rm-unread' }, t('reminders.unread')) : null),
        h('p', { class: 'cl-item__meta' }, [typeLabel(r), where, when(r), r.faultStatus ? t(`maintenance.fault.${r.faultStatus}`) : null,
          r.presentation === 'snoozed' ? t('reminders.snoozedUntil', { date: formatDateLong(r.snoozeUntil, locale) }) : r.presentation === 'dismissed' ? t('reminders.dismissed') : null].filter(Boolean).join(' · '))),
      h('div', { class: 'cl-item__actions' }, ...(hidden
        ? [h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'restore', onClick: () => act(() => feed.store.clear(r.key), 'reminders.toast.restored') }, t('reminders.restore'))]
        : [h('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-action': 'open', onClick: () => open(r) }, t('reminders.open')),
          r.presentation === 'unread' ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'read', onClick: () => act(() => feed.store.mark(r.key, 'read')) }, t('reminders.markRead')) : null,
          h('select', { class: 'input input--sm', 'aria-label': t('reminders.snooze'), 'data-action': 'snooze', onChange: (e) => { const n = Number(e.target.value); if (n) act(() => feed.store.mark(r.key, 'snoozed', addDays(data.today, n)), 'reminders.toast.snoozed'); } },
            h('option', { value: '' }, t('reminders.snooze')), ...[1, 3, 7].map((n) => h('option', { value: n }, t('reminders.snoozeDays', { n })))),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'dismiss', onClick: () => act(() => feed.store.mark(r.key, 'dismissed'), 'reminders.toast.dismissed') }, t('reminders.dismiss'))].filter(Boolean))));
  }
  function settings() {
    const p = data.prefs;
    const hourSel = (id, v) => h('select', { id, class: 'input input--sm' }, [h('option', { value: '' }, t('reminders.off')), ...Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: v === i }, `${String(i).padStart(2, '0')}:00`))]);
    const chk = (id, v) => h('input', { type: 'checkbox', id, checked: v });
    return h('section', { class: 'card fin-card', id: 'rm-settings' }, h('h2', { class: 'card__title' }, t('reminders.settings')),
      h('p', { class: 'field__hint' }, t('reminders.settingsHint')),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('reminders.lookAhead')),
        h('select', { id: 'rm-look', class: 'input' }, LOOK_AHEAD.map((n) => h('option', { value: n, selected: n === p.lookAheadDays }, t('reminders.days', { n }))))),
      data.sources.cleaning ? h('label', { class: 'fin-check' }, chk('rm-t-cleaning', p.cleaning), h('span', null, t('reminders.kind.cleaning'))) : null,
      data.sources.maintenance ? h('label', { class: 'fin-check' }, chk('rm-t-plans', p.maintenancePlans), h('span', null, t('reminders.kind.maintenancePlan'))) : null,
      data.sources.maintenance ? h('label', { class: 'fin-check' }, chk('rm-t-faults', p.maintenanceFaults), h('span', null, t('reminders.kind.maintenanceFault'))) : null,
      data.sources.calendar ? h('label', { class: 'fin-check' }, chk('rm-t-calendar', p.calendar), h('span', null, t('reminders.kind.calendarEvent'))) : null,
      data.sources.finance ? h('label', { class: 'fin-check' }, chk('rm-t-bills', p.commitments), h('span', null, t('reminders.kind.commitment'))) : null,
      h('div', { class: 'form-grid form-grid--tight' },
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('reminders.quietFrom')), hourSel('rm-q-start', p.quietStart)),
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('reminders.quietTo')), hourSel('rm-q-end', p.quietEnd))),
      h('p', { class: 'field__hint' }, t('reminders.quietHint')),
      h('button', { type: 'button', class: 'btn btn--primary', id: 'rm-save', onClick: async (e) => {
        const q = (s) => root.querySelector(s); const num = (s) => (q(s).value === '' ? null : Number(q(s).value));
        const btn = e.currentTarget; btn.disabled = true;   // V6.3 fix: currentTarget is null after an await
        await act(() => feed.store.savePrefs({ lookAheadDays: Number(q('#rm-look').value),
          cleaning: q('#rm-t-cleaning') ? q('#rm-t-cleaning').checked : p.cleaning, maintenancePlans: q('#rm-t-plans') ? q('#rm-t-plans').checked : p.maintenancePlans,
          maintenanceFaults: q('#rm-t-faults') ? q('#rm-t-faults').checked : p.maintenanceFaults,
          calendar: q('#rm-t-calendar') ? q('#rm-t-calendar').checked : p.calendar, commitments: q('#rm-t-bills') ? q('#rm-t-bills').checked : p.commitments, quietStart: num('#rm-q-start'), quietEnd: num('#rm-q-end') }), 'reminders.toast.saved');
        btn.disabled = false;
      } }, t('common.save')));
  }
  function render() {
    if (!data) return;
    if (data.status === 'error') { body.replaceChildren(banner('error', t('reminders.loadError'))); return; }
    if (data.status !== 'ready') { body.replaceChildren(h('p', { class: 'muted', role: 'status' }, t('common.loading'))); return; }
    const shown = data.items.filter(isShown).filter((r) => match(filter, r));
    const hidden = data.items.filter((r) => !isShown(r));
    const partial = !data.sources.cleaning ? t('reminders.noCleaningAccess') : !data.sources.maintenance ? t('reminders.noMaintenanceAccess') : null;
    body.replaceChildren(...[
      h('div', { class: 'toolbar rm-toolbar' },
        h('p', { class: 'cl-progress__text', id: 'rm-counts' }, t('reminders.counts', { n: data.counts.actionable, u: data.counts.unread })),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'rm-settings-btn', 'aria-expanded': String(showSettings), onClick: () => { showSettings = !showSettings; render(); } }, t('reminders.settings'))),
      showSettings ? settings() : null,
      partial ? h('p', { class: 'field__hint', id: 'rm-partial' }, partial) : null,
      h('div', { class: 'cl-chips', role: 'group', 'aria-label': t('reminders.filter') }, FILTERS.filter((f) => filterAvailable(f)).map((f) => h('button', { type: 'button', class: `btn btn--sm ${f === filter ? 'btn--primary' : 'btn--secondary'}`, id: `rm-f-${f}`, 'aria-pressed': String(f === filter), onClick: () => { filter = f; render(); } }, t(`reminders.filter.${f}`)))),
      shown.length ? h('div', { id: 'rm-groups' }, ...GROUPS.map((g) => { const list = shown.filter((r) => r.bucket === g); return list.length ? h('section', { id: `rm-g-${g}` }, h('h2', { class: 'cl-setup__title' }, t(`reminders.group.${g}`)), h('ul', { class: 'cl-list' }, list.map((r) => item(r, false)))) : null; }).filter(Boolean))
        : h('p', { class: 'empty', id: 'rm-empty' }, t(data.items.length ? 'reminders.emptyFiltered' : 'reminders.empty')),
      hidden.length ? h('details', { class: 'form-section', id: 'rm-hidden' }, h('summary', { class: 'form-section__summary' }, t('reminders.hiddenTitle', { n: hidden.length })),
        h('ul', { class: 'cl-list' }, hidden.map((r) => item(r, true)))) : null,
    ].filter(Boolean));
  }
  function filterAvailable(f) {
    const s = data.sources;
    return f === 'cleaning' ? s.cleaning : f === 'maintenance' || f === 'faults' ? s.maintenance : f === 'calendar' ? s.calendar : f === 'bills' ? s.finance : true;
  }
  let feed;
  try { feed = createRemindersFeed(ctx, (d) => { data = d; render(); }); }
  catch (e) { body.replaceChildren(banner('error', errorText(e))); return { destroy() {} }; }
  if (!data) { data = feed.get(); render(); }
  return { destroy() { feed.dispose(); } };
}
