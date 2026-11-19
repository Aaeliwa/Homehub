/**
 * Advanced Cleaning (Phase 5.4a) — PURE logic shared by the Advanced screen. No Firebase, no DOM.
 * Ported from the standalone app's behaviour (homeCleaning.html: buildRoutine / ensureRoutine /
 * quickPick / loadStats / DEFAULTS) onto HomeHub's single cleaning model:
 *   - the day's routine SELECTION is saved once (cleaningRoutines/{date}) and stays stable;
 *     statuses (done / claimed / reopened / skipped / postponed / assignment) are always LIVE,
 *     read from the shared tasks + occurrences — there is no second completion store;
 *   - statistics come from the append-only audit log (cleaningLog);
 *   - quick routines and whole-room views are computed, never stored.
 */
import { todayIn } from '../expenses/calendar.js';
import { occurrenceId } from './cleaning-model.js';

/** Standalone DEFAULTS (homeCleaning.html: `const DEFAULTS = { catchUpMax: 2, startHour: 3 }`). */
export const SETTINGS_DEFAULTS = Object.freeze({ catchUpMax: 2, startHour: 3 });
export const SETTINGS_LIMITS = Object.freeze({ catchUpMax: [0, 10], startHour: [0, 6] });
export const ROUTINE_MAX = 200;
export const DEFAULT_MINUTES = 5;      // standalone: tt.minutes || 5
const PRI = { high: 3, normal: 2, low: 1 };

export function settingsOf(doc) {
  const v = { ...SETTINGS_DEFAULTS };
  if (doc && Number.isInteger(doc.catchUpMax) && doc.catchUpMax >= 0 && doc.catchUpMax <= 10) v.catchUpMax = doc.catchUpMax;
  if (doc && Number.isInteger(doc.startHour) && doc.startHour >= 0 && doc.startHour <= 6) v.startHour = doc.startHour;
  return v;
}
export function validateSettings(input) {
  const errors = {}; const out = {};
  for (const [k, [lo, hi]] of Object.entries(SETTINGS_LIMITS)) {
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) errors[k] = `cleaning.validation.${k}`; else out[k] = n;
  }
  return { value: out, errors };
}

/** The routine day: the Home's calendar date, but the day starts at `startHour` (standalone). */
export const routineDate = (tz, startHour, nowMs = Date.now()) => todayIn(tz, nowMs - startHour * 3600 * 1000);

/** Stable key of a planned occurrence (its deterministic occurrence id). */
export const planKey = (it) => it.occId || occurrenceId(it.task.id, it.date);   // device items: <task>_u<event> / <task>_s<rev>

/**
 * Select the day's routine from a board (buildBoard output, computed for the routine day):
 * all of today (except skipped today), all HIGH-priority overdue, plus up to `catchUpMax` other
 * overdue by score (days overdue × priority) — the standalone buildRoutine rule. Max 200.
 */
export function buildRoutinePlan({ board, today, catchUpMax }) {
  const live = (it) => !(it.occ && it.occ.status === 'skipped' && it.occ.skippedOn === today);
  const todays = board.today.filter((it) => live(it) && !(it.occ && it.occ.status === 'done' && it.date !== today));
  const overdue = board.overdue.filter(live);
  const high = overdue.filter((it) => it.task.priority === 'high');
  const score = (it) => (Date.parse(today) - Date.parse(it.showDate || it.date)) / 86400000 * (PRI[it.task.priority] || 2);
  const rest = overdue.filter((it) => it.task.priority !== 'high').sort((a, b) => score(b) - score(a)).slice(0, catchUpMax);
  const keys = []; const seen = new Set();
  for (const it of [...todays, ...high, ...rest]) { const k = planKey(it); if (!seen.has(k)) { seen.add(k); keys.push(k); } }
  return keys.slice(0, ROUTINE_MAX);
}

/** Resolve a SAVED plan against live data: same selection, live status per occurrence. */
export function routineItems({ plan, tasks, occurrences, isVisible = () => true }) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const occById = new Map(occurrences.map((o) => [o.id, o]));
  return plan.map((key) => {
    const cut = key.lastIndexOf('_'); const taskId = key.slice(0, cut); const suffix = key.slice(cut + 1);
    const task = taskById.get(taskId) || null;
    const occ = occById.get(key) || null;
    // Date ids <task>_<YYYYMMDD>; Phase 5.4b device ids <task>_u<eventId> / <task>_s<rev>.
    const isDate = /^[0-9]{8}$/.test(suffix);
    const date = isDate ? `${suffix.slice(0, 4)}-${suffix.slice(4, 6)}-${suffix.slice(6, 8)}` : occ ? occ.dueDate : null;
    const trig = isDate ? {} : suffix[0] === 'u' ? { triggerEventId: suffix.slice(1) } : suffix[0] === 's' ? { triggerSeasonRev: Number(suffix.slice(1)) } : {};
    // V6.3: an item dated before the task's (reset) schedule start is no longer part of it — never resurrected.
    const stale = task && !task.trigger && isDate && date < task.startDate;
    const reason = !task ? 'missing' : task.active !== true ? 'archived' : !isVisible(task) ? 'hidden' : stale ? 'reset' : null;
    const state = reason ? 'inactive' : occ ? occ.status : 'open';
    return { key, task, date, occ, state, reason, occId: key, ...trig };
  });
}

