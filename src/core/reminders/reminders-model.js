/**
 * Smart Reminders (Phase 5.6) — PURE. Reminders are DERIVED from the existing Cleaning and
 * Maintenance data with those modules' own due logic (buildBoard / planStatus / nextDue); nothing
 * is copied into a second task store and nothing here can change a task, plan, fault or cost.
 * Only per-user presentation state (read / dismissed / snoozed) is persisted elsewhere.
 */
import { buildBoard, mayAct } from '../../modules/cleaning/cleaning-model.js';
import { planStatus, nextDue } from '../../modules/maintenance/maintenance-model.js';
import { addDays } from '../../modules/expenses/calendar.js';
import { calendarReminders, commitmentReminders } from '../upcoming/upcoming-model.js';

export const LOOK_AHEAD = Object.freeze([1, 3, 7, 14]);
// V6.4.1 Stage B: `calendar` / `commitments` toggles (absent on older preference documents → on).
export const PREF_DEFAULTS = Object.freeze({ lookAheadDays: 3, cleaning: true, maintenancePlans: true, maintenanceFaults: true, calendar: true, commitments: true, quietStart: null, quietEnd: null });
export const STATES = Object.freeze(['read', 'dismissed', 'snoozed']);
const SEV = { critical: 0, high: 1, medium: 2, low: 3 };
const ORDER = { overdue: 0, today: 1, openFault: 2, upcoming: 3 };

export function prefsOf(doc) {
  const p = { ...PREF_DEFAULTS };
  if (doc) {
    if (LOOK_AHEAD.includes(doc.lookAheadDays)) p.lookAheadDays = doc.lookAheadDays;
    for (const k of ['cleaning', 'maintenancePlans', 'maintenanceFaults', 'calendar', 'commitments']) if (typeof doc[k] === 'boolean') p[k] = doc[k];
    for (const k of ['quietStart', 'quietEnd']) if (Number.isInteger(doc[k]) && doc[k] >= 0 && doc[k] <= 23) p[k] = doc[k];
  }
  return p;
}

/** FNV-1a 64 (hex) — deterministic, collision-resistant state-document ids. */
export function fnv64(str) {
  let h = 0xcbf29ce484222325n; const P = 0x100000001b3n; const M = (1n << 64n) - 1n;
  for (const b of new TextEncoder().encode(str)) { h ^= BigInt(b); h = (h * P) & M; }
  return h.toString(16).padStart(16, '0');
}
export const stateDocId = (uid, key) => `${uid}_${fnv64(key)}`;
const ymd = (d) => d.replace(/-/g, '');

/**
 * Derive the reminders a user may act on / see. `cleaning` / `maintenance` are null when the user
 * lacks that module's view permission (then nothing — not even a count — comes from it).
 */
