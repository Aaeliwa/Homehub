/**
 * Devices → Device Details → Cleaning (Phase 5.4d). Built by the Cleaning module (exposed through
 * cleaning-service), so the Devices module never imports Cleaning internals. Live: subscribes to the
 * shared cleaning store; dispose() unsubscribes when the dialog closes.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { buildBoard, deviceIndex } from './cleaning-model.js';
import { linkedDeviceId } from './cleaning-integration.js';
import { suggestionsFor } from './device-cleaning-catalog.js';
import { formatDateLong, todayIn } from '../expenses/calendar.js';

const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function buildDeviceCleaningSection({ store, state, device, onNavigate, setFocus }) {
  const can = (p) => state.permissions.can(p);
  const lang = state.profile && state.profile.language === 'en' ? 'en' : 'ar';
  const locale = lang === 'ar' ? 'ar-EG' : 'en-GB';
  const tz = state.home.timezone;
  const isChild = state.membership.roleId === 'child' || state.membership.relationship === 'child';
  const el = h('section', { class: 'card fin-card dev-cleaning', id: 'dev-cleaning', 'aria-labelledby': 'dev-cleaning-title' });
  const go = (opts) => { setFocus({ homeId: state.home.id, deviceId: device.id, ...opts }); onNavigate('/m/cleaning'); };

  function statusOf(task, snap, board, idx) {
    const items = [...board.overdue, ...board.today, ...board.upcoming].filter((i) => i.task.id === task.id);
    const open = items.find((i) => !(i.occ && i.occ.status === 'done'));
    if (task.trigger && task.trigger.kind === 'seasonal' && idx.state(task.trigger.deviceId).state !== 'active' && task.trigger.phase === 'active') return t('cleaning.device.offSeason');
    if (open && open.bucket === 'overdue') return t('cleaning.overdueSince', { date: formatDateLong(open.showDate || open.date, locale) }) + (open.usesSince > 1 ? ` · ${t('cleaning.device.usesSince', { n: open.usesSince })}` : '');
    if (open && open.bucket === 'today') return t('cleaning.dueToday') + (open.usesSince > 1 ? ` · ${t('cleaning.device.usesSince', { n: open.usesSince })}` : '');
    if (items.some((i) => i.occ && i.occ.status === 'done' && i.bucket === 'today')) return t('cleaning.device.doneToday');
    if (open && open.bucket === 'upcoming') return t('cleaning.device.nextOn', { date: formatDateLong(open.showDate || open.date, locale) });
    if (task.recurrence && task.recurrence.kind === 'onUse') return t('cleaning.device.waitingForUse');
    return t('cleaning.device.noUpcoming');
  }

  function render() {
    const snap = store.getSnapshot();
    const head = h('h3', { class: 'card__title', id: 'dev-cleaning-title' }, `🧹 ${t('cleaning.device.sectionTitle')}`);
    if (snap.status !== 'ready') { el.replaceChildren(head, h('p', { class: 'muted', role: 'status' }, t('common.loading'))); return; }
    const today = todayIn(tz);
    const linked = snap.tasks.filter((x) => linkedDeviceId(x) === device.id && x.active === true);
    const board = buildBoard({ tasks: linked, occurrences: snap.occurrences, today, uid: state.identity.uid, can, isChild, tz,
      deviceEvents: snap.deviceEvents || [], deviceStates: snap.deviceStates || new Map() });
    const idx = deviceIndex(snap.deviceEvents || [], snap.deviceStates || new Map(), tz, today);
    const active = device.active !== false;
    const canAdd = active && can('cleaning.create');
    const titles = new Set(linked.map((x) => norm(x.title)));
    const sugg = canAdd ? suggestionsFor(device).filter((s) => !titles.has(norm(s.titleAr)) && !titles.has(norm(s.titleEn))).slice(0, 3) : [];
    el.replaceChildren(...[head,
      linked.length ? h('ul', { class: 'fin-list', id: 'dev-cleaning-list' }, linked.map((x) => h('li', { class: 'fin-row', dataset: { task: x.id } },
        h('span', { class: 'fin-row__main', dir: 'auto' }, x.title, h('span', { class: 'fin-row__sub' }, statusOf(x, snap, board, idx))))))
        : h('p', { class: 'empty', id: 'dev-cleaning-empty' }, t('cleaning.device.noLinked')),
      !active ? h('p', { class: 'field__hint' }, t('cleaning.device.archivedReadOnly')) : null,
      h('div', { class: 'cl-item__actions' },
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'dev-cleaning-view', onClick: () => go({}) }, t('cleaning.device.viewTasks')),
        canAdd ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'dev-cleaning-add', onClick: () => go({ openNew: true }) }, t('cleaning.device.addTask')) : null),
      sugg.length ? h('div', { id: 'dev-cleaning-suggest' },
        h('p', { class: 'field__label' }, t('cleaning.catalog.suggested')),
        h('p', { class: 'field__hint' }, t('cleaning.catalog.disclaimer')),
        h('ul', { class: 'fin-list' }, sugg.map((sg) => h('li', { class: 'fin-row', dataset: { suggestion: sg.key } },
          h('span', { class: 'fin-row__main', dir: 'auto' }, lang === 'en' ? sg.titleEn : sg.titleAr,
            h('span', { class: 'fin-row__sub' }, [t(sg.recurrence.unit === 'month' ? 'cleaning.rec.afterMonths' : 'cleaning.rec.afterDays', { n: sg.recurrence.interval }), sg.caveat ? t(`cleaning.catalog.caveat.${sg.caveat}`) : null].filter(Boolean).join(' · '))),
          h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'use-suggestion', onClick: () => go({ openNew: true, preset: {
            title: lang === 'en' ? sg.titleEn : sg.titleAr, recurrence: sg.recurrence, instructions: sg.caveat ? t(`cleaning.catalog.caveat.${sg.caveat}`) : null } }) }, t('cleaning.catalog.add')))))) : null,
    ].filter(Boolean));
  }
  const off = store.subscribe(() => render());
  render();
  return { el, dispose: off };
}
