/**
 * Household custom cleaning templates (Phase 5.4c) — PURE. A template is ONE reusable task
 * definition (homes/{h}/cleaningCustomTemplates/{id}); definitions sharing a `pack` are applied
 * together. Templates are definitions only: applying one creates ORDINARY cleaningTasks
 * with a deterministic id c_<templateId>_<target> and an immutable templateRef.
 */
import { normalizeRecurrence, validRecurrence, PRIORITIES, TRIGGER_KINDS, SEASON_PHASES } from './cleaning-model.js';

export const TEMPLATE_LIMITS = Object.freeze({ pack: 60, title: 120, instructions: 1000, minutesMax: 600 });
export const TEMPLATE_TARGETS = Object.freeze(['room', 'device', 'home']);
export const TEMPLATE_ID_RE = /^[A-Za-z0-9_]{6,60}$/;
const clean = (s, max) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1) : '');

/** Validate + normalise a template definition (input from the editor, a built-in duplicate or an import). */
export function validateTemplate(input = {}) {
  const errors = {};
  const pack = clean(input.pack, TEMPLATE_LIMITS.pack) || 'General';
  if (pack.length > TEMPLATE_LIMITS.pack) errors.pack = 'cleaning.tpl.err.pack';
  const title = clean(input.title, TEMPLATE_LIMITS.title);
  if (!title) errors.title = 'cleaning.validation.titleRequired'; else if (title.length > TEMPLATE_LIMITS.title) errors.title = 'cleaning.validation.tooLong';
  const titleEn = clean(input.titleEn, TEMPLATE_LIMITS.title) || null;
  if (titleEn && titleEn.length > TEMPLATE_LIMITS.title) errors.titleEn = 'cleaning.validation.tooLong';
  const ins = typeof input.instructions === 'string' ? input.instructions.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
  if (ins.length > TEMPLATE_LIMITS.instructions) errors.instructions = 'cleaning.validation.tooLong';
  const minutes = Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > TEMPLATE_LIMITS.minutesMax) errors.minutes = 'cleaning.validation.minutes';
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  const target = TEMPLATE_TARGETS.includes(input.target) ? input.target : null;
  if (!target) errors.target = 'cleaning.tpl.err.target';
  const recurrence = normalizeRecurrence(input.recurrence || {});
  if (!recurrence || recurrence.kind === 'once' || !validRecurrence(recurrence)) errors.recurrence = 'cleaning.validation.recurrence';
  let trigger = null;
  if (input.trigger) {
    const tr = input.trigger;
    if (!TRIGGER_KINDS.includes(tr.kind)) errors.trigger = 'cleaning.validation.trigger';
    else if (tr.kind === 'afterUse') trigger = { kind: 'afterUse' };
    else if (SEASON_PHASES.includes(tr.phase)) trigger = { kind: 'seasonal', phase: tr.phase };
    else errors.trigger = 'cleaning.validation.trigger';
  }
  if (trigger && target !== 'device') errors.trigger = 'cleaning.tpl.err.triggerNeedsDevice';
  if (recurrence && !errors.recurrence && !errors.trigger) {
    const k = recurrence.kind;
    const ok = !trigger ? !['onUse', 'onSeason'].includes(k)
      : trigger.kind === 'afterUse' ? k === 'onUse'
      : trigger.phase === 'active' ? !['onUse', 'onSeason'].includes(k) : k === 'onSeason';
    if (!ok) errors.recurrence = 'cleaning.validation.recurrence';
  }
  return { value: { pack, title, titleEn, instructions: ins || null, minutes, priority, target, recurrence, trigger }, errors };
}

