/**
 * Shared New / Edit cleaning-task form (Phase 5.4d) — used by Basic and Advanced Cleaning.
 * Adds an optional Device / الجهاز link (current Home's devices only):
 *   - plain link (deviceId) for ordinary tasks; the room may "follow the device" (roomId null);
 *   - trigger tasks (after-use / season) and generated tasks show their device + recurrence READ-ONLY
 *     (immutable by design; previously the Basic form could not edit them at all);
 *   - archived / removed linked devices are labelled honestly and can never be newly chosen.
 * Save awaits the server; success is only shown after it is confirmed.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { toast } from '../../ui/components/toast.js';
import { formDialog } from '../expenses/dialogs.js';
import { PRIORITIES, LIMITS, AFTER_LIMITS } from './cleaning-model.js';
import { linkedDeviceId } from './cleaning-integration.js';

const FOLLOW = '__follow_device__';
export const cmsgOf = (e, errorText) => (e && e.detail && /^cleaning\./.test(String(e.detail).split(',')[0]) ? t(String(e.detail).split(',')[0]) : errorText(e));
export const deviceLabel = (d, roomName) => [d.name, d.subtype ? t(`devices.subtype.${d.subtype}`) : t(`devices.category.${d.category}`), roomName ? roomName(d.roomId) : null].filter(Boolean).join(' · ');

export function openTaskForm(env, task = null, preset = null) {
  const { root, store, identity, dir, roomList, deviceList, today, errorText } = env;
  const v = task || { title: '', instructions: '', roomId: null, priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'days', interval: 1 }, startDate: today(), dueDate: null, endDate: null, ...(preset || {}) };
  const r = v.recurrence || { kind: 'once' };
  const fixedTrigger = !!(task && (task.trigger || (task.source && task.source.kind === 'device')));
  const fixedRecurrence = r.kind === 'onUse' || r.kind === 'onSeason';
  const members = dir ? dir.active() : [];
  const devices = deviceList();
  const linked = linkedDeviceId(v);
  const linkedDev = linked ? devices.find((d) => d.id === linked) || null : null;
  const roomName = (id) => { const x = id && roomList().find((q) => q.id === id); return x ? x.name : null; };
  const sel = (id, opts, value) => { const s = h('select', { id, class: 'input' }, opts.map(([val, label, dis]) => h('option', { value: val, disabled: !!dis }, label))); s.value = value; return s; };
  const fld = (label, el, id, hint) => h('label', { class: 'field', for: id }, h('span', { class: 'field__label' }, label), el, hint ? h('span', { class: 'field__hint', id: `${id}-hint` }, hint) : null, h('span', { class: 'field__error', id: `${id}-error`, role: 'alert' }));

  // Device: plain link editable; trigger / generated link read-only.
  let deviceSel = null; let deviceRow;
  const noDevice = !!(task && task.source && task.source.kind === 'room');   // generated room task: identity is the room
  if (noDevice) deviceRow = null;
  else if (fixedTrigger) {
    deviceRow = h('div', { class: 'field', id: 'ct-device-fixed' }, h('span', { class: 'field__label' }, t('cleaning.device.label')),
      h('p', null, linkedDev ? `${deviceLabel(linkedDev, roomName)}${linkedDev.active === false ? ` (${t('cleaning.device.archivedTag')})` : ''}` : t('cleaning.device.removedTag')),
      h('p', { class: 'field__hint' }, t('cleaning.device.fixedHint')));
  } else {
    const opts = [['', t('cleaning.device.none')], ...devices.filter((d) => d.active !== false).map((d) => [d.id, deviceLabel(d, roomName)])];
    if (linked && (!linkedDev || linkedDev.active === false)) opts.push([linked, linkedDev ? `${linkedDev.name} (${t('cleaning.device.archivedTag')})` : t('cleaning.device.removedTag'), true]);
    deviceSel = sel('ct-device', opts, linked || '');
    deviceRow = fld(t('cleaning.device.label'), deviceSel, 'ct-device', t('cleaning.device.optionalHint'));
  }
  // Room: with a device, default "follow the device's room" (roomId null).
  const roomSel = h('select', { id: 'ct-room', class: 'input' });
  const fillRooms = () => {
    const devId = deviceSel ? deviceSel.value : linked; const d = devId ? devices.find((x) => x.id === devId) : null;
    const opts = [...(devId ? [[FOLLOW, t('cleaning.device.followRoom', { room: (d && roomName(d.roomId)) || t('cleaning.noRoom') })]] : []), ['', t('cleaning.noRoom')],
      ...roomList().filter((x) => x.active !== false || x.id === v.roomId).map((x) => [x.id, x.active === false ? t('cleaning.roomArchived', { name: x.name }) : x.name])];
    const prev = roomSel.value;
    roomSel.replaceChildren(...opts.map(([val, label]) => h('option', { value: val }, label)));
    roomSel.value = prev && opts.some(([val]) => val === prev) ? prev : (devId && !v.roomId ? FOLLOW : (v.roomId || ''));
  };
  fillRooms();
  if (deviceSel) deviceSel.addEventListener('change', () => { roomSel.value = ''; fillRooms(); if (deviceSel.value) roomSel.value = FOLLOW; });
  if (fixedTrigger) roomSel.disabled = true;

  const people = (name, chosen) => h('div', { class: 'fin-members' }, members.length ? members.map((m) => h('label', { class: 'fin-check' },
    h('input', { type: 'checkbox', name, value: m.uid, checked: chosen.includes(m.uid) }), h('span', null, m.uid === identity.uid ? t('settings.you') : m.displayName))) : h('p', { class: 'field__hint' }, t('cleaning.noMembers')));
  const mode = sel('ct-mode', [['shared', t('cleaning.mode.shared')], ['assigned', t('cleaning.mode.assigned')]], v.assignMode);
  const assigned = h('div', { id: 'ct-assigned-wrap' }, h('span', { class: 'field__label' }, t('cleaning.assignees')), people('ct-assignee', v.assigneeUids || []));
  const shared = h('div', { id: 'ct-shared-wrap' }, h('span', { class: 'field__label' }, t('cleaning.eligible')), h('p', { class: 'field__hint' }, t('cleaning.eligibleHint')), people('ct-eligible', v.eligibleUids || []));
  const kinds = [['once', t('cleaning.rec.once')], ['days', t('cleaning.rec.days')], ['weeks', t('cleaning.rec.weeks')], ['months', t('cleaning.rec.months')]];
  if (r.kind === 'after') kinds.push(['after', t('cleaning.rec.after')]);
  const fixedLabel = r.kind === 'onUse' ? t('cleaning.setup.afterUse') : t('cleaning.device.seasonChecklist');
  const kind = sel('ct-kind', fixedRecurrence ? [[r.kind, fixedLabel]] : kinds, r.kind);
  if (fixedRecurrence) kind.disabled = true;
  const unit = sel('ct-unit', [['day', t('cleaning.rec.unitDay')], ['month', t('cleaning.rec.unitMonth')]], r.unit || 'day');
  const interval = h('input', { id: 'ct-interval', class: 'input', type: 'number', min: 1, max: LIMITS.interval, value: r.interval || 1, inputmode: 'numeric' });
  const weekdays = h('div', { class: 'fin-members', id: 'ct-weekdays' }, [0, 1, 2, 3, 4, 5, 6].map((d) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name: 'ct-wd', value: d, checked: (r.weekdays || []).includes(d) }), h('span', null, t(`cleaning.wd.${d}`)))));
  const dom = h('input', { id: 'ct-dom', class: 'input', type: 'number', min: 1, max: 31, value: r.dayOfMonth || 1, inputmode: 'numeric' });
  const due = h('input', { id: 'ct-due', class: 'input', type: 'date', value: v.dueDate || v.startDate });
  const wrapI = fld(t('cleaning.interval'), interval, 'ct-interval'); const wrapW = h('div', null, h('span', { class: 'field__label' }, t('cleaning.weekdays')), weekdays);
  const wrapD = fld(t('cleaning.dayOfMonth'), dom, 'ct-dom'); const wrapDue = fld(t('cleaning.dueDate'), due, 'ct-due'); const wrapU = fld(t('cleaning.rec.unit'), unit, 'ct-unit');
  const sync = () => {
    assigned.hidden = mode.value !== 'assigned'; shared.hidden = mode.value !== 'shared';
    const k = kind.value;
    wrapI.hidden = fixedRecurrence || k === 'once'; wrapW.hidden = k !== 'weeks'; wrapD.hidden = k !== 'months'; wrapDue.hidden = k !== 'once'; wrapU.hidden = k !== 'after';
    interval.max = k === 'after' ? AFTER_LIMITS[unit.value] : LIMITS.interval;
  };
  unit.addEventListener('change', sync); mode.addEventListener('change', sync); kind.addEventListener('change', sync); sync();
  formDialog({ title: task ? t('cleaning.editTask') : t('cleaning.newTask'), id: 'cl-task-form', submitLabel: t('common.save'), container: root,
    fields: [
      fld(t('cleaning.title'), h('input', { id: 'ct-title', class: 'input', maxlength: task && (task.source || task.templateRef) ? LIMITS.generatedTitle : LIMITS.title, value: v.title, required: true, dir: 'auto' }), 'ct-title'),
      fld(t('cleaning.instructions'), h('textarea', { id: 'ct-instructions', class: 'input', rows: 3, maxlength: LIMITS.instructions, dir: 'auto' }, v.instructions || ''), 'ct-instructions'),
      ...(deviceRow ? [deviceRow] : []),
      h('div', { class: 'form-grid form-grid--tight' }, fld(t('cleaning.room'), roomSel, 'ct-room'),
        fld(t('cleaning.priority.label'), sel('ct-priority', PRIORITIES.map((p) => [p, t(`cleaning.priority.${p}`)]), v.priority), 'ct-priority')),
      fld(t('cleaning.assignment'), mode, 'ct-mode'), assigned, shared,
      fld(t('cleaning.repeat'), kind, 'ct-kind', fixedRecurrence ? t('cleaning.device.fixedRecurrenceHint') : null), wrapU, wrapI, wrapW, wrapD,
      h('div', { class: 'form-grid form-grid--tight' }, fld(t('cleaning.startDate'), h('input', { id: 'ct-start', class: 'input', type: 'date', value: v.startDate }), 'ct-start'), wrapDue,
        fld(t('cleaning.endDate'), h('input', { id: 'ct-end', class: 'input', type: 'date', value: v.endDate || '' }), 'ct-end'))],
    onSubmit: async () => {
      const q = (s) => root.querySelector(s);
      const picked = (n) => [...root.querySelectorAll(`input[name="${n}"]:checked`)].map((x) => x.value);
      const recurrence = fixedRecurrence ? r : { kind: kind.value, unit: unit.value, interval: Number(interval.value), weekdays: picked('ct-wd').map(Number), dayOfMonth: Number(dom.value) };
      const input = { title: q('#ct-title').value, instructions: q('#ct-instructions').value, priority: q('#ct-priority').value,
        assignMode: mode.value, assigneeUids: picked('ct-assignee'), eligibleUids: picked('ct-eligible'), recurrence,
        startDate: q('#ct-start').value, dueDate: !fixedRecurrence && kind.value === 'once' ? due.value : null, endDate: q('#ct-end').value || null };
      if (!fixedTrigger) { input.roomId = roomSel.value === FOLLOW ? null : roomSel.value || null; if (deviceSel) input.deviceId = deviceSel.value || null; }
      const memberUids = members.map((m) => m.uid);
      try { if (task) await store.updateTask(task.id, input, { memberUids, baseGen: Number.isInteger(task.resetGen) ? task.resetGen : 0 }); else await store.createTask(input, { memberUids }); }
      catch (e) {
        for (const k of String(e.detail || '').split(',')) { const el = root.querySelector(`#ct-${{ title: 'title', instructions: 'instructions', recurrence: 'kind', startDate: 'start', dueDate: 'due', endDate: 'end', deviceId: 'device' }[k] || k}-error`); if (el) el.textContent = t(`cleaning.validation.${k}`) || ''; }
        toast(cmsgOf(e, errorText), { tone: 'error' });
        return false;
      }
      return task ? 'cleaning.toast.saved' : 'cleaning.toast.created';   // shown only after the server confirmed
    } });
}
