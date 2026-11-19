/**
 * Cleaning (#/m/cleaning; the old #/m/cleaning/advanced opens the same page) — Phase 5.4a, V6.3 default.
 * Built ONLY on HomeHub's shared cleaning store (same auth, household, tasks, occurrences, audit log).
 * Every write is awaited (server-confirmed) before success is shown.
 * V6.3: no Claim step (eligible members complete directly; claimed records stay completable), Mark All
 * Done on exactly the items a routine shows, a "Tasks" tab (task management) and two task-only resets
 * in Settings (progress / default tasks) — rooms and devices are never written from here.
 */
import { h } from '../../core/utils/dom.js';
import { t, formatNumber } from '../../core/i18n/i18n.js';
import { banner, errorText } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { formDialog } from '../expenses/dialogs.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { addDays, formatDateLong } from '../expenses/calendar.js';
import { getCleaningStore } from './cleaning-service.js';
import { getRoomsStore } from '../rooms/rooms-service.js';
import { getDevicesStore } from '../devices/devices-service.js';
import { buildBoard, mayAct, POSTPONE_MAX_DAYS, MINUTES_MAX, deviceIndex, resetAllItems } from './cleaning-model.js';
import { sourceActive, effectiveRoomId } from './cleaning-integration.js';
import { createTemplateViews } from './advanced-templates.js';
import { completableItems, progressResetPlan, restoreDefaultsPlan } from './cleaning-ops.js';
import { takeCleaningFocus } from './cleaning-focus.js';
import { openTaskForm as openSharedTaskForm } from './task-form.js';
import { settingsOf, validateSettings, routineDate, buildRoutinePlan, routineView, routineSummary, quickPick, computeStats, DEFAULT_MINUTES, SETTINGS_LIMITS } from './cleaning-advanced.js';

const TABS = ['routine', 'quick', 'rooms', 'devices', 'tasks', 'templates', 'import', 'stats', 'settings'];   // 5.4b: + devices; 5.4c: + templates, import; V6.3: + tasks
const amsg = (e) => (e && e.detail && /^cleaning\./.test(String(e.detail).split(',')[0]) ? t(String(e.detail).split(',')[0]) : errorText(e));

