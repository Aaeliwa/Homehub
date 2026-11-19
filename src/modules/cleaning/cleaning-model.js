/**
 * Home Routine & Cleaning — PURE model (Phase 5.3). No Firebase, no DOM.
 *
 * TASK (cleaningTasks/{id}): what should be done and when. Recurrence:
 *   { kind: 'once' }                                     due on `dueDate` (defaults to startDate)
 *   { kind: 'days',   interval }                         every N days from startDate (1 = daily)
 *   { kind: 'weeks',  interval, weekdays: [0..6] }       chosen weekdays (0 = Sunday), every N weeks
 *   { kind: 'months', interval, dayOfMonth: 1..31 }      monthly; 31 → last day of shorter months
 * OCCURRENCE (cleaningOccurrences/{taskId}_{YYYYMMDD}): created only when someone ACTS (claim /
 * complete). Nothing is generated ahead, so there are no unbounded future records; the id is
 * deterministic, so a date can never be duplicated and the first claimer wins.
 * All dates are calendar dates ('YYYY-MM-DD') in the Home's time zone.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { normalizeText } from '../../core/utils/validate.js';
import { addDays, diffDays, isCalendarDate, daysInMonth, todayIn } from '../expenses/calendar.js';

export const CLEANING_SCHEMA_VERSION = 1;
export const PRIORITIES = Object.freeze(['low', 'normal', 'high']);
export const ASSIGN_MODES = Object.freeze(['assigned', 'shared']);
export const RECURRENCE_KINDS = Object.freeze(['once', 'days', 'weeks', 'months', 'after', 'onUse', 'onSeason']);
/** Phase 5.4b: device-triggered tasks (trigger metadata on the task; due status is DERIVED). */
export const TRIGGER_KINDS = Object.freeze(['afterUse', 'seasonal']);
export const SEASON_PHASES = Object.freeze(['active', 'start', 'end']);
/** 'after' (Phase 5.3.1): N days / months after the LAST COMPLETION (standalone template semantics). */
export const AFTER_LIMITS = Object.freeze({ day: 365, month: 12 });
export const LIMITS = Object.freeze({ title: 80, generatedTitle: 120, instructions: 1000, notes: 300, people: 5, interval: 52 });
export const WINDOW = Object.freeze({ pastDays: 60, futureDays: 14 });
const fail = (detail) => new AppError(ErrorCode.VALIDATION, { detail });

export const occurrenceId = (taskId, date) => `${taskId}_${date.replace(/-/g, '')}`;
export const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

// ---- recurrence --------------------------------------------------------------------------
export function validRecurrence(r) {
  if (!r || !RECURRENCE_KINDS.includes(r.kind)) return false;
  if (r.kind === 'once') return true;
  if (r.kind === 'onUse' || r.kind === 'onSeason') return Object.keys(r).length === 1;
  if (r.kind === 'after') return (r.unit === 'day' || r.unit === 'month') && Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= AFTER_LIMITS[r.unit];
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > LIMITS.interval) return false;
  if (r.kind === 'weeks') return Array.isArray(r.weekdays) && r.weekdays.length >= 1 && r.weekdays.length <= 7 && r.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) && new Set(r.weekdays).size === r.weekdays.length;
  if (r.kind === 'months') return Number.isInteger(r.dayOfMonth) && r.dayOfMonth >= 1 && r.dayOfMonth <= 31;
  return true;
}

/** Is `date` a due date of `task`? (start/end bounds, archived tasks excluded by callers) */
export function occursOn(task, date) {
  const r = task.recurrence || { kind: 'once' };
  if (date < task.startDate || (task.endDate && date > task.endDate)) return false;
  if (r.kind === 'once') return date === (task.dueDate || task.startDate);
  if (r.kind === 'after' || r.kind === 'onUse' || r.kind === 'onSeason') return false;   // completion- / event-driven: see buildBoard
  if (r.kind === 'days') return diffDays(task.startDate, date) % r.interval === 0;
  if (r.kind === 'weeks') {
    if (!r.weekdays.includes(weekday(date))) return false;
    const weekStart = (d) => addDays(d, -weekday(d));
    return Math.floor(diffDays(weekStart(task.startDate), weekStart(date)) / 7) % r.interval === 0;
  }
  if (r.kind === 'months') {
    const [sy, sm] = task.startDate.split('-').map(Number);
    const [y, m, d] = date.split('-').map(Number);
    const months = (y - sy) * 12 + (m - sm);
    return months % r.interval === 0 && d === Math.min(r.dayOfMonth, daysInMonth(y, m));
  }
  return false;
}