export function deriveReminders({ cleaning, maintenance, events = null, commitments = null, nowMin = 0, today, tz, uid, can, isChild, isVisible = () => true, roomOf = (t) => t.roomId || null, deviceOf = () => null, prefs = PREF_DEFAULTS }) {
  const out = []; const seen = new Set();
  const horizon = addDays(today, prefs.lookAheadDays);
  const push = (r) => { if (!seen.has(r.key)) { seen.add(r.key); out.push(r); } };
  if (cleaning && prefs.cleaning) {
    const board = buildBoard({ tasks: cleaning.tasks, occurrences: cleaning.occurrences, today, uid, can, isChild, tz, isVisible, roomOf,
      deviceEvents: cleaning.deviceEvents || [], deviceStates: cleaning.deviceStates || new Map() });
    // V6.2: ONE Home-level "Pending cleaning tasks" reminder instead of one per task. Identity is
    // per Home day (`c:pending@<today>`): it is reused as counts change (no new toast per task, tab,
    // re-render or device), disappears when nothing is pending, and a new day is a new reminder.
    // Scheduling / completion are untouched — this is presentation only.
    const actionable = (it) => { const st = it.occ ? it.occ.status : 'open';
      return st !== 'done' && !(st === 'skipped' && (it.occ.skippedOn === today || !(it.task.recurrence && it.task.recurrence.kind === 'after'))); };
    const pending = [...board.overdue, ...board.today].filter((it) => actionable(it) && mayAct(it.task, { uid, can, isChild }));
    const tasks = new Set(pending.map((it) => it.task.id));
    if (tasks.size) {
      const overdue = pending.some((it) => it.bucket === 'overdue');
      const rooms = new Set(pending.map((it) => roomOf(it.task)).filter(Boolean)).size;
      push({ key: `c:pending@${today}`, sourceKind: 'cleaning', bucket: overdue ? 'overdue' : 'today', date: today,
        title: 'Pending cleaning tasks', titleKey: 'reminders.cleaningPending', count: tasks.size, rooms, priority: 'normal', roomId: null, deviceId: null,
        target: { module: 'cleaning', view: overdue ? 'overdue' : 'today' } });
    }
  }
  if (maintenance && prefs.maintenancePlans) {
    for (const p of maintenance.plans) {
      const st = planStatus(p, today); if (st === 'archived' || st === 'completed') continue;
      const n = nextDue(p); if (st === 'upcoming' && n > horizon) continue;
      push({ key: `p:${p.id}@${n}`, sourceKind: 'maintenancePlan', bucket: st === 'overdue' ? 'overdue' : st === 'dueToday' ? 'today' : 'upcoming',
        date: n, title: p.title, priority: p.priority || 'normal', deviceId: p.deviceId, roomId: null, target: { module: 'maintenance', planId: p.id } });
    }
  }
  if (maintenance && prefs.maintenanceFaults) {
    for (const f of maintenance.faults) {
      if (f.status !== 'open' && f.status !== 'inProgress') continue;
      push({ key: `f:${f.id}@r${f.rev}`, sourceKind: 'maintenanceFault', bucket: 'openFault', date: null,   // faults have no due date — never fabricated
        title: f.summary, severity: f.severity, faultStatus: f.status, deviceId: f.deviceId, roomId: null, target: { module: 'maintenance', faultId: f.id } });
    }
  }
  // V6.4.1 Stage B: Calendar (only events with a reminder, once it is due) and Finance commitments.
  // `events` / `commitments` are null when the user cannot view that module — then nothing, not even a count.
  if (events && prefs.calendar !== false) for (const r of calendarReminders(events, { today, nowMin })) push(r);
  if (commitments && prefs.commitments !== false) for (const r of commitmentReminders(commitments, { today, lookAheadDays: prefs.lookAheadDays })) push(r);
  return out.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket]
    || (a.bucket === 'openFault' ? (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9) : String(a.date).localeCompare(String(b.date)) || String(a.time || '').localeCompare(String(b.time || '')))
    || String(a.title).localeCompare(String(b.title)));
}

/**
 * Apply presentation state. presentation: unread | read | dismissed | snoozed. A snooze ends ON
 * `snoozeUntil` (Home date) → the reminder returns unread. Source records are never touched.
 */
export function applyState(reminders, states, today) {
  const byKey = new Map(states.map((s) => [s.key, s]));
  return reminders.map((r) => {
    const s = byKey.get(r.key);
    const presentation = !s ? 'unread' : s.state === 'snoozed' ? (s.snoozeUntil && s.snoozeUntil > today ? 'snoozed' : 'unread') : s.state;
    return { ...r, presentation, snoozeUntil: s && s.state === 'snoozed' ? s.snoozeUntil : null };
  });
}
export const isShown = (r) => r.presentation === 'unread' || r.presentation === 'read';
export function counts(items) {
  const shown = items.filter(isShown);
  return { actionable: shown.length, unread: shown.filter((r) => r.presentation === 'unread').length,
    hidden: items.length - shown.length, overdue: shown.filter((r) => r.bucket === 'overdue').length };
}
/** Quiet hours (Home-local hour). start == end or unset → never quiet; may wrap past midnight. */
export function isQuiet(prefs, hour) {
  const { quietStart: s, quietEnd: e } = prefs;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s === e) return false;
  return s < e ? hour >= s && hour < e : hour >= s || hour < e;
}
/** Stale presentation state to delete (bounded): key no longer current AND older than 30 days. */
export function staleStates(states, currentKeys, nowMs, { maxAgeDays = 30, limit = 20 } = {}) {
  const cur = new Set(currentKeys);
  const ms = (x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : typeof x === 'string' ? Date.parse(x) : NaN);
  return states.filter((s) => !cur.has(s.key) && Number.isFinite(ms(s.updatedAt)) && nowMs - ms(s.updatedAt) > maxAgeDays * 86400000).slice(0, limit);
}
