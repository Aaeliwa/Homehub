/**
 * Unified Upcoming (V6.4.1 Stage B) — PURE. One model for the Dashboard "Upcoming" panel, the Contacts
 * activity panel and the Calendar / Finance part of Reminders. Every item is DERIVED from data the caller
 * already holds (the shared Calendar, Finance, Cleaning and Maintenance stores of the CURRENT Home, which only
 * contain what the rules let this user read — private events of others never arrive). Nothing here reads or
 * writes Firestore, and nothing changes a source record.
 *
 * Dates are LOCAL Home dates ('YYYY-MM-DD') and times LOCAL Home clock times ('HH:MM'), as stored by Calendar.
 *
 * Buckets: overdue (actionable and in the past) · today · upcoming (within the horizon).
 * "Overdue" is only for things someone still has to do: an undone Calendar task, a planned contact activity,
 * an unpaid commitment, cleaning / maintenance as their own modules say. A plain past event is just past.
 */
import { isLive, lastDate, covers, isActivity, statusOf, isOpenItem, reminderOf, startClock, kindOf } from '../../modules/calendar/calendar-model.js';
import { upcoming as commitmentsDue } from '../../modules/expenses/ledger.js';
import { addDays } from '../../modules/expenses/calendar.js';
import { deriveReminders } from '../reminders/reminders-model.js';

export const DASHBOARD_HORIZON = 7;        // days ahead on the Dashboard (fixed: independent of reminder settings)
export const CONTACT_HORIZON = 30;         // days ahead in a contact's activity panel
export const OVERDUE_LOOKBACK = 60;        // open Calendar items older than this are not listed as overdue (bounded)
export const BUCKETS = Object.freeze(['overdue', 'today', 'upcoming']);
const ORDER = { overdue: 0, today: 1, upcoming: 2 };

/** Home-local minutes since midnight (0–1439) for `now`. */
export function nowMinutesIn(timeZone, now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(now);
  const v = (k) => Number((p.find((x) => x.type === k) || {}).value || 0);
  return (v('hour') % 24) * 60 + v('minute');
}
export const clockMin = (hhmm) => { const m = /^(\d{2}):(\d{2})$/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
const pad = (n) => String(n).padStart(2, '0');
export const minClock = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

export function sortItems(items) {
  return items.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || String(a.date).localeCompare(String(b.date))
    || String(a.time || '').localeCompare(String(b.time || '')) || String(a.title).localeCompare(String(b.title)) || String(a.key).localeCompare(String(b.key)));
}

// ------------------------------------------------------------------------------------------- Calendar
/**
 * Calendar events → Upcoming items. One item per event (a multi-day event appears once: on its start date, or
 * as "today" while it is running). Done tasks, done / cancelled activities and deleted events are left out.
 * opts.contactId: only that contact's activities (Contacts panel).
 */
export function calendarItems(events, { today, horizonDays = DASHBOARD_HORIZON, contactId = null } = {}) {
  const horizon = addDays(today, horizonDays); const floor = addDays(today, -OVERDUE_LOOKBACK);
  const out = [];
  for (const e of events || []) {
    if (!isLive(e)) continue;
    if (contactId !== null && !(isActivity(e) && e.contactId === contactId)) continue;
    const st = statusOf(e);
    if (st === 'cancelled' || st === 'done' || (e.type === 'task' && e.done)) continue;
    if (e.startDate > horizon) continue;
    let bucket;
    if (covers(e, today)) bucket = 'today';
    else if (e.startDate > today) bucket = 'upcoming';
    else if (isOpenItem(e) && lastDate(e) < today && e.startDate >= floor) bucket = 'overdue';
    else continue;                                                    // a plain past event: just past
    out.push({ key: `e:${e.id}@${e.startDate}`, source: isActivity(e) ? 'contactActivity' : 'calendar', id: e.id, title: e.title, bucket,
      date: bucket === 'today' ? today : e.startDate, startDate: e.startDate, time: e.allDay ? null : e.startTime, allDay: !!e.allDay,
      category: isActivity(e) ? 'activity' : e.type, status: isActivity(e) ? st : e.type === 'task' ? 'open' : null,
      contactId: isActivity(e) ? e.contactId : null, private: e.audience === 'private', reminderMinutes: reminderOf(e),
      target: { module: 'calendar', date: e.startDate, eventId: e.id } });
  }
  return out;
}

// ------------------------------------------------------------------------------------------- Finance
/**
 * Active commitments → items: the NEXT due date only (one row per commitment; the series advances when it is
 * paid — Finance's own recurrence logic). Amounts only when the caller may see financial totals.
 */
export function commitmentItems(commitments, { today, horizonDays = DASHBOARD_HORIZON, showAmounts = false } = {}) {
  return commitmentsDue(commitments || [], today, horizonDays).map((c) => ({
    key: `m:${c.id}@${c.nextDueDate}`, source: 'commitment', id: c.id, title: c.name, bucket: c.overdue ? 'overdue' : c.nextDueDate === today ? 'today' : 'upcoming',
    date: c.nextDueDate, time: null, allDay: true, category: c.category || null, status: c.overdue ? 'overdue' : 'due',
    amountMinor: showAmounts ? c.amountMinor : null, currency: showAmounts ? c.currency : null, private: (c.audience ?? 'household') !== 'household',
    target: { module: 'expenses', tab: 'commitments', commitmentId: c.id } }));
}