/** Hard bound on any scheduling range (days). Callers use far smaller windows. */
export const MAX_RANGE_DAYS = 400;

// ---- last-completion scheduling ('after') --------------------------------------------------
/** Add N months, clamping to the month end (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsClamped(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = (m - 1) + n; const ny = y + Math.floor(t / 12); const nm = ((t % 12) + 12) % 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, daysInMonth(ny, nm))).padStart(2, '0')}`;
}
export const addInterval = (date, unit, n) => (unit === 'month' ? addMonthsClamped(date, n) : addDays(date, n));
const toMillis = (x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : x && typeof x.seconds === 'number' ? x.seconds * 1000
  : typeof x === 'number' ? x : typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? Date.parse(x) : null);
/** Calendar date (Home time zone) a done occurrence was completed; pending server time → today. */
export function completionDate(occ, tz, today) {
  const ms = toMillis(occ.completedAt);
  return ms === null ? today : todayIn(tz, ms);
}
/**
 * Next due date of an 'after' task: latest completion date + interval; with no completion yet, the
 * task's start date. Overdue completion counts from the day it was DONE (standalone nextAfter(today)).
 * A reopened occurrence is simply no longer "done", so the date recomputes from the previous completion.
 */
export function afterNextDue(task, occurrences, tz, today) {
  // V6.3: progress before the schedule's start (a progress reset moves startDate) no longer counts.
  const done = occurrences.filter((o) => o.taskId === task.id && o.status === 'done' && !(o.dueDate < task.startDate));
  if (!done.length) return task.startDate;
  const last = done.map((o) => completionDate(o, tz, today)).sort().at(-1);
  const next = addInterval(last, task.recurrence.unit, task.recurrence.interval);
  return next < task.startDate ? task.startDate : next;
}
/** Days of occurrence history the store must keep to schedule 'after' tasks correctly. */
export function historyDaysNeeded(tasks) {
  let need = WINDOW.pastDays;
  for (const t of tasks) {
    const r = t.recurrence; if (!r || r.kind !== 'after' || t.active !== true) continue;
    need = Math.max(need, (r.unit === 'month' ? r.interval * 31 : r.interval) + 7);
  }
  return Math.min(need, MAX_RANGE_DAYS);
}

/** Due dates in [from, to]. Bounded: a range longer than MAX_RANGE_DAYS is refused, never truncated. */
export function dueDatesBetween(task, from, to) {
  const out = [];
  const start = from > task.startDate ? from : task.startDate;
  const span = diffDays(start, to);
  if (span > MAX_RANGE_DAYS) throw fail('cleaning.validation.range');
  for (let i = 0; i <= span; i++) {
    const d = addDays(start, i);
    if (occursOn(task, d)) out.push(d);
  }
  return out;
}

