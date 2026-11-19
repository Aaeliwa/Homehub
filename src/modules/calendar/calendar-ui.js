/**
 * Calendar UI pieces shared by the dashboard widget and the full page (ONE implementation over the
 * shared Calendar store): Monday-first month grid, day agenda, event form, delete confirmation.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { toast } from '../../ui/components/toast.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { formDialog, val } from '../expenses/dialogs.js';
import { field, select } from '../expenses/finance-ui.js';
import { formatMonth, formatDateLong } from '../expenses/calendar.js';
import { monthGrid, eventsOn, TYPES, LIMITS, weekOf, weekBars, isMultiDay, shiftOf, SHIFTS } from './calendar-model.js';

export const COLORS = Object.freeze({ work: 'blue', vacation: 'green', task: 'amber', reminder: 'purple', other: 'gray' });
/** V6.2.2: Day Shift = blue, Night Shift = purple; otherwise the type colour. */
export const colorOf = (e) => (shiftOf(e) === 'night' ? 'purple' : shiftOf(e) === 'day' ? 'blue' : COLORS[e.type] || 'gray');
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  day: ['M12 7a5 5 0 1 0 0 10a5 5 0 0 0 0-10z', 'M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1'],
  night: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
};
/** Accessible sun / moon icon (inline SVG, currentColor; labelled unless decorative). */
export function shiftIcon(kind, { decorative = false } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '1em', height: '1em', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `cal-ico cal-ico--${kind}`, focusable: 'false' })) svg.setAttribute(k, v);
  if (decorative) svg.setAttribute('aria-hidden', 'true'); else { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', t(`calendar.shift.${kind}`)); }
  for (const d of ICON_PATHS[kind]) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); if (kind === 'night' || d.startsWith('M12 7')) p.setAttribute('fill', 'currentColor'); svg.append(p); }
  return svg;
}
/** Title with the shift icon in front (when it is a shift). */
export const titleWithIcon = (e, opts) => { const k = shiftOf(e); return k ? [shiftIcon(k, opts), ' ', e.title] : [e.title]; };
const F = (...a) => field(...a).root;
const fmtDay = (d) => { try { return new Intl.DateTimeFormat(getLocale(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`)); } catch { return d; } };
export const weekdayLabels = () => weekOf('2026-11-16').map(fmtDay);   // Monday-first
export const msg = (e) => t(e && e.detail && /^calendar\./.test(e.detail) ? e.detail : 'calendar.err.save');

export function timeText(e) {
  if (e.allDay) return t('calendar.allDay');
  return `${e.startTime}–${e.endTime}${e.endDate !== e.startDate ? ` (${t('calendar.multiDay')})` : ''}`;
}

/**
 * Month grid. opts: { ym, selected, today, events, expanded, onSelect(date), idPrefix }.
 * V6.2.2: events covering 2+ dates are drawn as ONE continuous bar per week row (segmented at week rows,
 * clipped to the month; continuation ends are squared off); single-day events stay compact (dots / chips).
 * Both the dashboard widget and the full page use this one renderer.
 */
export function grid({ ym, selected, today, events, expanded, onSelect, idPrefix = 'cal' }) {
  const days = monthGrid(ym);
  const maxLanes = expanded ? 3 : 2;
  const g = h('div', { class: `cal-grid${expanded ? ' cal-grid--expanded' : ''}`, role: 'grid', id: `${idPrefix}-grid`, 'aria-label': formatMonth(ym, getLocale()) },
    h('div', { class: 'cal-row cal-row--head', role: 'row' }, weekdayLabels().map((d) => h('span', { role: 'columnheader', class: 'cal-dow' }, d))));
  for (let w = 0; w < days.length / 7; w++) {
    const week = days.slice(w * 7, w * 7 + 7);
    const { segs, lanes, hidden } = weekBars(events, week, ym, maxLanes);
    const row = h('div', { class: 'cal-row', role: 'row' }, week.map((d) => {
      const evs = eventsOn(events, d); const out = d.slice(0, 7) !== ym;
      const singles = evs.filter((e) => !isMultiDay(e));
      const limit = expanded ? Math.max(0, 3 - lanes) : 3;
      const more = (hidden[d] || 0) + Math.max(0, singles.length - limit);
      const label = `${formatDateLong(d, getLocale())}${evs.length ? ` — ${t('calendar.nEvents', { n: evs.length })}: ${evs.map((e) => e.title).join(', ')}` : ''}`;
      return h('button', { type: 'button', role: 'gridcell', class: ['cal-cell', out && 'cal-cell--out', d === today && 'cal-cell--today', d === selected && 'cal-cell--sel'],
        'aria-selected': String(d === selected), 'aria-label': label, tabindex: d === selected ? '0' : '-1', dataset: { date: d },
        onClick: () => onSelect(d),
        onKeydown: (e) => { const k = { ArrowRight: document.dir === 'rtl' ? -1 : 1, ArrowLeft: document.dir === 'rtl' ? 1 : -1, ArrowDown: 7, ArrowUp: -7 }[e.key]; if (k) { e.preventDefault(); onSelect(shift(d, k), true); } } },
        h('span', { class: 'cal-num' }, String(Number(d.slice(8)))),
        lanes ? h('span', { class: 'cal-lanes', 'aria-hidden': 'true', style: { blockSize: `calc(${lanes} * var(--cal-bar-h) + ${lanes - 1} * 2px)` } }) : null,
        expanded ? h('span', { class: 'cal-titles' }, singles.slice(0, limit).map((e) => h('span', { class: `cal-chip cal-c-${colorOf(e)}`, dataset: { event: e.id } }, ...titleWithIcon(e, { decorative: true }))), more ? h('span', { class: 'cal-more' }, `+${more}`) : null)
          : h('span', { class: 'cal-dots', 'aria-hidden': 'true' }, singles.slice(0, 3).map((e) => h('i', { class: `cal-dot cal-c-${colorOf(e)}` })), more ? h('span', { class: 'cal-more' }, `+${more}`) : null));
    }));
    // One button per visible segment; grid columns follow the document direction (RTL mirrors itself).
    const bars = segs.length ? h('div', { class: 'cal-bars', role: 'presentation' }, segs.map((sg) => h('button', {
      type: 'button', tabindex: '-1', class: ['cal-bar', `cal-c-${colorOf(sg.event)}`, sg.contBefore && 'cal-bar--cont-start', sg.contAfter && 'cal-bar--cont-end', !sg.startsHere && 'cal-bar--continued'],
      style: { gridColumn: `${sg.from + 1} / ${sg.to + 2}`, gridRow: String(sg.lane + 1) },
      dataset: { event: sg.event.id, from: week[sg.from], to: week[sg.to] },
      'aria-label': `${shiftOf(sg.event) ? `${t(`calendar.shift.${shiftOf(sg.event)}`)}: ` : ''}${sg.event.title} — ${formatDateLong(sg.event.startDate, getLocale())} – ${formatDateLong(sg.event.endDate, getLocale())}`,
      title: sg.event.title, onClick: () => onSelect(week[sg.from]) },
    // The icon sits on the VISIBLE starting segment only (its real start, or the 1st of the month when it began earlier).
    h('span', { class: 'cal-bar__label', dir: 'auto' }, ...(sg.startsHere || (sg.event.startDate < `${ym}-01` && week[sg.from] === `${ym}-01`) ? titleWithIcon(sg.event, { decorative: true }) : [sg.event.title]))))) : null;
    g.append(h('div', { class: 'cal-wk', role: 'presentation' }, row, bars));
  }
  return g;
}
const shift = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export function legend() {
  return h('ul', { class: 'cal-legend', 'aria-label': t('calendar.legend') }, TYPES.map((k) => h('li', null, h('i', { class: `cal-dot cal-c-${COLORS[k]}`, 'aria-hidden': 'true' }), t(`calendar.type.${k}`))),
    SHIFTS.map((k) => h('li', { class: `cal-legend__shift cal-t-${k === 'night' ? 'purple' : 'blue'}` }, shiftIcon(k, { decorative: true }), t(`calendar.shift.${k}`))));
}

/** A day's agenda with edit / delete / done as permitted. */
export function agenda({ store, date, events, can, uid, container, id = 'cal-agenda' }) {
  const list = eventsOn(events, date);
  return h('section', { class: 'cal-agenda', id, 'aria-label': formatDateLong(date, getLocale()) },
    h('h3', { class: 'cal-agenda__title' }, formatDateLong(date, getLocale())),
    list.length ? h('ul', { class: 'fin-list' }, list.map((e) => item(e))) : h('p', { class: 'empty' }, t('calendar.nothing')));
  function item(e) {
    const mayEdit = can('calendar.edit') && (e.audience === 'household' || e.createdBy === uid);
    const mayDel = can('calendar.delete') && (e.audience === 'household' || e.createdBy === uid);
    return h('li', { class: `fin-row cal-item${e.done ? ' cal-item--done' : ''}`, dataset: { event: e.id, type: e.type } },
      h('span', { class: `cal-dot cal-c-${colorOf(e)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'fin-row__main', dir: 'auto' }, ...(shiftOf(e) ? [h('span', { class: `cal-t-${colorOf(e)}` }, shiftIcon(shiftOf(e))), ' '] : []), e.title,
        h('span', { class: 'fin-row__sub' }, [shiftOf(e) ? t(`calendar.shift.${shiftOf(e)}`) : t(`calendar.type.${e.type}`), timeText(e), e.audience === 'private' ? `🔒 ${t('calendar.private')}` : null,
          e.type === 'task' ? t(e.done ? 'calendar.done' : 'calendar.open') : null, e.location].filter(Boolean).join(' · '))),
      h('span', { class: 'cl-item__actions' },
        e.type === 'task' && mayEdit ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'done', 'aria-pressed': String(!!e.done),
          onClick: run(() => store.setDone(e.id, !e.done)) }, t(e.done ? 'calendar.reopen' : 'calendar.markDone')) : null,
        mayEdit ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'edit', 'aria-label': t('calendar.editX', { title: e.title }), onClick: () => eventForm({ store, container, event: e }) }, '✎') : null,
        mayDel ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'delete', 'aria-label': t('calendar.deleteX', { title: e.title }),
          onClick: async () => { if (!(await confirmDialog({ title: t('calendar.deleteTitle'), message: t(e.type === 'vacation' ? 'calendar.deleteVacBody' : 'calendar.deleteBody', { title: e.title }), confirmLabel: t('calendar.delete'), container }))) return;
            try { await store.remove(e.id); toast(t('calendar.toast.deleted'), { tone: 'success' }); } catch (x) { toast(msg(x), { tone: 'error' }); } } }, '🗑') : null));
  }
}
const run = (fn) => async (ev) => { const b = ev && ev.currentTarget; if (b) b.disabled = true; try { await fn(); } catch (e) { toast(msg(e), { tone: 'error' }); } finally { if (b) b.disabled = false; } };