export function templateCreateDoc(value, { uid, now }) {
  return { ...value, active: true, archivedAt: null, archivedBy: null, rev: 1, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
}
/** Edit patch (content), archive or reactivate — always rev n → n+1 (a stale editor is refused). */
export function templatePatch(current, change, { uid, now }) {
  const base = { rev: (current.rev || 0) + 1, updatedBy: uid, updatedAt: now };
  if (change === 'archive') return { ...base, active: false, archivedAt: now, archivedBy: uid };
  if (change === 'reactivate') return { ...base, active: true, archivedAt: null, archivedBy: null };
  return { ...base, ...change };
}

/** Deterministic task id for a template applied to a target (trigger device / room / home). */
export const customTaskId = (templateId, targetId) => `c_${templateId}_${targetId || 'home'}`;
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Apply preview for templates on ONE target. Nothing is written here.
 * status: create | exists (same id — incl. an archived/declined task) | duplicate (same title already
 * on that target) | invalid (reason).
 */
export function buildApplyPlan({ templates, target, tasks, lang, uid, now, today }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const tgtId = target.kind === 'home' ? 'home' : target.item && target.item.id;
  const devOf = (t) => (t.trigger && t.trigger.deviceId) || t.deviceId || (t.source && t.source.kind === 'device' ? t.source.id : null);
  const sameTarget = (t) => (target.kind === 'device' ? devOf(t) === tgtId : target.kind === 'room' ? t.roomId === tgtId && !devOf(t) : !t.roomId && !devOf(t));
  const titles = new Set(tasks.filter((t) => t.active !== false && sameTarget(t)).map((t) => norm(t.title)));
  return templates.map((tp) => {
    const id = customTaskId(tp.id, tgtId);
    if (tp.active !== true) return { id, template: tp, status: 'invalid', reason: 'cleaning.tpl.err.archived' };
    if (tp.target !== target.kind) return { id, template: tp, status: 'invalid', reason: 'cleaning.tpl.err.targetMismatch' };
    if (target.kind !== 'home' && (!target.item || target.item.active === false)) return { id, template: tp, status: 'invalid', reason: 'cleaning.tpl.err.targetInactive' };
    if (byId.has(id)) return { id, template: tp, status: 'exists' };
    const title = lang === 'en' && tp.titleEn ? tp.titleEn : tp.title;
    if (titles.has(norm(title)) || (tp.titleEn && titles.has(norm(tp.titleEn))) || titles.has(norm(tp.title))) return { id, template: tp, status: 'duplicate' };
    const data = {
      title, instructions: tp.instructions || null, roomId: target.kind === 'room' ? tgtId : null, priority: tp.priority,
      assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: tp.recurrence, startDate: today, dueDate: null, endDate: null,
      active: true, archivedAt: null, archivedBy: null,
      ...(tp.trigger ? { trigger: tp.trigger.kind === 'afterUse' ? { kind: 'afterUse', deviceId: tgtId } : { kind: 'seasonal', deviceId: tgtId, phase: tp.trigger.phase } } : {}),
      ...(!tp.trigger && target.kind === 'device' ? { deviceId: tgtId } : {}),   // 5.4d: periodic device template → plain device link
      templateRef: { templateId: tp.id, rev: tp.rev || 1 }, estimatedMinutes: tp.minutes,
      createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1,
    };
    return { id, template: tp, status: 'create', data };
  });
}

/** A built-in suggestion → an editable custom template definition (the built-in stays unchanged). */
export function templateFromBuiltIn(kind, T, tt, how) {
  const recurrence = how === 'afterUse' ? { kind: 'onUse' } : (how === 'seasonStart' || how === 'seasonEnd') ? { kind: 'onSeason' }
    : { kind: 'after', unit: tt.freq.unit, interval: tt.freq.n };
  const trigger = how === 'afterUse' ? { kind: 'afterUse' } : how === 'seasonalActive' ? { kind: 'seasonal', phase: 'active' }
    : how === 'seasonStart' ? { kind: 'seasonal', phase: 'start' } : how === 'seasonEnd' ? { kind: 'seasonal', phase: 'end' } : null;
  return { pack: T.nameEn, title: tt.titleAr, titleEn: tt.titleEn, instructions: tt.noteAr || null, minutes: tt.minutes, priority: tt.priority,
    target: kind === 'device' ? 'device' : 'room', recurrence, trigger };   // 5.4d: periodic device tasks stay device-targeted
}