// ---- validation ----------------------------------------------------------------------------
export function validateTaskInput(input = {}, { memberUids = [], generated = false } = {}) {
  const errors = {};
  const title = normalizeText(input.title);
  if (!title) errors.title = 'cleaning.validation.titleRequired';
  else if (title.length > (generated ? LIMITS.generatedTitle : LIMITS.title)) errors.title = 'cleaning.validation.tooLong';
  const instructions = typeof input.instructions === 'string' && input.instructions.trim() ? input.instructions.trim() : null;
  if (instructions && instructions.length > LIMITS.instructions) errors.instructions = 'cleaning.validation.tooLong';
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  const assignMode = ASSIGN_MODES.includes(input.assignMode) ? input.assignMode : 'shared';
  const clean = (l) => [...new Set((l || []).filter(Boolean))].sort();
  const assigneeUids = assignMode === 'assigned' ? clean(input.assigneeUids) : [];
  const eligibleUids = assignMode === 'shared' ? clean(input.eligibleUids) : [];
  if (assignMode === 'assigned' && (assigneeUids.length < 1 || assigneeUids.length > LIMITS.people)) errors.assigneeUids = 'cleaning.validation.assignees';
  if (eligibleUids.length > LIMITS.people) errors.eligibleUids = 'cleaning.validation.assignees';
  if (memberUids.length && [...assigneeUids, ...eligibleUids].some((u) => !memberUids.includes(u))) errors.assigneeUids = 'cleaning.validation.notMember';
  const recurrence = normalizeRecurrence(input.recurrence);
  if (!validRecurrence(recurrence)) errors.recurrence = 'cleaning.validation.recurrence';
  const startDate = input.startDate;
  if (!isCalendarDate(startDate)) errors.startDate = 'cleaning.validation.date';
  const dueDate = recurrence && recurrence.kind === 'once' ? (input.dueDate || startDate) : null;
  if (dueDate !== null && (!isCalendarDate(dueDate) || dueDate < startDate)) errors.dueDate = 'cleaning.validation.dueBeforeStart';
  const endDate = input.endDate || null;
  if (endDate !== null && (!isCalendarDate(endDate) || endDate < startDate)) errors.endDate = 'cleaning.validation.endBeforeStart';
  const roomId = input.roomId || null;
  // Phase 5.4b: optional device trigger (immutable once saved). afterUse ⇒ recurrence onUse.
  let trigger = null;
  if (input.trigger) {
    const tr = input.trigger;
    if (!TRIGGER_KINDS.includes(tr.kind) || typeof tr.deviceId !== 'string' || !tr.deviceId) errors.trigger = 'cleaning.validation.trigger';
    else if (tr.kind === 'afterUse') { trigger = { kind: 'afterUse', deviceId: tr.deviceId }; if (!recurrence || recurrence.kind !== 'onUse') errors.recurrence = 'cleaning.validation.recurrence'; }
    else if (SEASON_PHASES.includes(tr.phase)) {
      trigger = { kind: 'seasonal', deviceId: tr.deviceId, phase: tr.phase };
      const ok = tr.phase === 'active' ? recurrence && !['onUse', 'onSeason', 'once'].includes(recurrence.kind) : recurrence && recurrence.kind === 'onSeason';
      if (!ok) errors.recurrence = 'cleaning.validation.recurrence';
    } else errors.trigger = 'cleaning.validation.trigger';
  } else if (recurrence && (recurrence.kind === 'onUse' || recurrence.kind === 'onSeason')) errors.recurrence = 'cleaning.validation.recurrence';
  // Phase 5.4d: optional plain device link. Not with a trigger (that device is trigger.deviceId) nor on a
  // generated task (its device is source.id). null = no device (an existing link is cleared).
  let deviceId = input.deviceId === undefined ? undefined : (typeof input.deviceId === 'string' && input.deviceId ? input.deviceId : null);
  if (deviceId && (trigger || input.source)) errors.deviceId = 'cleaning.validation.deviceLink';
  if (deviceId && !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) errors.deviceId = 'cleaning.validation.deviceLink';
  return { value: { title, instructions, roomId, priority, assignMode, assigneeUids, eligibleUids, recurrence, startDate, dueDate, endDate,
    ...(trigger ? { trigger } : {}), ...(deviceId !== undefined ? { deviceId } : {}) }, errors };
}

export function normalizeRecurrence(r) {
  if (!r) return null;
  const kind = r.kind;
  if (kind === 'once' || kind === 'onUse' || kind === 'onSeason') return { kind };
  // Only a MISSING interval defaults to 1; 0 / '' / NaN stay invalid (0 || 1 would silently become daily).
  const interval = r.interval === undefined || r.interval === null ? 1 : Number(r.interval);
  if (kind === 'days') return { kind, interval };
  if (kind === 'after') return { kind, unit: r.unit, interval };
  if (kind === 'weeks') return { kind, interval, weekdays: [...new Set((r.weekdays || []).map(Number))].sort((a, b) => a - b) };
  if (kind === 'months') return { kind, interval, dayOfMonth: Number(r.dayOfMonth) };
  return { kind };
}