// -------------------------------------------------------------------------------- Cleaning / Maintenance
/**
 * Re-uses the Reminders derivation (the modules' own due logic) WITHOUT the user's reminder preferences or
 * read / dismissed / snoozed state: Dashboard visibility is independent of notification eligibility.
 * Cleaning stays ONE "Pending cleaning tasks" item; open faults have no date and are not "upcoming".
 */
export function homeCareItems({ cleaning, maintenance, today, tz, uid, can, isChild, isVisible, roomOf, deviceOf, horizonDays = DASHBOARD_HORIZON }) {
  if (!cleaning && !maintenance) return [];
  const prefs = { lookAheadDays: horizonDays, cleaning: true, maintenancePlans: true, maintenanceFaults: false, calendar: false, commitments: false, quietStart: null, quietEnd: null };
  return deriveReminders({ cleaning, maintenance, today, tz, uid, can, isChild, isVisible, roomOf, deviceOf, prefs })
    .filter((r) => r.bucket !== 'openFault')
    .map((r) => ({ key: r.key, source: r.sourceKind, id: r.key, title: r.title, titleKey: r.titleKey || null, count: r.count ?? null, rooms: r.rooms ?? null,
      bucket: r.bucket, date: r.date, time: null, allDay: true, category: r.sourceKind === 'cleaning' ? 'cleaning' : 'maintenance', status: r.bucket, priority: r.priority || null,
      deviceId: r.deviceId || null, private: false, target: r.target }));
}

/** Everything for the Dashboard panel, de-duplicated by key and sorted (overdue → today → upcoming → date → time → title). */
export function deriveUpcoming({ events = null, commitments = null, homeCare = null, today, horizonDays = DASHBOARD_HORIZON, showAmounts = false }) {
  const all = [...(events ? calendarItems(events, { today, horizonDays }) : []), ...(commitments ? commitmentItems(commitments, { today, horizonDays, showAmounts }) : []), ...(homeCare || [])];
  const seen = new Set(); const out = [];
  for (const it of all) if (!seen.has(it.key)) { seen.add(it.key); out.push(it); }
  return sortItems(out);
}

// --------------------------------------------------------------------------------- Reminder eligibility
/**
 * The moment a Calendar reminder becomes due, as a local 'YYYY-MM-DD HH:MM' string (comparable as text):
 * start − reminderMinutes; all-day events use 09:00 Home time of the start date as the reference.
 */
export function reminderDueAt(e) {
  const off = reminderOf(e); if (off === null) return null;
  let date = e.startDate; let min = clockMin(startClock(e)) - off;
  while (min < 0) { min += 1440; date = addDays(date, -1); }
  return `${date} ${minClock(min)}`;
}
/**
 * Calendar items eligible as REMINDERS now: a reminder is set, the reminder moment has passed, the item is not
 * done / cancelled, and the event has not ended (open tasks / planned activities stay while overdue, bounded).
 */
export function calendarReminders(events, { today, nowMin }) {
  const now = `${today} ${minClock(nowMin)}`; const floor = addDays(today, -OVERDUE_LOOKBACK);
  const out = [];
  for (const e of events || []) {
    if (!isLive(e) || reminderOf(e) === null) continue;
    const st = statusOf(e);
    if (st === 'cancelled' || st === 'done' || (e.type === 'task' && e.done)) continue;
    const due = reminderDueAt(e); if (!due || due > now) continue;
    const running = covers(e, today);
    const overdue = !running && lastDate(e) < today;
    if (overdue && !(isOpenItem(e) && e.startDate >= floor)) continue;   // a plain past event: its reminder is over
    out.push({ key: `e:${e.id}@${e.startDate}`, sourceKind: 'calendarEvent', bucket: overdue ? 'overdue' : running ? 'today' : 'upcoming', date: e.startDate,
      time: e.allDay ? null : e.startTime, title: e.title, priority: 'normal', roomId: null, deviceId: null, kind: kindOf(e), contactId: isActivity(e) ? e.contactId : null,
      target: { module: 'calendar', date: e.startDate, eventId: e.id } });
  }
  return out;
}
/** The next FUTURE reminder moment ('YYYY-MM-DD HH:MM') among live events — lets the feed recompute exactly then. */
export function nextReminderAt(events, { today, nowMin }) {
  const now = `${today} ${minClock(nowMin)}`; let next = null;
  for (const e of events || []) {
    if (!isLive(e) || reminderOf(e) === null || statusOf(e) === 'cancelled' || statusOf(e) === 'done' || (e.type === 'task' && e.done)) continue;
    const due = reminderDueAt(e); if (due && due > now && (!next || due < next)) next = due;
  }
  return next;
}
/** Commitments eligible as reminders: overdue, or due within the user's look-ahead. */
export function commitmentReminders(commitments, { today, lookAheadDays }) {
  return commitmentsDue(commitments || [], today, lookAheadDays).map((c) => ({
    key: `m:${c.id}@${c.nextDueDate}`, sourceKind: 'commitment', bucket: c.overdue ? 'overdue' : c.nextDueDate === today ? 'today' : 'upcoming',
    date: c.nextDueDate, title: c.name, priority: 'normal', roomId: null, deviceId: null, target: { module: 'expenses', tab: 'commitments', commitmentId: c.id } }));
}