/**
 * V6.4: what Today's routine SHOWS. The day's plan (cleaningRoutines/{day}) is saved once and is create-only,
 * so after a progress reset / restore-defaults / archive it still names keys that are no longer part of any
 * schedule (dates before the restarted startDate, archived / removed / hidden tasks). Those are NOT current
 * work: they are excluded from the actionable list (and from Mark All / progress), counted once as
 * `obsolete`, and their occurrences + audit log stay untouched (history / statistics). Valid current work
 * that the stored plan does not name (e.g. the restarted schedule's date) comes from the live board as
 * `extras`, so nothing valid is dropped and nothing is listed twice.
 */
export function routineView({ plan, tasks, occurrences, board, isVisible = () => true }) {
  const all = routineItems({ plan, tasks, occurrences, isVisible });
  const items = all.filter((it) => it.state !== 'inactive');
  const obsolete = all.filter((it) => it.state === 'inactive');
  const shownKeys = new Set(items.map((it) => it.key));
  const extras = []; const seen = new Set();
  for (const it of [...(board ? board.today : []), ...(board ? board.overdue : [])]) {
    const key = it.occId || `${it.task.id}_${String(it.date).replace(/-/g, '')}`;
    if (shownKeys.has(key) || seen.has(key)) continue;
    // V6.4.0-a review: normalise the board item's state exactly like a plan item (occurrence status, else
    // 'open'), so extras are counted by the same rules (skipped / postponed out of the total, done = done).
    seen.add(key); extras.push({ ...it, key, state: it.occ ? it.occ.status : 'open' });
  }
  // Progress / empty state are computed over EXACTLY what is shown (current plan items + extras), each key
  // once — never over the raw saved plan (whose obsolete keys are not shown) and never over extras twice.
  const shown = [...items, ...extras];
  return { items, obsolete, extras, shown, progress: routineProgress(shown) };
}

/**
 * V6.4.0-a review: one consistent summary for the progress text, the bar and the empty state.
 *  - 'empty'    nothing shown at all                         → "Nothing to clean today"
 *  - 'settled'  only skipped / postponed items are shown     → "Nothing left today (n skipped, n postponed)"
 *  - 'progress' otherwise                                    → "{done} of {total} done today", bar = done / total
 */
export function routineSummary(view) {
  const p = view.progress;
  const kind = !view.shown.length ? 'empty' : p.total === 0 ? 'settled' : 'progress';
  const pct = p.total ? Math.round((p.done / p.total) * 100) : kind === 'settled' ? 100 : 0;
  return { kind, done: p.done, total: p.total, skipped: p.skipped, postponed: p.postponed, pct };
}
export function routineProgress(items) {
  const counted = items.filter((i) => i.state !== 'inactive' && i.state !== 'skipped' && i.state !== 'postponed');
  return { done: counted.filter((i) => i.state === 'done').length, total: counted.length,
    skipped: items.filter((i) => i.state === 'skipped').length, postponed: items.filter((i) => i.state === 'postponed').length };
}

/** Standalone quickPick: tasks that fit `minutes`, by priority then longest overdue, greedily. */
export function quickPick(items, minutes) {
  const budget = Number(minutes); if (!Number.isFinite(budget) || budget <= 0) return [];
  const est = (it) => (Number.isInteger(it.task.estimatedMinutes) ? it.task.estimatedMinutes : DEFAULT_MINUTES);
  const sorted = [...items].sort((a, b) => (PRI[b.task.priority] || 2) - (PRI[a.task.priority] || 2) || String(a.date).localeCompare(String(b.date)));
  const out = []; let used = 0;
  for (const it of sorted) { const m = est(it); if (used + m <= budget) { out.push(it); used += m; } }
  return { items: out, minutes: used };
}

/**
 * Statistics from audit-log entries (cleaningLog) — completions per day / member / room, time
 * (actual minutes, else the task's estimate), skips, postponements, reopenings.
 */
export function computeStats({ log, tasks, tz, roomOf = (t) => t.roomId || null, days = 30, today }) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const toMs = (x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : x && typeof x.seconds === 'number' ? x.seconds * 1000 : typeof x === 'number' ? x : Date.parse(x));
  const st = { completions: 0, minutes: 0, skips: 0, postpones: 0, reopens: 0, byDay: {}, byMember: {}, byRoom: {} };
  for (const e of log) {
    const ms = toMs(e.at); if (!Number.isFinite(ms)) continue;
    const day = todayIn(tz, ms);
    if (today && (Date.parse(today) - Date.parse(day)) / 86400000 >= days) continue;
    if (e.action === 'skip') { st.skips++; continue; }
    if (e.action === 'postpone') { st.postpones++; continue; }
    if (e.action === 'reopen') { st.reopens++; continue; }
    if (e.action !== 'complete') continue;
    const t = taskById.get(e.taskId);
    const m = Number.isInteger(e.actualMinutes) ? e.actualMinutes : t && Number.isInteger(t.estimatedMinutes) ? t.estimatedMinutes : DEFAULT_MINUTES;
    st.completions++; st.minutes += m;
    st.byDay[day] = (st.byDay[day] || 0) + 1;
    st.byMember[e.actorUid] = (st.byMember[e.actorUid] || 0) + 1;
    const r = (t && roomOf(t)) || 'none'; st.byRoom[r] = (st.byRoom[r] || 0) + 1;
  }
  // A completion later reopened stays counted as an event, and the reopen is reported alongside it.
  return st;
}