export function buildTaskCreate({ input, uid, memberUids, now }) {
  const { value: v, errors } = validateTaskInput(input, { memberUids });
  if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
  const { deviceId, ...rest } = v;   // only written when set: tasks without a device keep their exact old shape
  return { ...rest, ...(deviceId ? { deviceId } : {}), active: true, archivedAt: null, archivedBy: null, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: CLEANING_SCHEMA_VERSION };
}
export const TASK_EDITABLE = Object.freeze(['title', 'instructions', 'roomId', 'priority', 'assignMode', 'assigneeUids', 'eligibleUids', 'recurrence', 'startDate', 'dueDate', 'endDate',
  'deviceId']);   // Phase 5.4d: plain device link (non-trigger tasks); may be changed or cleared

// ---- who may act ---------------------------------------------------------------------------
/** Mirrors the rules: complete permission + (assigned to me | shared & eligible). Shared with an
 *  empty list = every ADULT member; a child acts only when explicitly listed. */
export function mayAct(task, { uid, can, isChild }) {
  if (!can('cleaning.complete') || task.active !== true) return false;
  if (task.assignMode === 'assigned') return (task.assigneeUids || []).includes(uid);
  return (task.eligibleUids || []).length ? task.eligibleUids.includes(uid) : !isChild;
}

// ---- occurrence transitions (client side of the audited state machine) -----------------------
export const ACTIONS = Object.freeze({ claim: 'claimed', complete: 'done', unclaim: 'open', reopen: 'open',
  // Phase 5.4a (Advanced): recorded, never completion, never a change to the recurrence definition.
  skip: 'skipped', postpone: 'postponed', resume: 'open' });
/** Statuses each action may start from (mirrors the rules' update dispatch). */
export const ACTION_FROM = Object.freeze({
  claim: ['open', 'skipped'], complete: ['open', 'claimed', 'postponed', 'skipped'], unclaim: ['claimed'], reopen: ['done'],
  skip: ['open', 'skipped'], postpone: ['open', 'skipped'], resume: ['skipped', 'postponed'],
});
export const POSTPONE_MAX_DAYS = 30;
export const MINUTES_MAX = 600;

/**
 * Build the occurrence write + its log entry for an action. `occ` is the current doc or null.
 * Phase 5.4a extras: { minutes } (complete), { postponedTo, today } (postpone), { today } (skip).
 */
