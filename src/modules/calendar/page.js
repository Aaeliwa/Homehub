/**
 * Calendar (#/m/calendar) — V6.2: month / week / agenda views, events / tasks / reminders, confirmed
 * vacations, "Unclassified off-duty" suggestions (never auto-labelled vacation) and the Google
 * Calendar CSV import (preview → per-row classification → explicit confirmation → create-only).
 * V6.2.1: Settings → CSV Imports — every import is a batch (file, time, count, status) that can be removed
 * as a unit (soft delete of its own events only; resumable). V6.2 imports without a batch stay ungrouped.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { banner, errorText } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { formDialog } from '../expenses/dialogs.js';
import { todayIn, formatMonth, formatDateShort, formatDateLong, addDays } from '../expenses/calendar.js';
import { shiftMonth, weekOf, eventsOn, inRange, offDutyGaps, previewImport, TYPES, isLive, batchMembers, shiftOf } from './calendar-model.js';
import { getCalendarStore } from './calendar-service.js';
import { icon } from '../../ui/components/icons.js';
import { grid, agenda, legend, eventForm, timeText, colorOf, shiftIcon, titleWithIcon, msg, weekdayLabels } from './calendar-ui.js';

export function mount(outlet, ctx) {
  const state = ctx.getState(); const can = (p) => state.permissions.can(p); const uid = state.identity.uid;
  let store; try { store = getCalendarStore(ctx); } catch (e) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(e)))); return () => {}; }
  const today = todayIn(state.home.timezone);
  let view = 'month'; let ym = today.slice(0, 7); let selected = today; let importState = null;
  const root = h('div', { class: 'page accent-blue', id: 'cal-page' }); const body = h('div', { class: 'cal-body', id: 'cal-body' });
  root.append(body); outlet.replaceChildren(root);

  function toolbar() {
    const step = (n) => () => { if (view === 'week') { selected = addDays(selected, 7 * n); ym = selected.slice(0, 7); } else { ym = shiftMonth(ym, n); selected = `${ym}-01`; } render(); };
    return [h('header', { class: 'page-head page-head--row' },
        h('div', null, h('h1', { class: 'page-head__title' }, t('module.calendar.name')), h('p', { class: 'page-head__sub' }, t('calendar.sub'))),
        h('div', { class: 'cl-item__actions cal-head__actions' },
          can('calendar.create') ? h('button', { type: 'button', class: 'btn btn--primary', id: 'cal-new', onClick: () => eventForm({ store, container: root, preset: { startDate: selected } }) }, `＋ ${t('calendar.new')}`) : null,
          can('calendar.create') ? h('button', { type: 'button', class: 'btn btn--secondary', id: 'cal-import', onClick: () => { importState = { text: '', preview: null, fileName: null }; render(); } }, t('calendar.import.open')) : null,
          // V6.4: Calendar settings = compact, labelled gear icon (Calendar only; the app's main Settings is unchanged)
          h('button', { type: 'button', class: 'icon-btn cal-gear', id: 'cal-settings', 'aria-pressed': String(view === 'settings'),
            'aria-label': t('calendar.settings.gear'), title: t('calendar.settings.gear'),
            onClick: () => { view = view === 'settings' ? 'month' : 'settings'; render(); } }, icon('settings', { size: 20 })))),
      h('div', { class: 'cal-toolbar' },
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'cal-prev', 'aria-label': t('calendar.prev'), onClick: step(-1) }, document.dir === 'rtl' ? '›' : '‹'),
        h('span', { class: 'cal-head__title', id: 'cal-label', 'aria-live': 'polite' }, view === 'week' ? `${formatDateShort(weekOf(selected)[0], getLocale())} – ${formatDateShort(weekOf(selected)[6], getLocale())}` : formatMonth(ym, getLocale())),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'cal-next', 'aria-label': t('calendar.next'), onClick: step(1) }, document.dir === 'rtl' ? '‹' : '›'),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: 'cal-today', onClick: () => { ym = today.slice(0, 7); selected = today; render(); } }, t('calendar.today')),
        h('div', { class: 'view-switch', role: 'group', 'aria-label': t('calendar.view') }, ['month', 'week', 'agenda'].map((v) => h('button', { type: 'button', class: 'view-switch__btn', id: `cal-view-${v}`, 'aria-pressed': String(view === v), onClick: () => { view = v; render(); } }, t(`calendar.views.${v}`)))))];
  }

  function weekView(events) {
    return h('div', { class: 'cal-week', id: 'cal-week' }, weekOf(selected).map((d, i) => h('section', { class: `cal-week__day${d === today ? ' cal-cell--today' : ''}`, dataset: { date: d } },
      h('h3', { class: 'cal-agenda__title' }, `${weekdayLabels()[i]} ${formatDateShort(d, getLocale())}`),
      eventsOn(events, d).map((e) => h('p', { class: `cal-chip cal-c-${colorOf(e)}`, dataset: { event: e.id } }, ...titleWithIcon(e), ` · ${timeText(e)}`)))));
  }
  function agendaView(events) {
    const from = `${ym}-01`; const to = addDays(shiftMonth(ym, 1) + '-01', -1);
    const list = inRange(events, from, to).sort((a, b) => a.startDate.localeCompare(b.startDate) || String(a.startTime).localeCompare(String(b.startTime)));
    return list.length ? h('ul', { class: 'fin-list', id: 'cal-agenda-list' }, list.map((e) => h('li', { class: `fin-row${e.done ? ' cal-item--done' : ''}`, dataset: { event: e.id, type: e.type } },
      h('span', { class: `cal-dot cal-c-${colorOf(e)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'fin-row__main', dir: 'auto' }, ...(shiftOf(e) ? [h('span', { class: `cal-t-${colorOf(e)}` }, shiftIcon(shiftOf(e))), ' '] : []), e.title, h('span', { class: 'fin-row__sub' }, [`${formatDateShort(e.startDate, getLocale())}${e.endDate !== e.startDate ? ` – ${formatDateShort(e.endDate, getLocale())}` : ''}`, timeText(e), shiftOf(e) ? t(`calendar.shift.${shiftOf(e)}`) : t(`calendar.type.${e.type}`), e.type === 'task' ? t(e.done ? 'calendar.done' : 'calendar.open') : null].filter(Boolean).join(' · '))),
      h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: () => { selected = e.startDate; ym = selected.slice(0, 7); view = 'month'; render(); } }, t('calendar.show')))))
      : h('p', { class: 'empty', id: 'cal-agenda-empty' }, t('calendar.nothingMonth'));
  }
  /** Vacations + "Unclassified off-duty" suggestions: a gap becomes vacation ONLY on explicit confirmation. */
  function workPanel(events) {
    const vacs = events.filter((e) => e.type === 'vacation').sort((a, b) => b.startDate.localeCompare(a.startDate)).slice(0, 8);
    const gaps = offDutyGaps(events).filter((g) => !g.confirmed).slice(-8).reverse();
    return h('section', { class: 'card fin-card', id: 'cal-work' },
      h('h2', { class: 'card__title' }, t('calendar.workTitle')), h('p', { class: 'field__hint' }, t('calendar.workHint')),
      vacs.length ? h('ul', { class: 'fin-list', id: 'cal-vacs' }, vacs.map((v) => h('li', { class: 'fin-row', dataset: { event: v.id } },
        h('span', { class: 'cal-dot cal-c-green', 'aria-hidden': 'true' }), h('span', { class: 'fin-row__main', dir: 'auto' }, v.title, h('span', { class: 'fin-row__sub' }, `${formatDateShort(v.startDate, getLocale())} – ${formatDateShort(v.endDate, getLocale())}`))))) : null,
      gaps.length ? h('div', null, h('h3', { class: 'cal-agenda__title' }, t('calendar.offDuty')),
        h('ul', { class: 'fin-list', id: 'cal-gaps' }, gaps.map((g) => h('li', { class: 'fin-row', dataset: { gap: `${g.start}_${g.end}` } },
          h('span', { class: 'fin-row__main' }, `${formatDateShort(g.start, getLocale())} – ${formatDateShort(g.end, getLocale())}`, h('span', { class: 'fin-row__sub' }, t('calendar.nDays', { n: g.days }))),
          can('calendar.create') ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'confirm-vacation',
            onClick: async () => { if (!(await confirmDialog({ title: t('calendar.markVacTitle'), message: t('calendar.markVacBody', { from: formatDateLong(g.start, getLocale()), to: formatDateLong(g.end, getLocale()) }), confirmLabel: t('calendar.markVac'), tone: 'primary', container: root }))) return;
              try { await store.create({ title: t('calendar.vacationTitle'), type: 'vacation', allDay: true, startDate: g.start, endDate: g.end }); toast(t('calendar.toast.vacation'), { tone: 'success' }); } catch (e) { toast(msg(e), { tone: 'error' }); } } }, t('calendar.markVac')) : null))))
        : h('p', { class: 'empty' }, t('calendar.noGaps')));
  }

  // ---------------------------------------------------------------- CSV import
  function importView() {
    const s = importState; const all = store.getSnapshot().all;
    // A row re-typed away from Work is explicitly NOT a shift (user override); back to Work re-detects.
    const setType = (r, type) => { r.value.type = type; r.value.shift = type === 'work' ? undefined : null; if (type === 'work') r.value.shift = shiftOf({ title: r.value.title }); };
    const ids = new Set(all.filter(isLive).map((e) => e.id)); const removedIds = new Set(all.filter((e) => !isLive(e)).map((e) => e.id));
    // Rows removed earlier are NOT restored unless ticked one by one (re-import is an explicit choice).
    const preview = () => { try { s.preview = previewImport(s.text, { existingIds: ids, removedIds }); s.error = null; for (const r of s.preview.rows) { r.include = r.ok && !r.duplicate && !r.removed; } s.audience = s.preview.rows.some((r) => r.private) ? 'private' : 'household'; }
      catch (e) { s.preview = null; s.error = msg(e); } render(); };
    const rows = s.preview ? s.preview.rows : [];
    const chosen = rows.filter((r) => r.include);
    return h('section', { class: 'card fin-card', id: 'cal-import-panel' },
      h('h2', { class: 'card__title' }, t('calendar.import.title')), h('p', { class: 'field__hint' }, t('calendar.import.hint')),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('calendar.import.file')),
        h('input', { type: 'file', id: 'cal-imp-file', accept: '.csv,text/csv', class: 'input', onChange: async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 200000) { s.error = t('calendar.import.tooBig'); render(); return; } s.text = await f.text(); s.fileName = f.name; preview(); } })),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('calendar.import.paste')),
        h('textarea', { id: 'cal-imp-text', class: 'input', rows: 4, dir: 'ltr', onInput: (e) => { s.text = e.target.value; s.fileName = null; } }, s.text)),
      h('div', { class: 'cl-item__actions' },
        h('button', { type: 'button', class: 'btn btn--secondary', id: 'cal-imp-preview', onClick: preview }, t('calendar.import.preview')),
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'cal-imp-cancel', onClick: () => { importState = null; render(); } }, t('common.cancel'))),
      s.error ? h('p', { class: 'field__error', role: 'alert', id: 'cal-imp-error' }, s.error) : null,
      s.preview ? h('div', { id: 'cal-imp-preview-box' },
        h('p', { class: 'fm-label', id: 'cal-imp-summary' }, t('calendar.import.summary', { rows: rows.length, blank: s.preview.blank, ok: rows.filter((r) => r.ok).length, dup: rows.filter((r) => r.duplicate).length })),
        h('div', { class: 'fm-filters' },
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('calendar.import.setAll')),
            h('select', { class: 'input', id: 'cal-imp-batch', onChange: (e) => { if (!e.target.value) return; for (const r of rows) if (r.include) setType(r, e.target.value); render(); } },
              h('option', { value: '' }, '—'), ...TYPES.map((k) => h('option', { value: k }, t(`calendar.type.${k}`))))),
          h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('calendar.visibility')),
            h('select', { class: 'input', id: 'cal-imp-aud', onChange: (e) => { s.audience = e.target.value; } },
              h('option', { value: 'private', selected: s.audience === 'private' }, `🔒 ${t('calendar.private')}`), h('option', { value: 'household', selected: s.audience === 'household' }, t('calendar.household'))))),
        h('p', { class: 'field__hint' }, t('calendar.import.privateNote')),
        h('ul', { class: 'fin-list', id: 'cal-imp-rows' }, rows.map((r) => h('li', { class: `fin-row${r.ok ? '' : ' cal-imp-bad'}`, dataset: { line: r.line } },
          h('input', { type: 'checkbox', checked: r.include, disabled: !r.ok || r.duplicate, 'aria-label': t('calendar.import.include', { line: r.line }), onChange: (e) => { r.include = e.target.checked; render(); } }),
          // V6.2.2: detected subtype is shown (icon + colour + label) BEFORE confirmation
          h('span', { class: 'fin-row__main', dir: 'auto' }, `${r.line}. ${r.value.title || '—'}`,
            r.ok && shiftOf(r.value) ? h('span', { class: `cal-imp-shift cal-chip cal-c-${colorOf(r.value)}`, 'data-role': 'shift', dataset: { shift: shiftOf(r.value) } }, shiftIcon(shiftOf(r.value), { decorative: true }), ` ${t(`calendar.shift.${shiftOf(r.value)}`)}`) : null,
            h('span', { class: 'fin-row__sub' }, r.ok ? `${formatDateShort(r.value.startDate, getLocale())} ${r.value.startTime || ''} → ${formatDateShort(r.value.endDate, getLocale())} ${r.value.endTime || ''}${r.duplicate ? ` · ${t('calendar.import.duplicate')}` : ''}${r.removed ? ` · ${t('calendar.import.removedEarlier')}` : ''}${r.private ? ' · 🔒' : ''}`
              : r.errors.map((x) => t(x)).join(' · '))),
          r.ok ? h('select', { class: 'input input--sm', 'aria-label': t('calendar.typeLabel'), 'data-role': 'type', disabled: r.duplicate, onChange: (e) => { setType(r, e.target.value); render(); } },
            TYPES.map((k) => h('option', { value: k, selected: r.value.type === k }, t(`calendar.type.${k}`)))) : null))),
        h('p', { class: 'field__hint' }, t('calendar.import.gapNote')),
        h('button', { type: 'button', class: 'btn btn--primary', id: 'cal-imp-confirm', disabled: !chosen.length,
          onClick: async (e) => { const btn = e.currentTarget; btn.disabled = true;
            let res;
            try {
              res = await store.importRows(chosen, { audience: s.audience, fileName: s.fileName || t('calendar.batch.pasted'), restore: chosen.filter((r) => r.removed).map((r) => r.id),
                onProgress: (p, total) => { btn.textContent = t('calendar.import.progress', { done: p.created + p.restored + p.skipped + p.failed.length, total }); } });
            } catch (x) { toast(msg(x), { tone: 'error' }); btn.disabled = false; return; }
            toast(t(res.failed.length ? 'calendar.import.partial' : 'calendar.import.done', { created: res.created + res.restored, skipped: res.skipped, failed: res.failed.length }), { tone: res.failed.length ? 'error' : 'success' });
            if (importState === s) importState = null;   // a newer import panel opened meanwhile stays open
            render(); } }, t('calendar.import.confirm', { n: chosen.length }))) : null);
  }

  // ---------------------------------------------------------------- Settings → CSV Imports
  const fmtTime = (x) => { const m = x && typeof x.toMillis === 'function' ? x.toMillis() : typeof x === 'string' ? Date.parse(x) : NaN;
    if (!Number.isFinite(m)) return '—'; try { return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: state.home.timezone }).format(new Date(m)); } catch { return new Date(m).toISOString(); } };
  const mayRemove = (b) => can('calendar.delete') && (b.audience === 'household' || b.createdBy === uid);
  function settingsView(snap) {
    const rows = snap.batches.map((b) => {
      const members = batchMembers(snap.all, b.id); const live = members.filter(isLive).length;
      return h('li', { class: 'fin-row fin-row--wrap cal-batch', dataset: { batch: b.id, status: b.status } },
        h('span', { class: 'fin-row__main', dir: 'auto' }, `📄 ${b.fileName}`,
          h('span', { class: 'fin-row__sub' }, [fmtTime(b.createdAt), t('calendar.batch.count', { n: b.createdCount || members.length }), t('calendar.batch.live', { n: live }),
            b.audience === 'private' ? `🔒 ${t('calendar.private')}` : null].filter(Boolean).join(' · '))),
        h('span', { class: `pill${b.status === 'removing' || b.status === 'importing' ? ' pill--warn' : ''}`, 'data-role': 'status' }, t(`calendar.batch.status.${b.status}`)),
        b.status !== 'removed' && mayRemove(b) ? h('button', { type: 'button', class: 'btn btn--danger-ghost btn--sm', 'data-action': 'remove-batch',
          'aria-label': t('calendar.batch.removeX', { name: b.fileName }), onClick: () => removeBatch(b) }, t(b.status === 'removing' ? 'calendar.batch.resume' : 'calendar.batch.remove')) : null);
    });
    return h('section', { class: 'card fin-card', id: 'cal-settings-panel', 'aria-labelledby': 'cal-imports-title' },
      h('h2', { class: 'card__title' }, t('calendar.settings.title')),
      h('h3', { class: 'cal-agenda__title', id: 'cal-imports-title' }, t('calendar.batch.title')),
      h('p', { class: 'field__hint' }, t('calendar.batch.hint')),
      snap.batchStatus === 'error' ? banner('error', t('calendar.batch.loadError')) : null,
      rows.length ? h('ul', { class: 'fin-list', id: 'cal-batches' }, rows) : h('p', { class: 'empty', id: 'cal-batches-empty' }, t('calendar.batch.none')),
      snap.ungrouped.length ? h('details', { class: 'form-section', id: 'cal-ungrouped' },
        h('summary', { class: 'form-section__summary' }, t('calendar.batch.ungrouped', { n: snap.ungrouped.length })),
        h('p', { class: 'field__hint' }, t('calendar.batch.ungroupedHint')),
        h('ul', { class: 'fin-list' }, snap.ungrouped.map((e) => h('li', { class: 'fin-row', dataset: { event: e.id } },
          h('span', { class: `cal-dot cal-c-${colorOf(e)}`, 'aria-hidden': 'true' }),
          h('span', { class: 'fin-row__main', dir: 'auto' }, e.title, h('span', { class: 'fin-row__sub' }, `${formatDateShort(e.startDate, getLocale())}${e.endDate !== e.startDate ? ` – ${formatDateShort(e.endDate, getLocale())}` : ''} · ${t(`calendar.type.${e.type}`)}`)),
          can('calendar.delete') && (e.audience === 'household' || e.createdBy === uid) ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'delete', 'aria-label': t('calendar.deleteX', { title: e.title }),
            onClick: async () => { if (!(await confirmDialog({ title: t('calendar.deleteTitle'), message: t(e.type === 'vacation' ? 'calendar.deleteVacBody' : 'calendar.deleteBody', { title: e.title }), confirmLabel: t('calendar.delete'), container: root }))) return;
              try { await store.remove(e.id); toast(t('calendar.toast.deleted'), { tone: 'success' }); } catch (x) { toast(msg(x), { tone: 'error' }); } } }, '🗑') : null)))) : null);
  }
  /** Scope + impact are stated before anything changes; edited events are kept unless the user opts out. */
  function removeBatch(b) {
    const plan = store.removalPreview(b.id, { keepEdited: false });
    const vac = plan.targets.filter((e) => e.type === 'vacation').length;
    formDialog({ title: t('calendar.batch.removeTitle', { name: b.fileName }), id: 'cal-rm-form', submitLabel: t(b.status === 'removing' ? 'calendar.batch.resume' : 'calendar.batch.remove'), container: root,
      fields: [h('p', { class: 'field__hint', id: 'cal-rm-scope', 'aria-live': 'polite' }, t('calendar.batch.removeBody', { n: plan.targets.length - plan.edited.length })),
        vac ? h('p', { class: 'field__hint', id: 'cal-rm-vac' }, t('calendar.batch.removeVac', { n: vac })) : null,
        plan.edited.length ? h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', id: 'cal-rm-keep', checked: true,
          onChange: (e) => { document.getElementById('cal-rm-scope').textContent = t('calendar.batch.removeBody', { n: plan.targets.length - (e.target.checked ? plan.edited.length : 0) }); } }),
          h('span', null, t('calendar.batch.keepEdited', { n: plan.edited.length }))) : null,
        h('p', { class: 'field__hint' }, t('calendar.batch.removeSafe'))].filter(Boolean),
      onSubmit: async () => {
        const box = document.getElementById('cal-rm-keep'); const keepEdited = box ? box.checked : true;
        await store.removeBatch(b.id, { keepEdited });
        return 'calendar.batch.toast.removed';
      } });
  }

  function render() {
    const snap = store.getSnapshot();
    if (snap.status === 'error') { body.replaceChildren(banner('error', errorText(snap.error))); return; }
    if (snap.status !== 'ready') { body.replaceChildren(h('p', { class: 'muted', role: 'status' }, t('common.loading'))); return; }
    if (view === 'settings') { body.replaceChildren(...[...toolbar(), settingsView(snap)].filter(Boolean)); return; }
    const main = view === 'month'
      ? h('section', { class: 'card fin-card' }, grid({ ym, selected, today, events: snap.events, expanded: true, idPrefix: 'cal', onSelect: (d, kb) => { selected = d; ym = d.slice(0, 7); render(); if (kb) { const c = body.querySelector(`#cal-grid [data-date="${d}"]`); if (c) c.focus(); } } }), legend(),
        agenda({ store, date: selected, events: snap.events, can, uid, container: root }))
      : h('section', { class: 'card fin-card' }, view === 'week' ? weekView(snap.events) : agendaView(snap.events));
    body.replaceChildren(...[...toolbar(), importState ? importView() : null, main, workPanel(snap.events)].filter(Boolean));
  }
  const off = store.subscribe(() => { if (!importState || !importState.preview) render(); });
  return () => off();
}
