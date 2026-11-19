/**
 * Device Maintenance (Phase 5.5) — PURE model. No Firebase, no DOM.
 * Preventive plans repeat AFTER THE LAST COMPLETION (one basis, shown in the UI); one-time plans are
 * completed once. Nothing is pre-generated: due status is derived from the plan (firstDueDate,
 * lastDoneDate, completedCount) in the Home time zone. Completions and repairs are immutable records
 * with deterministic ids, so retries and concurrent actions can never double-count.
 */
import { addDays, isCalendarDate, daysInMonth } from '../expenses/calendar.js';

export const PRIORITIES = Object.freeze(['low', 'normal', 'high']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
export const UNITS = Object.freeze({ day: 365, week: 52, month: 24 });
export const LIMITS = Object.freeze({ title: 120, summary: 120, instructions: 2000, description: 2000, notes: 1000, work: 1000, provider: 100, parts: 500, eventNote: 500, minutes: 1440, costMax: 100000000 });
export const FAULT_STATUSES = Object.freeze(['open', 'inProgress', 'resolved', 'closed', 'cancelled']);
/** Allowed fault transitions → required permission (mirrors firestore.rules). `closed` is final. */
export const TRANSITIONS = Object.freeze({
  'open>inProgress': 'maintenance.complete', 'inProgress>open': 'maintenance.complete', 'inProgress>resolved': 'maintenance.complete',
  'resolved>inProgress': 'maintenance.edit', 'resolved>closed': 'maintenance.edit',
  'open>cancelled': 'maintenance.edit', 'inProgress>cancelled': 'maintenance.edit', 'cancelled>open': 'maintenance.edit',
});
const fail = (detail, fields) => Object.assign(new Error(detail), { code: 'validation', detail, fields });
const txt = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '');
const opt = (s, max, errors, key) => { const v = txt(s, max); if (v.length > max) errors[key] = 'maintenance.err.tooLong'; return v || null; };
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------- recurrence
export function validRecurrence(r) {
  if (!r || typeof r !== 'object') return false;
  if (r.kind === 'once') return Object.keys(r).length === 1;
  return r.kind === 'every' && Object.keys(r).length === 3 && UNITS[r.unit] !== undefined && Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= UNITS[r.unit];
}
export function addMonthsClamped(date, n) {
  const [y, m, d] = date.split('-').map(Number); const t = m - 1 + n; const ny = y + Math.floor(t / 12); const nm = ((t % 12) + 12) % 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysInMonth(ny, nm))).padStart(2, '0')}`;
}
export const addInterval = (date, r) => (r.unit === 'month' ? addMonthsClamped(date, r.interval) : addDays(date, r.unit === 'week' ? r.interval * 7 : r.interval));
/** Next due date (null = one-time plan already done). Basis: after the last completion. */
export function nextDue(plan) {
  if (plan.recurrence.kind === 'once') return (plan.completedCount || 0) > 0 ? null : plan.firstDueDate;
  return plan.lastDoneDate ? addInterval(plan.lastDoneDate, plan.recurrence) : plan.firstDueDate;
}
/** archived | completed | overdue | dueToday | upcoming — identical on every client. */
export function planStatus(plan, today) {
  if (plan.active !== true) return 'archived';
  const n = nextDue(plan);
  if (!n) return 'completed';
  return n < today ? 'overdue' : n === today ? 'dueToday' : 'upcoming';
}

// ---------------------------------------------------------------- plans
export function validatePlan(input = {}, { memberUids = [] } = {}) {
  const errors = {};
  const title = txt(input.title, LIMITS.title);
  if (!title) errors.title = 'maintenance.err.required'; else if (title.length > LIMITS.title) errors.title = 'maintenance.err.tooLong';
  const instructions = opt(input.instructions, LIMITS.instructions, errors, 'instructions');
  const notes = opt(input.notes, LIMITS.notes, errors, 'notes');
  if (typeof input.deviceId !== 'string' || !ID_RE.test(input.deviceId)) errors.deviceId = 'maintenance.err.device';
  const recurrence = input.recurrence && input.recurrence.kind === 'once' ? { kind: 'once' }
    : { kind: 'every', unit: input.recurrence && input.recurrence.unit, interval: Number(input.recurrence && input.recurrence.interval) };
  if (!validRecurrence(recurrence)) errors.recurrence = 'maintenance.err.recurrence';
  if (!isCalendarDate(input.firstDueDate)) errors.firstDueDate = 'maintenance.err.date';
  const assigneeUid = input.assigneeUid || null;
  if (assigneeUid && !memberUids.includes(assigneeUid)) errors.assigneeUid = 'maintenance.err.assignee';
  const em = input.estimatedMinutes === '' || input.estimatedMinutes == null ? null : Number(input.estimatedMinutes);
  if (em !== null && (!Number.isInteger(em) || em < 1 || em > LIMITS.minutes)) errors.estimatedMinutes = 'maintenance.err.minutes';
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  return { value: { title, instructions, notes, deviceId: input.deviceId, recurrence, firstDueDate: input.firstDueDate, assigneeUid, estimatedMinutes: em, priority }, errors };
}
export const PLAN_EDITABLE = Object.freeze(['title', 'instructions', 'notes', 'recurrence', 'firstDueDate', 'assigneeUid', 'estimatedMinutes', 'priority']);
export function planCreateDoc(v, { uid, now }) {
  return { ...v, active: true, archivedAt: null, archivedBy: null, completedCount: 0, lastDoneDate: null, rev: 1,
    createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
}
/** Field-level edit patch (deviceId is immutable); rev n → n+1. */
export function planEditPatch(cur, v, { uid, now }) {
  const patch = {};
  for (const k of PLAN_EDITABLE) if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(v[k] ?? null)) patch[k] = v[k] ?? null;
  return Object.keys(patch).length ? { ...patch, rev: (cur.rev || 0) + 1, updatedBy: uid, updatedAt: now } : null;
}
export function planArchivePatch(cur, archive, { uid, now }) {
  return { active: !archive, archivedAt: archive ? now : null, archivedBy: archive ? uid : null, rev: (cur.rev || 0) + 1, updatedBy: uid, updatedAt: now };
}

// ---------------------------------------------------------------- service records (costs)
/** Validate the optional service details (shared by completion, repair and correction records). */
export function validateService(input = {}, { today, homeCurrency }) {
  const errors = {};
  const serviceDate = input.serviceDate || today;
  if (!isCalendarDate(serviceDate) || serviceDate > addDays(today, 1) || serviceDate < addDays(today, -3 * 366)) errors.serviceDate = 'maintenance.err.serviceDate';
  const workPerformed = opt(input.workPerformed, LIMITS.work, errors, 'workPerformed');
  const provider = opt(input.provider, LIMITS.provider, errors, 'provider');
  const parts = opt(input.parts, LIMITS.parts, errors, 'parts');
  const notes = opt(input.notes, LIMITS.notes, errors, 'notes');
  let costMinor = null; let currency = null;
  if (input.costMinor !== null && input.costMinor !== undefined && input.costMinor !== '') {
    costMinor = Number(input.costMinor);
    if (!Number.isInteger(costMinor) || costMinor < 0 || costMinor > LIMITS.costMax) errors.cost = 'maintenance.err.cost';
    currency = String(input.currency || homeCurrency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'maintenance.err.currency';
  }
  return { value: { serviceDate, workPerformed, provider, parts, notes, costMinor, currency }, errors };
}
const recordBase = (kind, deviceId, service, { uid, now }, extra) => ({ kind, deviceId, planId: null, faultId: null, correctsRecordId: null, ...extra, ...service, actorUid: uid, at: now, schemaVersion: 1 });
export const completionId = (planId, n) => `${planId}_c${n}`;
export const repairId = (faultId, rev) => `${faultId}_r${rev}`;
/**
 * Complete a plan: ONE batch = record <planId>_c<n> + plan {completedCount: n, lastDoneDate, rev+1}.
 * Two members (or a retry) compute the same n → only the first succeeds (rules: create-only + rev).
 */
export function buildCompletion(plan, service, { uid, now }) {
  if (plan.active !== true) throw fail('maintenance.err.archived');
  if (plan.recurrence.kind === 'once' && (plan.completedCount || 0) > 0) throw fail('maintenance.err.alreadyDone');
  const n = (plan.completedCount || 0) + 1; const id = completionId(plan.id, n);
  return { id, record: recordBase('preventive', plan.deviceId, service, { uid, now }, { planId: plan.id }),
    planPatch: { completedCount: n, lastDoneDate: service.serviceDate, rev: (plan.rev || 0) + 1, updatedBy: uid, updatedAt: now } };
}
/** A correction is a NEW record naming the corrected one — history is never rewritten. */
export function buildCorrection(orig, service, { uid, now, id }) {
  return { id, record: recordBase(orig.kind, orig.deviceId, service, { uid, now }, { planId: orig.planId, faultId: orig.faultId, correctsRecordId: orig.id }) };
}

// ---------------------------------------------------------------- faults
export function validateFault(input = {}, { memberUids = [], homeCurrency } = {}) {
  const errors = {};
  const summary = txt(input.summary, LIMITS.summary);
  if (!summary) errors.summary = 'maintenance.err.required'; else if (summary.length > LIMITS.summary) errors.summary = 'maintenance.err.tooLong';
  const description = opt(input.description, LIMITS.description, errors, 'description');
  const diagnosis = opt(input.diagnosis, LIMITS.description, errors, 'diagnosis');
  const resolution = opt(input.resolution, LIMITS.description, errors, 'resolution');
  if (typeof input.deviceId !== 'string' || !ID_RE.test(input.deviceId)) errors.deviceId = 'maintenance.err.device';
  const severity = SEVERITIES.includes(input.severity) ? input.severity : 'medium';
  const assigneeUid = input.assigneeUid || null;
  if (assigneeUid && !memberUids.includes(assigneeUid)) errors.assigneeUid = 'maintenance.err.assignee';
  let estimateMinor = null; let estimateCurrency = null;
  if (input.estimateMinor !== null && input.estimateMinor !== undefined && input.estimateMinor !== '') {
    estimateMinor = Number(input.estimateMinor);
    if (!Number.isInteger(estimateMinor) || estimateMinor < 0 || estimateMinor > LIMITS.costMax) errors.estimate = 'maintenance.err.cost';
    estimateCurrency = String(input.estimateCurrency || homeCurrency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(estimateCurrency)) errors.estimateCurrency = 'maintenance.err.currency';
  }
  return { value: { summary, description, diagnosis, resolution, deviceId: input.deviceId, severity, assigneeUid, estimateMinor, estimateCurrency }, errors };
}
export const FAULT_EDITABLE = Object.freeze(['summary', 'description', 'severity', 'assigneeUid', 'diagnosis', 'resolution', 'estimateMinor', 'estimateCurrency']);
export function faultCreateDoc(v, { uid, now }) {
  return { ...v, status: 'open', rev: 1, reportedBy: uid, reportedAt: now, resolvedAt: null, resolvedBy: null, closedAt: null, closedBy: null,
    updatedBy: uid, updatedAt: now, schemaVersion: 1 };
}
export const faultEventId = (faultId, rev) => `${faultId}_r${rev}`;
export function allowedTransitions(fault, can) {
  return Object.entries(TRANSITIONS).filter(([k, p]) => k.startsWith(`${fault.status}>`) && can(p)).map(([k]) => k.split('>')[1]);
}
/**
 * Transition (or same-status edit): ONE batch = fault {status, ..., rev+1} + event <faultId>_r<rev+1>
 * [+ repair record <faultId>_r<rev+1> when resolving with service details].
 */
export function buildTransition(fault, to, { uid, now, note = null, fields = {}, service = null }) {
  const from = fault.status;
  if (to !== from && !TRANSITIONS[`${from}>${to}`]) throw fail('maintenance.err.transition');
  const rev = (fault.rev || 0) + 1;
  const patch = { ...fields, status: to, rev, updatedBy: uid, updatedAt: now };
  if (to === 'resolved') Object.assign(patch, { resolvedAt: now, resolvedBy: uid });
  if (from === 'resolved' && to === 'inProgress') Object.assign(patch, { resolvedAt: null, resolvedBy: null });
  if (to === 'closed') Object.assign(patch, { closedAt: now, closedBy: uid });
  const n = txt(note, LIMITS.eventNote);
  const event = { id: faultEventId(fault.id, rev), data: { faultId: fault.id, rev, fromStatus: from, toStatus: to, note: n ? n.slice(0, LIMITS.eventNote) : null, actorUid: uid, at: now, schemaVersion: 1 } };
  const record = to === 'resolved' && service ? { id: repairId(fault.id, rev), data: recordBase('repair', fault.deviceId, service, { uid, now }, { faultId: fault.id }) } : null;
  return { patch, event, record };
}

// ---------------------------------------------------------------- history / totals
/** Actual costs per currency (never summed across currencies; estimates excluded). */
export function totalsByCurrency(records) {
  const out = {};
  for (const r of records) if (Number.isInteger(r.costMinor) && r.currency) out[r.currency] = (out[r.currency] || 0) + r.costMinor;
  return out;
}