export function buildAction({ task, date, occ, action, uid, notes = null, now, minutes = null, postponedTo = null, today = null, occId = null, triggerEventId = null, triggerSeasonRev = null, taskGen = null }) {
  if (!ACTIONS[action]) throw fail('action');
  const status = occ ? occ.status : 'open';
  if (!ACTION_FROM[action].includes(status)) throw fail('cleaning.validation.stale');
  const n = typeof notes === 'string' ? notes.replace(/\s+/g, ' ').trim().slice(0, LIMITS.notes) : '';
  // V6.1: one-tap Reopen — the note is optional (rules already allow it); the audit entry is still written.
  let mins = null;
  if (action === 'complete' && minutes !== null && minutes !== undefined && minutes !== '') {
    mins = Number(minutes);
    if (!Number.isInteger(mins) || mins < 1 || mins > MINUTES_MAX) throw fail('cleaning.validation.minutes');
  }
  if (action === 'postpone') {
    if (!isCalendarDate(postponedTo) || !today || postponedTo <= today || diffDays(today, postponedTo) > POSTPONE_MAX_DAYS) throw fail('cleaning.validation.postponeDate');
  }
  if (action === 'skip' && !isCalendarDate(today)) throw fail('cleaning.validation.date');
  const rev = (occ ? occ.rev || 0 : 0) + 1;
  // Phase 5.4b: device-triggered occurrences have event/season ids (<task>_u<event>, <task>_s<rev>).
  const id = occ ? occ.id : (occId || occurrenceId(task.id, date));
  // V6.3.0.1: reset generation. Every occurrence write states the task generation it was decided under
  // (captured at confirmation for bulk actions); the rules refuse it if the task was reset meanwhile.
  // Generation 0 is written as "absent", so older documents and clients stay valid.
  const gen = Number.isInteger(taskGen) ? taskGen : (Number.isInteger(task.resetGen) ? task.resetGen : 0);
  const genField = gen > 0 || (occ && 'taskGen' in occ) ? { taskGen: gen } : {};
  const base = { status: ACTIONS[action], rev, updatedBy: uid, updatedAt: now, ...genField };
  let fields;
  if (action === 'claim') fields = { claimedBy: uid, claimedAt: now, completedBy: null, completedAt: null };
  else if (action === 'complete') fields = { completedBy: uid, completedAt: now, notes: n || null, ...(mins !== null ? { actualMinutes: mins } : {}) };
  else if (action === 'skip') fields = { skippedOn: today };
  else if (action === 'postpone') fields = { postponedTo };
  else if (action === 'resume') fields = { skippedOn: null, postponedTo: null };
  else fields = { claimedBy: null, claimedAt: null, completedBy: null, completedAt: null };
  const data = occ ? { ...base, ...fields } : {
    taskId: task.id, dueDate: date, status: base.status, rev, claimedBy: null, claimedAt: null, completedBy: null, completedAt: null, notes: null,
    ...fields, ...(triggerEventId ? { triggerEventId } : {}), ...(Number.isInteger(triggerSeasonRev) ? { triggerSeasonRev } : {}),
    createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: CLEANING_SCHEMA_VERSION, ...genField };
  const log = { id: `${id}_r${rev}`, data: { occurrenceId: id, taskId: task.id, rev, action, actorUid: uid, at: now, notes: n || null, schemaVersion: CLEANING_SCHEMA_VERSION,
    ...(mins !== null ? { actualMinutes: mins } : {}), ...(action === 'postpone' ? { postponedTo } : {}) } };
  return { id, create: !occ, data, log };
}

// ---- dashboard buckets ----------------------------------------------------------------------
/**
 * Items for today's dashboard. Missed policy: for each task only the MOST RECENT missed due date
 * (after its last completion) is actionable ("overdue"); older misses are counted, not listed, so
 * a week away never produces a pile of daily chores.
 */