/** Create / edit dialog. preset: { startDate, endDate, type }. */
export function eventForm({ store, container, event = null, preset = {} }) {
  const v = event || { title: '', type: 'other', allDay: true, startDate: preset.startDate, endDate: preset.endDate || preset.startDate, startTime: '09:00', endTime: '10:00', description: '', location: '', audience: 'household', ...preset };
  const allDayBox = h('input', { type: 'checkbox', id: 'cal-f-allday', checked: v.allDay, onChange: (e) => { for (const el of document.querySelectorAll('#cal-form .cal-time')) el.hidden = e.target.checked; } });
  formDialog({ title: t(event ? 'calendar.edit' : 'calendar.new'), id: 'cal-form', submitLabel: t('common.save'), container,
    fields: [F(t('calendar.title'), h('input', { id: 'cal-f-title', class: 'input', maxlength: LIMITS.title, dir: 'auto', value: v.title }), { id: 'cal-f-title' }),
      F(t('calendar.typeLabel'), select('cal-f-type', TYPES.map((k) => ({ value: k, label: t(`calendar.type.${k}`) })), v.type), { id: 'cal-f-type' }),
      // V6.2.2: Auto = from the title ("Day Shift" / "Night Shift"); an explicit choice overrides it.
      F(t('calendar.shift.label'), select('cal-f-shift', [{ value: 'auto', label: t('calendar.shift.auto') }, { value: 'none', label: t('calendar.shift.none') },
        ...SHIFTS.map((k) => ({ value: k, label: t(`calendar.shift.${k}`) }))], event ? (event.shift === undefined ? 'auto' : event.shift || 'none') : 'auto'), { id: 'cal-f-shift', hint: t('calendar.shift.hint') }),
      h('label', { class: 'fin-check' }, allDayBox, h('span', null, t('calendar.allDay'))),
      h('div', { class: 'form-grid form-grid--tight' },
        F(t('calendar.start'), h('input', { id: 'cal-f-sd', type: 'date', class: 'input', value: v.startDate }), { id: 'cal-f-sd' }),
        h('div', { class: 'cal-time', hidden: v.allDay }, F(t('calendar.startTime'), h('input', { id: 'cal-f-st', type: 'time', class: 'input', value: v.startTime || '09:00' }), { id: 'cal-f-st' })),
        F(t('calendar.end'), h('input', { id: 'cal-f-ed', type: 'date', class: 'input', value: v.endDate }), { id: 'cal-f-ed' }),
        h('div', { class: 'cal-time', hidden: v.allDay }, F(t('calendar.endTime'), h('input', { id: 'cal-f-et', type: 'time', class: 'input', value: v.endTime || '10:00' }), { id: 'cal-f-et' }))),
      F(t('calendar.location'), h('input', { id: 'cal-f-loc', class: 'input', maxlength: LIMITS.location, dir: 'auto', value: v.location || '' }), { id: 'cal-f-loc' }),
      F(t('calendar.description'), h('textarea', { id: 'cal-f-desc', class: 'input', rows: 2, maxlength: LIMITS.description, dir: 'auto' }, v.description || ''), { id: 'cal-f-desc' }),
      event ? null : F(t('calendar.visibility'), select('cal-f-aud', [{ value: 'household', label: t('calendar.household') }, { value: 'private', label: `🔒 ${t('calendar.private')}` }], v.audience), { id: 'cal-f-aud' })].filter(Boolean),
    onSubmit: async () => {
      const r = document.getElementById('cal-form'); const allDay = r.querySelector('#cal-f-allday').checked;
      const sh = val(r, '#cal-f-shift');
      const input = { title: val(r, '#cal-f-title'), type: val(r, '#cal-f-type'), shift: sh === 'none' ? null : sh, allDay, startDate: val(r, '#cal-f-sd'), endDate: val(r, '#cal-f-ed') || val(r, '#cal-f-sd'),
        startTime: allDay ? null : val(r, '#cal-f-st'), endTime: allDay ? null : val(r, '#cal-f-et'), location: val(r, '#cal-f-loc'), description: val(r, '#cal-f-desc'),
        audience: event ? event.audience : val(r, '#cal-f-aud') };
      if (event) await store.edit(event.id, input); else await store.create(input);   // validation errors are shown in the dialog
      return event ? 'calendar.toast.saved' : 'calendar.toast.created';
    } });
}
