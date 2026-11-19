/**
 * Maintenance forms (Phase 5.5): plan, fault, and service (completion / resolve / correction).
 * Every save awaits the server; the dialog's submit is disabled while saving (no double submit),
 * and success is only shown after confirmation.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { toast } from '../../ui/components/toast.js';
import { errorText } from '../../ui/components/common.js';
import { formDialog } from '../expenses/dialogs.js';
import { parseMinor, minorToPlain } from '../expenses/money.js';
import { PRIORITIES, SEVERITIES, UNITS, LIMITS } from './maintenance-model.js';

export const mmsg = (e) => (e && e.detail && /^maintenance\./.test(String(e.detail).split(',')[0]) ? t(String(e.detail).split(',')[0]) : errorText(e));
const fld = (label, el, id, hint) => h('label', { class: 'field', for: id }, h('span', { class: 'field__label' }, label), el, hint ? h('span', { class: 'field__hint' }, hint) : null, h('span', { class: 'field__error', id: `${id}-error`, role: 'alert' }));
const sel = (id, opts, value) => { const s = h('select', { id, class: 'input' }, opts.map(([v, l]) => h('option', { value: v }, l))); s.value = value ?? ''; return s; };
const inp = (id, value, extra = {}) => h('input', { id, class: 'input', value: value ?? '', dir: 'auto', ...extra });
const area = (id, value, max) => h('textarea', { id, class: 'input', rows: 3, maxlength: max, dir: 'auto' }, value || '');
const showErrors = (root, e, map = {}) => { for (const k of Object.keys((e && e.fields) || {})) { const el = root.querySelector(`#${map[k] || `mt-${k}`}-error`); if (el) el.textContent = t(e.fields[k]); } };
export const deviceOption = (d, roomName) => [d.name, d.subtype ? t(`devices.subtype.${d.subtype}`) : t(`devices.category.${d.category}`), roomName(d.roomId)].filter(Boolean).join(' · ');

export function openPlanForm(env, plan = null, preset = null) {
  const { root, store, devices, members, roomName, today } = env;
  const v = plan || { title: '', instructions: '', notes: '', recurrence: { kind: 'every', unit: 'month', interval: 6 }, firstDueDate: today(), assigneeUid: null, estimatedMinutes: null, priority: 'normal', ...(preset || {}) };
  const active = devices().filter((d) => d.active !== false);
  const dev = plan ? h('p', { id: 'mt-device-fixed' }, (devices().find((d) => d.id === plan.deviceId) || {}).name || t('maintenance.deviceRemoved'))
    : sel('mt-device', [['', t('maintenance.chooseDevice')], ...active.map((d) => [d.id, deviceOption(d, roomName)])], v.deviceId || '');
  const kind = sel('mt-kind', [['every', t('maintenance.rec.every')], ['once', t('maintenance.rec.once')]], v.recurrence.kind);
  const unit = sel('mt-unit', Object.keys(UNITS).map((u) => [u, t(`maintenance.rec.unit.${u}`)]), v.recurrence.unit || 'month');
  const interval = inp('mt-interval', v.recurrence.interval || 6, { type: 'number', min: 1, max: 365, inputmode: 'numeric' });
  const wrap = h('div', { class: 'form-grid form-grid--tight' }, fld(t('maintenance.rec.interval'), interval, 'mt-interval'), fld(t('maintenance.rec.unitLabel'), unit, 'mt-unit'));
  const sync = () => { wrap.hidden = kind.value === 'once'; }; kind.addEventListener('change', sync); sync();
  formDialog({ title: t(plan ? 'maintenance.editPlan' : 'maintenance.newPlan'), id: 'mt-plan-form', submitLabel: t('common.save'), container: root,
    fields: [
      fld(t('maintenance.device'), dev, 'mt-device', plan ? t('maintenance.deviceFixed') : null),
      fld(t('maintenance.titleLabel'), inp('mt-title', v.title, { maxlength: LIMITS.title, required: true }), 'mt-title'),
      fld(t('maintenance.instructions'), area('mt-instructions', v.instructions, LIMITS.instructions), 'mt-instructions'),
      fld(t('maintenance.rec.label'), kind, 'mt-kind', t('maintenance.rec.basisHint')), wrap,
      h('div', { class: 'form-grid form-grid--tight' },
        fld(t(plan && plan.completedCount ? 'maintenance.firstDueAfter' : 'maintenance.firstDue'), inp('mt-first', v.firstDueDate, { type: 'date' }), 'mt-firstDueDate'),
        fld(t('maintenance.minutes'), inp('mt-minutes', v.estimatedMinutes ?? '', { type: 'number', min: 1, max: LIMITS.minutes, inputmode: 'numeric' }), 'mt-estimatedMinutes')),
      h('div', { class: 'form-grid form-grid--tight' },
        fld(t('maintenance.assignee'), sel('mt-assignee', [['', t('maintenance.noAssignee')], ...members().map((m) => [m.uid, m.displayName])], v.assigneeUid || ''), 'mt-assigneeUid'),
        fld(t('maintenance.priorityLabel'), sel('mt-priority', PRIORITIES.map((p) => [p, t(`maintenance.priority.${p}`)]), v.priority), 'mt-priority')),
      fld(t('maintenance.notes'), area('mt-notes', v.notes, LIMITS.notes), 'mt-notes')],
    onSubmit: async () => {
      const q = (s) => root.querySelector(s).value;
      const input = { title: q('#mt-title'), instructions: q('#mt-instructions'), notes: q('#mt-notes'), firstDueDate: q('#mt-first'),
        recurrence: kind.value === 'once' ? { kind: 'once' } : { kind: 'every', unit: unit.value, interval: Number(interval.value) },
        assigneeUid: q('#mt-assignee') || null, estimatedMinutes: q('#mt-minutes'), priority: q('#mt-priority') };
      const memberUids = members().map((m) => m.uid);
      try { if (plan) await store.editPlan(plan.id, input, { memberUids }); else await store.createPlan({ ...input, deviceId: q('#mt-device') }, { memberUids }); }
      catch (e) { showErrors(root, e); toast(mmsg(e), { tone: 'error' }); return false; }
      return plan ? 'maintenance.toast.saved' : 'maintenance.toast.planCreated';
    } });
}

export function openFaultForm(env, fault = null, preset = null) {
  const { root, store, devices, members, roomName, homeCurrency } = env;
  const v = fault || { summary: '', description: '', severity: 'medium', assigneeUid: null, estimateMinor: null, estimateCurrency: homeCurrency, ...(preset || {}) };
  const active = devices().filter((d) => d.active !== false);
  const dev = fault ? h('p', { id: 'mt-device-fixed' }, (devices().find((d) => d.id === fault.deviceId) || {}).name || t('maintenance.deviceRemoved'))
    : sel('mt-device', [['', t('maintenance.chooseDevice')], ...active.map((d) => [d.id, deviceOption(d, roomName)])], v.deviceId || '');
  formDialog({ title: t(fault ? 'maintenance.editFault' : 'maintenance.reportFault'), id: 'mt-fault-form', submitLabel: t('common.save'), container: root,
    fields: [
      fld(t('maintenance.device'), dev, 'mt-device'),
      fld(t('maintenance.summary'), inp('mt-summary', v.summary, { maxlength: LIMITS.summary, required: true }), 'mt-summary'),
      fld(t('maintenance.description'), area('mt-description', v.description, LIMITS.description), 'mt-description'),
      h('div', { class: 'form-grid form-grid--tight' },
        fld(t('maintenance.severityLabel'), sel('mt-severity', SEVERITIES.map((s) => [s, t(`maintenance.severity.${s}`)]), v.severity), 'mt-severity'),
        fld(t('maintenance.assignee'), sel('mt-assignee', [['', t('maintenance.noAssignee')], ...members().map((m) => [m.uid, m.displayName])], v.assigneeUid || ''), 'mt-assigneeUid')),
      fault ? fld(t('maintenance.diagnosis'), area('mt-diagnosis', v.diagnosis, LIMITS.description), 'mt-diagnosis') : null,
      h('div', { class: 'form-grid form-grid--tight' },
        fld(t('maintenance.estimate'), inp('mt-estimate', v.estimateMinor != null ? minorToPlain(v.estimateMinor) : '', { inputmode: 'decimal' }), 'mt-estimate', t('maintenance.estimateHint')),
        fld(t('maintenance.currency'), inp('mt-estimate-cur', v.estimateCurrency || homeCurrency || '', { maxlength: 3 }), 'mt-estimateCurrency'))].filter(Boolean),
    onSubmit: async () => {
      const q = (s) => root.querySelector(s);
      const est = parseMinor(q('#mt-estimate').value);
      if (est.error) { q('#mt-estimate-error').textContent = t('maintenance.err.cost'); return false; }
      const input = { summary: q('#mt-summary').value, description: q('#mt-description').value, severity: q('#mt-severity').value,
        assigneeUid: q('#mt-assignee').value || null, estimateMinor: est.value, estimateCurrency: q('#mt-estimate-cur').value };
      const memberUids = members().map((m) => m.uid);
      try {
        if (fault) await store.transitionFault(fault.id, fault.status, { fields: { ...input, diagnosis: q('#mt-diagnosis').value }, memberUids });
        else await store.reportFault({ ...input, deviceId: q('#mt-device').value }, { memberUids });
      } catch (e) { showErrors(root, e); toast(mmsg(e), { tone: 'error' }); return false; }
      return fault ? 'maintenance.toast.saved' : 'maintenance.toast.faultReported';
    } });
}

/** Service details (completion / repair / correction). `submit(service)` performs the confirmed write. */
export function openServiceDialog(env, { title, intro = null, submitLabel, submit, extraFields = [] }) {
  const { root, homeCurrency, today } = env;
  formDialog({ title, id: 'mt-service-form', submitLabel, container: root,
    fields: [
      intro ? h('p', { class: 'fin-callout' }, intro) : null, ...extraFields,
      fld(t('maintenance.serviceDate'), inp('mt-svc-date', today(), { type: 'date' }), 'mt-serviceDate'),
      fld(t('maintenance.workPerformed'), area('mt-svc-work', '', LIMITS.work), 'mt-workPerformed'),
      h('div', { class: 'form-grid form-grid--tight' },
        fld(t('maintenance.provider'), inp('mt-svc-provider', '', { maxlength: LIMITS.provider }), 'mt-provider'),
        fld(t('maintenance.parts'), inp('mt-svc-parts', '', { maxlength: LIMITS.parts }), 'mt-parts')),
      h('div', { class: 'form-grid form-grid--tight' },
        fld(t('maintenance.cost'), inp('mt-svc-cost', '', { inputmode: 'decimal' }), 'mt-cost', t('maintenance.costHint')),
        fld(t('maintenance.currency'), inp('mt-svc-cur', homeCurrency || '', { maxlength: 3 }), 'mt-currency')),
      fld(t('maintenance.notes'), area('mt-svc-notes', '', LIMITS.notes), 'mt-notes')].filter(Boolean),
    onSubmit: async () => {
      const q = (s) => root.querySelector(s);
      const c = parseMinor(q('#mt-svc-cost').value);
      if (c.error) { q('#mt-cost-error').textContent = t('maintenance.err.cost'); return false; }
      const service = { serviceDate: q('#mt-svc-date').value, workPerformed: q('#mt-svc-work').value, provider: q('#mt-svc-provider').value,
        parts: q('#mt-svc-parts').value, costMinor: c.value, currency: q('#mt-svc-cur').value, notes: q('#mt-svc-notes').value };
      try { return await submit(service); }
      catch (e) { showErrors(root, e); toast(mmsg(e), { tone: 'error' }); return false; }
    } });
}