export function buildBoard({ tasks, occurrences, today, uid, can, isChild, roomFilter = 'all', tz = 'UTC', isVisible = () => true, roomOf = (t) => t.roomId || null,
  deviceEvents = [], deviceStates = new Map() }) {
  const dev = deviceIndex(deviceEvents, deviceStates, tz, today);
  const byId = new Map(occurrences.map((o) => [o.id, o]));
  const items = []; const missedCounts = {};
  const from = addDays(today, -WINDOW.pastDays); const to = addDays(today, WINDOW.futureDays);
  for (const t of tasks) {
    // Hidden while its room/device is archived (standalone: paused room / inactive device); history kept.
    if (t.active !== true || !isVisible(t) || (roomFilter !== 'all' && (roomOf(t) || 'none') !== roomFilter)) continue;
    // Phase 5.4b: device-triggered tasks.
    if (t.trigger) {
      if (t.trigger.kind === 'afterUse') { items.push(...afterUseItems(t, occurrences, dev, tz, today)); continue; }
      if (t.trigger.kind === 'seasonal' && t.trigger.phase !== 'active') { items.push(...seasonPhaseItems(t, byId, dev, today)); continue; }
      if (t.trigger.kind === 'seasonal' && dev.state(t.trigger.deviceId).state !== 'active') continue;   // off-season: not due (history kept)
    }
    if (t.recurrence && t.recurrence.kind === 'after') {
      const mine = occurrences.filter((o) => o.taskId === t.id && !(o.dueDate < t.startDate));   // V6.3: pre-reset progress ignored
      let next = afterNextDue(t, mine, tz, today);
      // Seasonal (in-season) task: never due before the season started — the basis itself is unchanged.
      if (t.trigger && t.trigger.kind === 'seasonal') { const since = dev.state(t.trigger.deviceId).since; if (since && next < since) next = since; }
      const occN = byId.get(occurrenceId(t.id, next)) || null;
      // Phase 5.4a: postponed → shown on its new date; skipped → suppressed ONLY on the day it was
      // skipped (the completion basis is unchanged, so the task is still due afterwards).
      if (occN && occN.status === 'postponed' && occN.postponedTo) {
        const p = occN.postponedTo;
        if (p <= to) items.push(itemFor(t, next, occN, p < today ? 'overdue' : p === today ? 'today' : 'upcoming', p));
        for (const o of mine.filter((x) => x.status === 'done' && completionDate(x, tz, today) === today)) items.push(itemFor(t, o.dueDate, o, 'today'));
        continue;
      }
      // Completed today: keep it in today's progress (it would otherwise move straight to "upcoming").
      for (const o of mine.filter((x) => x.status === 'done' && completionDate(x, tz, today) === today)) items.push(itemFor(t, o.dueDate, o, 'today'));
      for (const o of mine.filter((x) => x.status === 'done' && completionDate(x, tz, today) < today && completionDate(x, tz, today) >= addDays(today, -7))) items.push(itemFor(t, o.dueDate, o, 'completed'));
      if (next <= to) {
        const skippedToday = occN && occN.status === 'skipped' && occN.skippedOn === today;
        items.push(itemFor(t, next, occN, skippedToday ? 'today' : next < today ? 'overdue' : next === today ? 'today' : 'upcoming'));
      }
      continue;
    }
    const since = t.trigger && t.trigger.kind === 'seasonal' ? dev.state(t.trigger.deviceId).since : null;
    const dates = dueDatesBetween(t, from, to).filter((d) => !since || d >= since);
    const occOf = (d) => byId.get(occurrenceId(t.id, d)) || null;
    const lastDone = dates.filter((d) => d <= today && occOf(d) && occOf(d).status === 'done').at(-1) || null;
    // Fixed-calendar: a SKIPPED date is handled (never "missed"); a POSTPONED date moves to postponedTo.
    const handled = (o) => o && (o.status === 'done' || o.status === 'skipped' || o.status === 'postponed');
    const missed = dates.filter((d) => d < today && (!lastDone || d > lastDone) && !handled(occOf(d)));
    for (const d of dates) {
      const o = occOf(d);
      if (o && o.status === 'postponed' && o.postponedTo && o.postponedTo <= to) {
        const p = o.postponedTo;
        items.push(itemFor(t, d, o, p < today ? 'overdue' : p === today ? 'today' : 'upcoming', p));
      }
    }
    if (missed.length) { missedCounts[t.id] = missed.length; const d = missed.at(-1); items.push(itemFor(t, d, occOf(d), 'overdue')); }
    for (const d of dates.filter((x) => x >= today && !(occOf(x) && occOf(x).status === 'postponed'))) items.push(itemFor(t, d, occOf(d), d === today ? 'today' : 'upcoming'));
    for (const d of dates.filter((x) => x < today && occOf(x) && occOf(x).status === 'done' && x >= addDays(today, -7))) items.push(itemFor(t, d, occOf(d), 'completed'));
  }
  const mine = (it) => it.occ && it.occ.status === 'claimed' ? it.occ.claimedBy === uid : (it.task.assignMode === 'assigned' && it.task.assigneeUids.includes(uid));
  const actionable = (it) => it.bucket !== 'completed' && !(it.occ && (it.occ.status === 'done' || (it.occ.status === 'skipped' && (it.occ.skippedOn === today || !(it.task.recurrence && it.task.recurrence.kind === 'after')))));
  const todayItems = items.filter((i) => i.bucket === 'today');
  return {
    today: todayItems,
    overdue: items.filter((i) => i.bucket === 'overdue'),
    upcoming: items.filter((i) => i.bucket === 'upcoming').sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 50),
    completed: [...items.filter((i) => i.occ && i.occ.status === 'done' && (i.bucket === 'completed' || i.bucket === 'today'))].sort((a, b) => (a.date < b.date ? 1 : -1)),
    mine: items.filter((i) => actionable(i) && (i.bucket === 'today' || i.bucket === 'overdue') && mine(i)),
    sharedAvailable: items.filter((i) => actionable(i) && (i.bucket === 'today' || i.bucket === 'overdue') && i.task.assignMode === 'shared' && !(i.occ && i.occ.status === 'claimed') && mayAct(i.task, { uid, can, isChild })),
    progress: { done: todayItems.filter((i) => i.occ && i.occ.status === 'done').length, total: todayItems.length },
    missedCounts,
  };
}
/** `date` = the occurrence's due date; `showDate` = where it is shown (postponedTo when postponed). */
function itemFor(task, date, occ, bucket, showDate = date, extra = {}) { return { key: `${task.id}|${extra.occId || date}`, task, date, showDate, occ, bucket, ...extra }; }