export function mountAdvanced(outlet, ctx, opts = {}) {
  const state = ctx.getState();
  const { identity, home, permissions, membership } = state;
  const can = (p) => permissions.can(p);
  const isChild = membership.roleId === 'child' || membership.relationship === 'child';
  const tz = home.timezone;
  const locale = state.profile && state.profile.language === 'ar' ? 'ar-EG' : 'en-GB';
  let store; let rooms = null; let devices = null;
  try { store = getCleaningStore(ctx); } catch (err) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err)))); return () => {}; }
  try { rooms = getRoomsStore(ctx); } catch { rooms = null; }
  try { devices = getDevicesStore(ctx); } catch { devices = null; }
  const cur = { ex: {} };   // Phase 5.4b: device-trigger extras of the item being acted on
  const pendingUse = new Map();   // deviceId → eventId kept until confirmed (retry never duplicates)
  let dir = null; let tab = 'routine'; let creating = null; let quickMin = 15; let roomOpen = null; let statsDays = 7; let stats = null; let statsBusy = false;
  const offs = [];
  let tplViews = null;   // Phase 5.4c (created after the helpers below exist)
  // V6.3 deep links: Device Details → Tasks tab (device filter / new task); Reminders → Today's Routine
  // (due today) or Rooms (overdue: every pending item, grouped by room).
  const focus = takeCleaningFocus(home.id);
  if (focus && (focus.deviceId || focus.openNew)) tab = 'tasks';
  else if (focus && focus.view === 'overdue') tab = 'rooms';
  let tasksHost = null; let tasksOff = null;   // the Tasks tab keeps its own state across re-renders
  let bulk = null;   // { scope, label } Mark All Done progress / result line
  import('../../core/family/family-service.js').then((fam) => { try { const f = fam.getFamilyStore(ctx); offs.push(f.subscribe(() => { dir = f.directory(); render(); })); } catch { /* none */ } });
  const nameOf = (uid) => (uid === identity.uid ? t('settings.you') : !dir ? '…' : dir.nameOf(uid, t('family.formerMember')) || t('family.formerMember'));
  const roomList = () => { const s = rooms ? rooms.getSnapshot() : null; return (s && s.rooms) || []; };
  const deviceList = () => { const s = devices ? devices.getSnapshot() : null; return (s && s.devices) || []; };
  const roomById = (id) => roomList().find((x) => x.id === id) || null;
  const deviceById = (id) => deviceList().find((x) => x.id === id) || null;
  const visible = (tk) => sourceActive(tk, { roomById, deviceById });
  const roomOf = (tk) => effectiveRoomId(tk, { deviceById });
  const roomLabel = (id) => { const r = id && roomById(id); return r ? r.name : t('cleaning.noRoom'); };
  const est = (tk) => (Number.isInteger(tk.estimatedMinutes) ? tk.estimatedMinutes : DEFAULT_MINUTES);

  const root = h('div', { class: 'page page--cleaning page--cleaning-adv accent-sky', id: 'cl-adv' });
  const head = h('header', { class: 'page-head page-head--row' });
  const tabsEl = h('div', { class: 'view-switch view-switch--scroll', role: 'tablist', 'aria-label': t('module.cleaning.name') });
  const body = h('div', { class: 'cl-body', id: 'cl-adv-body' });
  root.append(head, tabsEl, body);
  outlet.replaceChildren(root);

  const settingsNow = () => settingsOf(store.getSnapshot().settings);
  const day = () => routineDate(tz, settingsNow().startHour);
  const boardFor = (d) => { const s = store.getSnapshot(); return buildBoard({ tasks: s.tasks, occurrences: s.occurrences, today: d, uid: identity.uid, can, isChild, tz, isVisible: visible, roomOf,
    deviceEvents: s.deviceEvents || [], deviceStates: s.deviceStates || new Map() }); };

  async function act(taskId, date, action, notes, extra, okKey) {
    extra = { ...(cur.ex || {}), ...(extra || {}) };
    try { await store.act(taskId, date, action, notes, extra); toast(t(okKey || `cleaning.toast.${action}`), { tone: 'success' }); return true; }   // after the server confirmed
    catch (e) { toast(amsg(e), { tone: 'error' }); return false; }
  }
  function doneDialog(task, date) {
    formDialog({ title: t('cleaning.completeTitle', { title: task.title }), id: 'cl-adv-done', submitLabel: t('cleaning.done'), container: root,
      fields: [h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.adv.minutes', { est: est(task) })),
        h('input', { id: 'cl-adv-min', class: 'input', type: 'number', min: 1, max: MINUTES_MAX, inputmode: 'numeric', placeholder: String(est(task)) })),
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.notesOptional')), h('textarea', { id: 'cl-adv-notes', class: 'input', rows: 2, dir: 'auto' }))],
      onSubmit: async () => {
        const m = root.querySelector('#cl-adv-min').value.trim();
        const ok = await act(task.id, date, 'complete', root.querySelector('#cl-adv-notes').value, { minutes: m === '' ? null : Number(m) });
        return ok ? null : false;
      } });
  }
  function postponeDialog(task, date) {
    const d = day();
    formDialog({ title: t('cleaning.adv.postponeTitle', { title: task.title }), id: 'cl-adv-postpone', submitLabel: t('cleaning.adv.postpone'), container: root,
      fields: [h('p', { class: 'fin-callout' }, t('cleaning.adv.postponeExplain', { n: POSTPONE_MAX_DAYS })),
        h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.adv.newDate')),
          h('input', { id: 'cl-adv-pdate', class: 'input', type: 'date', min: addDays(d, 1), max: addDays(d, POSTPONE_MAX_DAYS), value: addDays(d, 1) }))],
      onSubmit: async () => (await act(task.id, date, 'postpone', null, { postponedTo: root.querySelector('#cl-adv-pdate').value, today: d })) ? null : false });
  }


  /** Actions for one planned/visible occurrence, by LIVE status and the user's rights. */
  function actionsFor(task, date, occ, ex = {}) {
    const st = occ ? occ.status : 'open'; const d = day(); const eligible = mayAct(task, { uid: identity.uid, can, isChild });
    const B = (key, act_, cls = 'btn--secondary') => h('button', { type: 'button', class: `btn ${cls} btn--sm`, 'data-action': key, onClick: () => { cur.ex = ex; act_(); } }, t(`cleaning.adv.act.${key}`));
    const out = [];
    if (['open', 'skipped', 'postponed'].includes(st) && eligible) out.push(B('complete', () => act(task.id, date, 'complete'), 'btn--primary'), B('completeTime', () => doneDialog(task, date), 'btn--ghost'));
    // V6.3: no Claim / Release — a claimed record (older data) is simply completable by anyone eligible.
    if (st === 'claimed' && (eligible || occ.claimedBy === identity.uid || can('cleaning.edit'))) out.push(B('complete', () => act(task.id, date, 'complete'), 'btn--primary'), B('completeTime', () => doneDialog(task, date), 'btn--ghost'));
    if (['open', 'skipped'].includes(st) && eligible && !(st === 'skipped' && occ.skippedOn === d)) out.push(B('skip', () => act(task.id, date, 'skip', null, { today: d })), B('postpone', () => postponeDialog(task, date)));
    if (['skipped', 'postponed'].includes(st) && (occ.updatedBy === identity.uid || eligible || can('cleaning.edit'))) out.push(B('resume', () => act(task.id, date, 'resume')));
    if (st === 'done' && (occ.completedBy === identity.uid || can('cleaning.edit'))) out.push(B('reopen', () => act(task.id, date, 'reopen'), 'btn--ghost'));   // V6.1: no required note
    return out;
  }
  const statusText = (occ, d) => (!occ ? '' : occ.status === 'done' ? t('cleaning.doneBy', { name: nameOf(occ.completedBy) }) + (Number.isInteger(occ.actualMinutes) ? ` · ${t('cleaning.adv.took', { n: occ.actualMinutes })}` : '')
    : occ.status === 'claimed' ? t('cleaning.claimedBy', { name: nameOf(occ.claimedBy) })
    : occ.status === 'skipped' ? (occ.skippedOn === d ? t('cleaning.adv.skippedToday') : t('cleaning.adv.skippedOn', { date: formatDateLong(occ.skippedOn, locale) }))
    : occ.status === 'postponed' ? t('cleaning.adv.postponedTo', { date: formatDateLong(occ.postponedTo, locale) }) : '');
  // Phase 5.4d: the shared New / Edit form (same as Basic).
  const openForm = (task, preset = null) => openSharedTaskForm({ root, store, identity, dir, roomList, deviceList, today: day, errorText }, task, preset);
  const exOf = (it) => (it && it.occId ? { occId: it.occId, triggerEventId: it.triggerEventId || null, triggerSeasonRev: Number.isInteger(it.triggerSeasonRev) ? it.triggerSeasonRev : null } : {});
  const row = (task, date, occ, state = occ ? occ.status : 'open', ex = {}, uses = 0) => h('li', { class: `cl-item cl-item--${state} cl-item--${task.priority}`, dataset: { task: task.id, date, status: state, occ: ex.occId || '' } },
    h('div', { class: 'cl-item__main' },
      h('p', { class: 'cl-item__title' }, task.title, task.priority === 'high' ? h('span', { class: 'pill pill--warn' }, t('cleaning.priority.high')) : null),
      h('p', { class: 'cl-item__meta' }, [roomLabel(roomOf(task)), date !== day() ? formatDateLong(date, locale) : null, `~${est(task)} ${t('cleaning.adv.min')}`, statusText(occ, day())].filter(Boolean).join(' · '))),
    uses > 1 ? h('p', { class: 'cl-item__missed' }, t('cleaning.device.usesSince', { n: uses })) : null,
    h('div', { class: 'cl-item__actions' }, ...actionsFor(task, date, occ, ex),
      can('cleaning.edit') && task.active ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'edit', onClick: () => openForm(task) }, t('cleaning.editAction')) : null));

  // ---------------------------------------------------------------- V6.3 Mark All Done
  /**
   * Exactly the pending items `shown` (the routine's list, or the Quick pick for the chosen minutes):
   * count shown, disabled at 0, scope confirmed, ids captured at confirmation, re-validated at commit.
   */
  function markAllBar(scope, shown, scopeLabel) {
    const sel = completableItems(shown, { uid: identity.uid, can, isChild });
    const busy = store.bulkBusy();
    return h('div', { class: 'cl-markall', id: `cl-markall-${scope}`, role: 'group', 'aria-label': t('cleaning.bulk.title') },
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: `cl-markall-btn-${scope}`, disabled: !sel.length || busy, 'aria-disabled': String(!sel.length || busy),
        onClick: () => confirmMarkAll(scope, sel, scopeLabel) }, t('cleaning.bulk.markAll', { n: sel.length })),
      bulk && bulk.scope === scope ? h('p', { class: 'cl-setup__progress', id: `cl-markall-status-${scope}`, role: 'status', 'aria-live': 'polite' }, bulk.text) : null);
  }
  async function confirmMarkAll(scope, sel, scopeLabel) {
    const captured = sel.slice();   // the exact items confirmed — never recomputed from filters later
    if (!(await confirmDialog({ title: t('cleaning.bulk.confirmTitle'), message: t('cleaning.bulk.confirmBody', { n: captured.length, scope: scopeLabel }), confirmLabel: t('cleaning.bulk.confirm', { n: captured.length }), container: root }))) return;
    if (store.bulkBusy()) return;
    bulk = { scope, text: t('cleaning.setup.progress', { saved: 0, total: captured.length }) }; render();
    let res;
    try {
      res = await store.completeSelection(captured, { can, isChild, onProgress: (r) => { bulk = { scope, text: t('cleaning.setup.progress', { saved: r.saved + r.already, total: r.total }) }; const el = root.querySelector(`#cl-markall-status-${scope}`); if (el) el.textContent = bulk.text; } });
    } catch (e) { bulk = null; toast(amsg(e), { tone: 'error' }); render(); return; }
    bulk = { scope, text: t(res.failed.length ? 'cleaning.bulk.partial' : 'cleaning.bulk.done', { saved: res.saved, already: res.already, skipped: res.skipped, failed: res.failed.length }) };
    toast(bulk.text, { tone: res.failed.length ? 'error' : 'success' });   // re-run = retry of what is still pending
    render();
  }

  // ---------------------------------------------------------------- tabs
  function routineTab(snap) {
    const d = day(); const s = settingsNow();
    // B0 fix: never pair one day's routine with another day's board (and so never create a routine for it).
    if (snap.routine === undefined || snap.routineDay !== d) return h('p', { class: 'muted', role: 'status' }, t('common.loading'));
    const board = boardFor(d);
    let plan = snap.routine && snap.routine.items;
    const canSave = can('cleaning.complete') || can('cleaning.create');
    if (!plan) {
      plan = buildRoutinePlan({ board, today: d, catchUpMax: s.catchUpMax });
      if (canSave && creating !== d) {
        creating = d;   // save once; a concurrent first viewer's plan wins (create-only)
        store.createRoutine(d, plan, s).catch((e) => { creating = null; toast(amsg(e), { tone: 'error' }); });
      }
    }
    // V6.4: obsolete plan keys (reset / archived / removed) are not current work — see routineView.
    const view = routineView({ plan, tasks: snap.tasks, occurrences: snap.occurrences, board, isVisible: visible });
    const items = view.items;
    const extraItems = view.extras;   // done ones stay visible (who did it, Reopen)
    const extra = extraItems.length;
    const shown = view.shown;
    // V6.4.0-a review: text, bar and empty state all come from ONE summary over exactly what is shown.
    const sum = routineSummary(view); const pct = sum.pct;
    const progText = sum.kind === 'progress' ? t('cleaning.adv.routineProgress', { done: sum.done, total: sum.total })
      : sum.kind === 'settled' ? t('cleaning.adv.routineSettled', { skipped: sum.skipped, postponed: sum.postponed }) : t('cleaning.nothingToday');
    return h('div', { id: 'cl-adv-routine', dataset: { summary: sum.kind } },
      h('div', { class: 'cl-progress', role: 'status', 'aria-live': 'polite' },
        h('p', { class: 'cl-progress__text', id: 'cl-adv-progress', dataset: { done: String(sum.done), total: String(sum.total) } }, progText),
        h('div', { class: 'cl-progress__bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-valuetext': progText }, h('span', { style: `width:${pct}%` }))),
      snap.routine ? null : h('p', { class: 'field__hint', id: 'cl-adv-unsaved' }, t(canSave ? 'cleaning.adv.saving' : 'cleaning.adv.preview')),
      shown.length ? markAllBar('routine', shown, t('cleaning.bulk.scopeRoutine')) : null,
      items.length ? h('ul', { class: 'cl-list', id: 'cl-adv-list' }, items.map((it) => row(it.task, it.date, it.occ, undefined, exOf(it))))
        : sum.kind === 'empty' ? h('p', { class: 'empty', id: 'cl-adv-empty' }, t('cleaning.nothingToday')) : null,
      view.obsolete.length ? h('p', { class: 'field__hint cl-adv-obsolete', id: 'cl-adv-obsolete', dataset: { n: String(view.obsolete.length) } }, t('cleaning.adv.obsolete', { n: view.obsolete.length })) : null,
      extra ? h('section', { class: 'cl-adv-extra', id: 'cl-adv-extra', 'aria-labelledby': 'cl-adv-extra-title' },
        h('h3', { class: 'cl-adv-extra__title', id: 'cl-adv-extra-title' }, t('cleaning.adv.notInPlan', { n: extra })),
        h('ul', { class: 'cl-list', id: 'cl-adv-extra-list' }, extraItems.map((it) => row(it.task, it.date, it.occ, undefined, exOf(it), it.usesSince || 0)))) : null,
      !snap.tasks.some((x) => x.active === true) && can('cleaning.create') ? h('p', { class: 'field__hint', id: 'cl-adv-goto-tasks' },
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onClick: () => { tab = 'tasks'; render(); } }, t('cleaning.adv.gotoTasks'))) : null);
  }
  function actionable(snap) {
    const d = day(); const b = boardFor(d);
    return [...b.overdue, ...b.today].filter((it) => !(it.occ && (it.occ.status === 'done' || (it.occ.status === 'skipped' && it.occ.skippedOn === d))) && mayAct(it.task, { uid: identity.uid, can, isChild }));
  }
  function quickTab(snap) {
    const pick = quickPick(actionable(snap), quickMin);
    return h('div', { id: 'cl-adv-quick' },
      h('p', { class: 'field__hint' }, t('cleaning.adv.quickExplain')),
      h('div', { class: 'cl-chips' }, [5, 10, 15, 30, 45, 60].map((m) => h('button', { type: 'button', class: `btn btn--sm ${m === quickMin ? 'btn--primary' : 'btn--secondary'}`, 'data-min': m, 'aria-pressed': String(m === quickMin), onClick: () => { quickMin = m; render(); } }, t('cleaning.adv.minChip', { n: m })))),
      pick.items && pick.items.length ? h('div', null, h('p', { class: 'cl-progress__text', id: 'cl-adv-quick-sum' }, t('cleaning.adv.quickSum', { n: pick.items.length, m: pick.minutes })),
        markAllBar('quick', pick.items, t('cleaning.bulk.scopeQuick', { m: quickMin })),
        h('ul', { class: 'cl-list' }, pick.items.map((it) => row(it.task, it.date, it.occ, undefined, exOf(it), it.usesSince || 0)))) : h('p', { class: 'empty' }, t('cleaning.adv.quickNone')));
  }
  function roomsTab(snap) {
    const all = actionable(snap);
    const groups = new Map();
    for (const it of all) { const r = roomOf(it.task) || 'none'; if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it); }
    // V6.1: a room whose tasks are all done still appears, so it can be reset.
    const b = boardFor(day()); const ropts = { uid: identity.uid, can, isChild, roomOf: (tk) => roomOf(tk) || 'none' };
    const resets = new Map();
    for (const it of [...b.overdue, ...b.today]) { const r = roomOf(it.task) || 'none'; if (!resets.has(r)) { const items = resetAllItems(b, r, ropts); if (items.length) resets.set(r, items); } }
    for (const r of resets.keys()) if (!groups.has(r)) groups.set(r, []);
    if (!groups.size) return h('p', { class: 'empty', id: 'cl-adv-rooms-empty' }, t('cleaning.adv.roomsNone'));
    return h('ul', { class: 'cl-list', id: 'cl-adv-rooms' }, [...groups.entries()].map(([rid, list]) => {
      const mins = list.reduce((n, it) => n + est(it.task), 0); const open = roomOpen === rid;
      return h('li', { class: 'cl-room', dataset: { room: rid } },
        h('button', { type: 'button', class: 'cl-room__head', 'aria-expanded': String(open), onClick: () => { roomOpen = open ? null : rid; render(); } },
          h('strong', null, rid === 'none' ? t('cleaning.noRoom') : roomLabel(rid)), h('span', { class: 'muted' }, t('cleaning.adv.roomSum', { n: list.length, m: mins }))),
        open ? h('div', { class: 'cl-room__body' },
          h('ul', { class: 'cl-list' }, list.map((it) => row(it.task, it.date, it.occ, undefined, exOf(it), it.usesSince || 0))),
          h('p', { class: 'cl-setup__progress', id: `cl-adv-room-progress-${rid}`, role: 'status', 'aria-live': 'polite', hidden: true }),
          list.length ? h('button', { type: 'button', class: 'btn btn--primary', id: `cl-adv-room-all-${rid}`, onClick: (e) => doneAll(e.currentTarget, rid, list) }, t('cleaning.adv.doneAll', { n: list.length }))
            : h('p', { class: 'muted' }, t('cleaning.room.nothingPending')),
          resets.has(rid) ? h('button', { type: 'button', class: 'btn btn--ghost', id: `cl-adv-room-reset-${rid}`, onClick: async (e) => { const btn = e.currentTarget;
            const name = rid === 'none' ? t('cleaning.noRoom') : roomLabel(rid); const items = resets.get(rid);
            if (!(await confirmDialog({ title: t('cleaning.room.resetTitle', { room: name }), message: t('cleaning.room.resetBody', { n: items.length, room: name }), confirmLabel: t('cleaning.room.reset') }))) return;
            resetAll(btn, rid, items); } }, t('cleaning.room.resetAll', { n: resets.get(rid).length })) : null) : null);
    }));
  }
  async function resetAll(btn, rid, items) {   // V6.1: sequential inverse actions; partial-failure report; re-run = retry
    btn.disabled = true;
    const p = root.querySelector(`#cl-adv-room-progress-${rid}`);
    const res = await store.actMany(items, null, { onProgress: (r) => { if (p) { p.hidden = false; p.textContent = t('cleaning.setup.progress', { saved: r.saved, total: r.total }); } } });
    btn.disabled = false;
    if (!res.failed.length) toast(t('cleaning.room.resetDone', { n: res.saved }), { tone: 'success' });
    else toast(t('cleaning.room.partial', { saved: res.saved, total: res.total, failed: res.failed.length }), { tone: 'error' });
  }
  async function doneAll(btn, rid, list) {
    btn.disabled = true;
    const p = root.querySelector(`#cl-adv-room-progress-${rid}`);
    const res = await store.actMany(list.map((it) => ({ taskId: it.task.id, date: it.date, extra: exOf(it) })), 'complete', {
      onProgress: (r) => { if (p) { p.hidden = false; p.textContent = t('cleaning.setup.progress', { saved: r.saved, total: r.total }); } } });
    btn.disabled = false;
    if (!res.failed.length) toast(t('cleaning.adv.doneAllOk', { n: res.saved }), { tone: 'success' });
    else toast(t('cleaning.adv.doneAllPartial', { saved: res.saved, total: res.total, failed: res.failed.length }), { tone: 'error' });
  }
  // ---------------------------------------------------------------- V6.3: Tasks (task management)
  function tasksTab() {
    if (!tasksHost) {
      tasksHost = h('div', { id: 'cl-adv-tasks' });
      import('./page.js').then((m) => { tasksOff = m.mountTaskManager(tasksHost, ctx, { focus: focus && (focus.deviceId || focus.openNew || focus.highlightTaskId) ? focus : null }); });
    }
    return tasksHost;
  }
  // ---------------------------------------------------------------- Phase 5.4b: devices
  function devicesTab(snap) {
    store.watchDevices();
    if (!devices) return h('p', { class: 'empty' }, t('cleaning.device.noAccess'));
    const list = deviceList().filter((d) => d.active !== false);
    if (!list.length) return h('p', { class: 'empty', id: 'cl-adv-devices-empty' }, t('cleaning.device.none'));
    const idx = deviceIndex(snap.deviceEvents || [], snap.deviceStates || new Map(), tz, day());
    const b = boardFor(day());
    const due = [...b.overdue, ...b.today].filter((it) => it.task.trigger && !(it.occ && it.occ.status === 'done'));
    return h('ul', { class: 'cl-list', id: 'cl-adv-devices' }, list.map((d) => {
      const tasks = snap.tasks.filter((x) => x.active === true && x.trigger && x.trigger.deviceId === d.id);
      const seasonal = tasks.some((x) => x.trigger.kind === 'seasonal'); const usage = tasks.some((x) => x.trigger.kind === 'afterUse');
      const st = idx.state(d.id); const uses = idx.uses(d.id).slice(-5).reverse();
      const mine = due.filter((it) => it.task.trigger.deviceId === d.id);
      return h('li', { class: 'cl-room', dataset: { device: d.id } },
        h('div', { class: 'cl-room__head' }, h('strong', null, d.name), h('span', { class: 'muted' }, [roomLabel(d.roomId), seasonal ? t(st.state === 'active' ? 'cleaning.device.inSeason' : 'cleaning.device.offSeason') : null].filter(Boolean).join(' · '))),
        h('div', { class: 'cl-room__body' },
          h('div', { class: 'cl-item__actions' },
            can('cleaning.complete') ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: `cl-dev-use-${d.id}`, onClick: (e) => logUse(e.currentTarget, d) }, t('cleaning.device.logUse')) : null,
            seasonal && can('cleaning.edit') ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: `cl-dev-season-${d.id}`, onClick: (e) => toggleSeason(e.currentTarget, d, st) }, t(st.state === 'active' ? 'cleaning.device.endSeason' : 'cleaning.device.startSeason')) : null,
            seasonal ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: () => seasonHistory(d) }, t('cleaning.device.seasonHistory')) : null,
            can('cleaning.create') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: `cl-dev-task-${d.id}`, onClick: () => openForm(null, { deviceId: d.id }) }, t('cleaning.device.addTask')) : null,
            can('cleaning.create') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', id: `cl-dev-add-${d.id}`, onClick: () => addAfterUse(d) }, t('cleaning.device.addAfterUse')) : null),
          !usage && !seasonal ? h('p', { class: 'field__hint' }, t('cleaning.device.noTriggered')) : null,
          mine.length ? h('ul', { class: 'cl-list', id: `cl-dev-due-${d.id}` }, mine.map((it) => row(it.task, it.date, it.occ, undefined, exOf(it), it.usesSince || 0))) : null,
          uses.length ? h('details', { class: 'form-section' }, h('summary', { class: 'form-section__summary' }, t('cleaning.device.recentUses', { n: uses.length })),
            h('ul', { class: 'fin-list', id: `cl-dev-uses-${d.id}` }, uses.map((u) => h('li', { class: 'fin-row', dataset: { event: u.id } },
              h('span', { class: 'fin-row__date' }, new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(u.ms))),
              h('span', { class: 'fin-row__main' }, nameOf(u.actorUid), u.note ? h('span', { class: 'fin-row__sub', dir: 'auto' }, u.note) : null),
              can('cleaning.complete') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'data-action': 'void', onClick: () => voidUse(d, u) }, t('cleaning.device.void')) : null)))) : null));
    }));
  }
  async function logUse(btn, d) {
    btn.disabled = true;
    if (!pendingUse.has(d.id)) pendingUse.set(d.id, store.newEventId());   // one id per attempt; reused on retry
    try { await store.logUse(d.id, { eventId: pendingUse.get(d.id) }); pendingUse.delete(d.id); toast(t('cleaning.device.useLogged'), { tone: 'success' }); }
    catch (e) { toast(t('cleaning.device.useRetry'), { tone: 'error' }); }
    btn.disabled = false;
  }
  async function voidUse(d, u) {
    try { await store.voidUse(d.id, u.id); toast(t('cleaning.device.voided'), { tone: 'success' }); } catch (e) { toast(amsg(e), { tone: 'error' }); }
  }
  async function toggleSeason(btn, d, st) {
    btn.disabled = true;
    try { await store.setSeason(d.id, st.state === 'active' ? 'inactive' : 'active'); toast(t('cleaning.device.seasonSaved'), { tone: 'success' }); }
    catch (e) { toast(amsg(e), { tone: 'error' }); }
    btn.disabled = false;
  }
  async function seasonHistory(d) {
    const listEl = h('ul', { class: 'fin-list', id: 'cl-dev-season-list' }, h('li', null, t('common.loading')));
    const { openDialog } = await import('../../ui/components/dialog.js');
    openDialog({ title: t('cleaning.device.seasonHistory'), content: listEl, container: root });
    try {
      const log = (await store.seasonHistory(d.id)).sort((a, b) => b.rev - a.rev);
      listEl.replaceChildren(...(log.length ? log.map((x) => h('li', { class: 'fin-row' }, h('span', { class: 'fin-row__main' }, `${t(x.state === 'active' ? 'cleaning.device.inSeason' : 'cleaning.device.offSeason')} · ${nameOf(x.actorUid)}`))) : [h('li', null, t('cleaning.device.noSeasons'))]));
    } catch (e) { listEl.replaceChildren(h('li', null, errorText(e))); }
  }
  function addAfterUse(d) {
    formDialog({ title: t('cleaning.device.addAfterUseTitle', { name: d.name }), id: 'cl-dev-add-form', submitLabel: t('common.save'), container: root,
      fields: [h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.title')), h('input', { id: 'cl-dev-add-title', class: 'input', maxlength: 80, required: true, dir: 'auto' })),
        h('p', { class: 'field__hint' }, t('cleaning.device.addAfterUseHint'))],
      onSubmit: async () => {
        try {
          await store.createTask({ title: root.querySelector('#cl-dev-add-title').value, assignMode: 'shared', recurrence: { kind: 'onUse' }, startDate: day(), trigger: { kind: 'afterUse', deviceId: d.id } }, { memberUids: dir ? dir.active().map((m) => m.uid) : [] });
        } catch (e) { toast(amsg(e), { tone: 'error' }); return false; }
        return 'cleaning.toast.created';
      } });
  }

  function statsTab(snap) {
    if (!stats && !statsBusy) loadStats();
    const box = (k, v) => h('div', { class: 'fin-stat' }, h('span', { class: 'fin-stat__label' }, t(`cleaning.adv.stat.${k}`)), h('span', { class: 'fin-stat__value', id: `cl-adv-stat-${k}` }, String(v)));
    // V6.4: same ranking (top 8, highest first) — now as wrapped rows (name · relative bar · count) so long
    // names never collide with the number; an empty list says so instead of leaving a bare heading.
    const top = (obj, label) => { const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 8); const max = rows.length ? rows[0][1] : 0;
      return rows.map(([k, v]) => h('li', { class: 'cl-stat-row', dataset: { key: k } },
        h('span', { class: 'cl-stat-row__name', dir: 'auto' }, label(k)),
        h('span', { class: 'cl-stat-row__value' }, formatNumber(v)),
        h('span', { class: 'cl-stat-row__bar', 'aria-hidden': 'true' }, h('span', { style: `inline-size:${max > 0 ? Math.max(4, Math.round((v / max) * 100)) : 0}%` })))); };
    const group = (id, title, list) => h('section', { class: 'cl-stat-group', 'aria-labelledby': `${id}-title` },
      h('h3', { class: 'cl-stat-group__title', id: `${id}-title` }, title),
      list.length ? h('ul', { class: 'cl-stat-list', id }, list) : h('p', { class: 'empty cl-stat-empty', id }, t('cleaning.adv.statsNone')));
    return h('div', { id: 'cl-adv-stats', class: 'cl-stats' },
      h('div', { class: 'cl-chips' }, [7, 30].map((n) => h('button', { type: 'button', class: `btn btn--sm ${n === statsDays ? 'btn--primary' : 'btn--secondary'}`, 'data-days': n, onClick: () => { statsDays = n; stats = null; render(); } }, t('cleaning.adv.lastDays', { n })))),
      !stats ? h('p', { class: 'muted', role: 'status' }, t('common.loading')) : stats.error ? banner('error', stats.error) : h('div', { class: 'cl-stats__body' },
        h('div', { class: 'fin-stats cl-stats__grid' }, box('completions', stats.completions), box('minutes', stats.minutes), box('skips', stats.skips), box('postpones', stats.postpones), box('reopens', stats.reopens)),
        h('div', { class: 'cl-stat-groups' },
          group('cl-adv-by-member', t('cleaning.adv.byMember'), top(stats.byMember, nameOf)),
          group('cl-adv-by-room', t('cleaning.adv.byRoom'), top(stats.byRoom, (r) => (r === 'none' ? t('cleaning.noRoom') : roomLabel(r)))))));
  }
  async function loadStats() {
    statsBusy = true;
    try {
      const d = day(); const since = new Date(Date.parse(`${addDays(d, -statsDays)}T00:00:00Z`));
      const log = await store.loadLogSince(since);
      stats = computeStats({ log, tasks: store.getSnapshot().tasks, tz, roomOf, days: statsDays, today: d });
    } catch (e) { stats = { error: errorText(e) }; }
    statsBusy = false; render();
  }
  function settingsTab(snap) {
    const s = settingsNow(); const editable = can('cleaning.edit');
    const inp = (k) => h('input', { id: `cl-adv-set-${k}`, class: 'input', type: 'number', min: SETTINGS_LIMITS[k][0], max: SETTINGS_LIMITS[k][1], value: s[k], disabled: !editable, inputmode: 'numeric' });
    return h('div', { id: 'cl-adv-settings' },
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.adv.catchUpMax')), inp('catchUpMax'), h('span', { class: 'field__hint' }, t('cleaning.adv.catchUpHint'))),
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('cleaning.adv.startHour')), inp('startHour'), h('span', { class: 'field__hint' }, t('cleaning.adv.startHourHint'))),
      editable ? h('button', { type: 'button', class: 'btn btn--primary', id: 'cl-adv-set-save', onClick: async (e) => {
        const { value, errors } = validateSettings({ catchUpMax: root.querySelector('#cl-adv-set-catchUpMax').value, startHour: root.querySelector('#cl-adv-set-startHour').value });
        if (Object.keys(errors).length) { toast(t(Object.values(errors)[0]), { tone: 'error' }); return; }
        const btn = e.currentTarget; btn.disabled = true;   // V6.3 fix: currentTarget is null after an await
        try { await store.saveSettings(value); toast(t('cleaning.adv.settingsSaved'), { tone: 'success' }); } catch (err) { toast(amsg(err), { tone: 'error' }); }
        btn.disabled = false;
      } }, t('common.save')) : h('p', { class: 'field__hint' }, t('cleaning.adv.settingsReadOnly')),
      resetSection());
  }
  // ---------------------------------------------------------------- V6.3: task-only resets
  let resetState = null;   // { kind, text, tone, retry } — last outcome; retry repeats ONLY failed steps
  const mayReset = () => can('cleaning.edit');
  const mayRestore = () => can('cleaning.edit') && can('cleaning.create') && can('cleaning.delete');
  function resetSection() {
    return h('section', { class: 'card fin-card cl-reset', id: 'cl-adv-reset', 'aria-labelledby': 'cl-reset-title' },
      h('h3', { class: 'card__title', id: 'cl-reset-title' }, t('cleaning.reset.title')),
      h('p', { class: 'field__hint' }, t('cleaning.reset.scope')),
      h('div', { class: 'cl-reset__item' },
        h('div', null, h('strong', null, t('cleaning.reset.progressTitle')), h('p', { class: 'field__hint' }, t('cleaning.reset.progressHint'))),
        h('button', { type: 'button', class: 'btn btn--secondary', id: 'cl-reset-progress', disabled: !mayReset() || store.bulkBusy(), onClick: () => confirmProgressReset() }, t('cleaning.reset.progressBtn'))),
      h('div', { class: 'cl-reset__item' },
        h('div', null, h('strong', null, t('cleaning.reset.defaultsTitle')), h('p', { class: 'field__hint' }, t('cleaning.reset.defaultsHint'))),
        h('button', { type: 'button', class: 'btn btn--secondary', id: 'cl-reset-defaults', disabled: !mayRestore() || store.bulkBusy(), onClick: () => confirmRestore() }, t('cleaning.reset.defaultsBtn'))),
      !mayReset() ? h('p', { class: 'field__hint', id: 'cl-reset-denied' }, t('cleaning.reset.managersOnly')) : null,
      resetState ? h('div', { class: `banner banner--${resetState.tone}`, id: 'cl-reset-result', role: 'status' }, h('p', null, resetState.text),
        resetState.retry ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'cl-reset-retry', onClick: () => runProgressReset(resetState.retry) }, t('cleaning.reset.retry')) : null) : null);
  }
  function confirmProgressReset() {
    const s = store.getSnapshot(); const d = day();
    const plan = progressResetPlan({ tasks: s.tasks, occurrences: s.occurrences, today: d });
    formDialog({ title: t('cleaning.reset.progressTitle'), id: 'cl-reset-progress-form', submitLabel: t('cleaning.reset.progressBtn'), container: root,
      fields: [h('p', { class: 'fin-callout', id: 'cl-reset-progress-body' }, t('cleaning.reset.progressConfirm', { tasks: plan.patches.length, undo: plan.undo.length })),
        h('p', { class: 'field__hint' }, t('cleaning.reset.keepsRooms'))],
      onSubmit: async () => { await runProgressReset(plan); return null; } });
  }
  async function runProgressReset(plan) {
    resetState = { tone: 'info', text: t('cleaning.setup.progress', { saved: 0, total: plan.patches.length + plan.undo.length }) }; render();
    let res;
    try { res = await store.resetProgress(plan, { onProgress: (r) => { const el = root.querySelector('#cl-reset-result p'); if (el) el.textContent = t('cleaning.setup.progress', { saved: r.saved, total: r.total }); } }); }
    catch (e) { resetState = { tone: 'error', text: amsg(e) }; render(); return; }
    const ok = !res.failed.length;
    resetState = { tone: ok ? 'success' : 'error', text: t(ok ? 'cleaning.reset.progressDone' : 'cleaning.reset.partial', { saved: res.saved, total: res.total, failed: res.failed.length }), retry: ok ? null : res.retry };
    toast(resetState.text, { tone: ok ? 'success' : 'error' }); render();
  }
  function confirmRestore() {
    const removeBox = h('input', { type: 'checkbox', id: 'cl-reset-remove-custom' });   // unchecked by default
    const warn = h('p', { class: 'banner banner--warning', id: 'cl-reset-remove-warn', hidden: true }, t('cleaning.reset.removeWarn'));
    removeBox.addEventListener('change', () => { warn.hidden = !removeBox.checked; });
    formDialog({ title: t('cleaning.reset.defaultsTitle'), id: 'cl-reset-defaults-form', submitLabel: t('cleaning.reset.defaultsBtn'), container: root,
      fields: [h('p', { class: 'fin-callout' }, t('cleaning.reset.defaultsConfirm')),
        h('label', { class: 'fin-check' }, removeBox, h('span', null, t('cleaning.reset.removeCustom'))), warn,
        h('p', { class: 'field__hint' }, t('cleaning.reset.keepsRooms'))],
      onSubmit: async () => {
        const s = store.getSnapshot(); const d = day();
        const plan = restoreDefaultsPlan({ rooms: roomList(), devices: deviceList(), tasks: s.tasks, lang: state.profile && state.profile.language === 'en' ? 'en' : 'ar', uid: identity.uid, now: store.now(), today: d, removeCustom: removeBox.checked });
        resetState = { tone: 'info', text: t('cleaning.setup.progress', { saved: 0, total: plan.archiveCustom.length + plan.reactivate.length + plan.creates.length + plan.patches.length }) }; render();
        let res;
        try { res = await store.restoreDefaults(plan, { today: d, onProgress: (r) => { const el = root.querySelector('#cl-reset-result p'); if (el) el.textContent = t('cleaning.setup.progress', { saved: r.saved + (r.already || 0), total: r.total }); } }); }
        catch (e) { resetState = { tone: 'error', text: amsg(e) }; render(); return null; }
        const ok = !res.failed.length;
        resetState = { tone: ok ? 'success' : 'error', text: t(ok ? 'cleaning.reset.defaultsDone' : 'cleaning.reset.partial', { saved: res.saved + res.already, total: res.total, failed: res.failed.length, archived: plan.archiveCustom.length }) };
        toast(resetState.text, { tone: ok ? 'success' : 'error' }); render();   // a failed restore is retried by running it again (idempotent)
        return null;
      } });
  }

  function render() {
    // B0 fix: the routine day depends on the stored startHour, so (1) re-target the routine listener
    // BEFORE reading the snapshot (it was read first, so a tab could see the previous day's routine) and
    // (2) don't target any day until the settings have loaded (default startHour 3 could pick yesterday).
    store.ensureAdvanced(store.getSnapshot().settings === undefined ? null : day());
    const snap = store.getSnapshot(); const d = day();
    head.replaceChildren(
      h('div', null, h('h1', { class: 'page-head__title' }, t('module.cleaning.name')), h('p', { class: 'page-head__sub' }, t('cleaning.adv.dayOf', { date: formatDateLong(d, locale) }))),
      h('div', { class: 'page-head__actions' },
        can('cleaning.create') ? h('button', { type: 'button', class: 'btn btn--primary', id: 'cl-adv-new', onClick: () => openForm(null) }, t('cleaning.newTask')) : null));
    tabsEl.replaceChildren(...TABS.map((v) => h('button', { type: 'button', role: 'tab', id: `cl-adv-tab-${v}`, class: 'view-switch__btn', 'aria-selected': String(tab === v), 'aria-pressed': String(tab === v), onClick: () => { tab = v; render(); } }, t(`cleaning.adv.tab.${v}`))));
    if (snap.status === 'error') { body.replaceChildren(banner('error', errorText(snap.error))); return; }
    if (snap.status !== 'ready' || snap.settings === undefined) { body.replaceChildren(h('p', { class: 'muted', role: 'status' }, t('common.loading'))); return; }
    if (!tplViews) tplViews = createTemplateViews({ store, can, root, render, uid: identity.uid, lang: state.profile && state.profile.language === 'en' ? 'en' : 'ar', roomList, deviceList, today: day, roomLabel });
    body.replaceChildren({ routine: routineTab, quick: quickTab, rooms: roomsTab, devices: devicesTab, tasks: tasksTab, templates: tplViews.templatesTab, import: tplViews.importTab, stats: statsTab, settings: settingsTab }[tab](snap));
  }
  offs.push(store.subscribe(() => render()));
  if (rooms) offs.push(rooms.subscribe(() => render()));
  if (devices) offs.push(devices.subscribe(() => render()));
  render();
  return () => { for (const off of offs) off(); if (tasksOff) tasksOff(); };
}