// ---- Phase 5.4b: device usage & seasons (derived; nothing here writes) ----------------------
const msOf = (x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : x && typeof x.seconds === 'number' ? x.seconds * 1000 : typeof x === 'number' ? x : typeof x === 'string' ? Date.parse(x) : NaN);
/**
 * Index of device events + season states. A device with no state document is OFF-season
 * (conservative default). Voided uses (a 'void' event naming them) never count.
 */
export function deviceIndex(events = [], states = new Map(), tz = 'UTC', today = null) {
  const voided = new Set(events.filter((e) => e.kind === 'void' && e.voidsEventId).map((e) => e.voidsEventId));
  const uses = new Map();
  for (const e of events) {
    if (e.kind !== 'use' || voided.has(e.id)) continue;
    const ms = msOf(e.at); const at = Number.isFinite(ms) ? ms : Date.now();       // pending server time → now
    if (!uses.has(e.deviceId)) uses.set(e.deviceId, []);
    uses.get(e.deviceId).push({ ...e, ms: at, day: todayIn(tz, at) });
  }
  for (const l of uses.values()) l.sort((a, b) => a.ms - b.ms || String(a.id).localeCompare(String(b.id)));
  const stateOf = (id) => {
    const s = states instanceof Map ? states.get(id) : (states || {})[id];
    if (!s || s.state !== 'active' && s.state !== 'inactive') return { state: 'inactive', rev: s ? s.rev || 0 : 0, since: null };
    const ms = msOf(s.updatedAt);
    return { state: s.state, rev: s.rev || 0, since: Number.isFinite(ms) ? todayIn(tz, ms) : today };
  };
  return { uses: (id) => uses.get(id) || [], state: stateOf };
}
/**
 * After-use task: uses since the task's last completion COALESCE into one occurrence, keyed by the
 * FIRST pending use (<task>_u<eventId>) — deterministic for every member. Done resolves it; the next
 * use after that starts a new one. Each use stays in the event history.
 */
function afterUseItems(t, occurrences, dev, tz, today) {
  const mine = occurrences.filter((o) => o.taskId === t.id);
  const lastDone = mine.filter((o) => o.status === 'done').map((o) => msOf(o.completedAt)).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), -Infinity);
  // Only uses on/after the task's start date count (a task cannot be due before it existed).
  const pending = dev.uses(t.trigger.deviceId).filter((u) => u.ms > lastDone && u.day >= t.startDate);
  const out = [];
  for (const o of mine.filter((x) => x.status === 'done' && Number.isFinite(msOf(x.completedAt)) && todayIn(tz, msOf(x.completedAt)) === today)) out.push(itemFor(t, o.dueDate, o, 'today', o.dueDate, { occId: o.id }));
  if (!pending.length) return out;
  const first = pending[0]; const occId = `${t.id}_u${first.id}`;
  const occ = mine.find((o) => o.id === occId) || null;
  const extra = { occId, triggerEventId: first.id, usesSince: pending.length };
  if (occ && occ.status === 'postponed' && occ.postponedTo) {
    const p = occ.postponedTo; out.push(itemFor(t, first.day, occ, p < today ? 'overdue' : p === today ? 'today' : 'upcoming', p, extra)); return out;
  }
  const skippedToday = occ && occ.status === 'skipped' && occ.skippedOn === today;
  out.push(itemFor(t, first.day, occ, skippedToday ? 'today' : first.day < today ? 'overdue' : 'today', first.day, extra));
  return out;
}
/** Season start / end checklist: due once per transition into the matching state (<task>_s<rev>). */
function seasonPhaseItems(t, byId, dev, today) {
  const st = dev.state(t.trigger.deviceId);
  const want = t.trigger.phase === 'start' ? 'active' : 'inactive';
  if (st.state !== want || !st.rev) return [];
  const occId = `${t.id}_s${st.rev}`; const occ = byId.get(occId) || null;
  const day = [st.since || today, t.startDate].sort().at(-1);   // never before the task existed
  const extra = { occId, triggerSeasonRev: st.rev };
  if (occ && occ.status === 'done') return [itemFor(t, day, occ, day === today ? 'today' : 'completed', day, extra)];
  if (occ && occ.status === 'postponed' && occ.postponedTo) { const p = occ.postponedTo; return [itemFor(t, day, occ, p < today ? 'overdue' : p === today ? 'today' : 'upcoming', p, extra)]; }
  const skippedToday = occ && occ.status === 'skipped' && occ.skippedOn === today;
  return [itemFor(t, day, occ, skippedToday ? 'today' : day < today ? 'overdue' : 'today', day, extra)];
}

// ---------------------------------------------------------------- V6.1: current-room bulk actions (pure)
/** Reset = the existing inverse action, so history and recurrence behave exactly as a manual undo. */
export function resetActionFor(occ) {
  const st = occ ? occ.status : 'open';
  return st === 'done' ? 'reopen' : st === 'claimed' ? 'unclaim' : (st === 'skipped' || st === 'postponed') ? 'resume' : null;
}
const exOfItem = (it) => (it.occId ? { occId: it.occId, triggerEventId: it.triggerEventId || null, triggerSeasonRev: Number.isInteger(it.triggerSeasonRev) ? it.triggerSeasonRev : null } : {});
const roomItems = (board, roomId, roomOf) => [...board.overdue, ...board.today].filter((it) => (roomOf ? roomOf(it.task) : it.task.roomId) === roomId);
/** Actionable pending items in ONE room that this user may complete (same rights as the per-item Done). */
export function completeAllItems(board, roomId, { uid, can, isChild, roomOf } = {}) {
  return roomItems(board, roomId, roomOf).filter((it) => {
    const st = it.occ ? it.occ.status : 'open';
    // V6.3: no claim-before-completion — a claimed occurrence is completable by anyone eligible for the task.
    return ['open', 'claimed', 'postponed', 'skipped'].includes(st) && mayAct(it.task, { uid, can, isChild });
  }).map((it) => ({ taskId: it.task.id, date: it.date, extra: exOfItem(it) }));
}
/** Items in ONE room this user may reset, each with its inverse action (same rights as the per-item undo). */
export function resetAllItems(board, roomId, { uid, can, isChild, roomOf } = {}) {
  return roomItems(board, roomId, roomOf).filter((it) => {
    const a = resetActionFor(it.occ); if (!a) return false;
    const o = it.occ;
    if (a === 'reopen') return o.completedBy === uid || can('cleaning.edit');
    if (a === 'unclaim') return o.claimedBy === uid || can('cleaning.edit');
    return o.updatedBy === uid || mayAct(it.task, { uid, can, isChild }) || can('cleaning.edit');
  }).map((it) => ({ taskId: it.task.id, date: it.date, action: resetActionFor(it.occ), extra: exOfItem(it) }));
}

