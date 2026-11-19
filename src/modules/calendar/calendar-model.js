/**
 * Calendar (V6.2) — PURE model. Events store LOCAL wall-clock dates/times plus the Home time zone
 * (`timezone`), so a date never shifts. Date coverage policy (used by the grid AND by Finance):
 *   an event covers every local date from startDate through endDate INCLUSIVE, except that a
 *   timed event ending exactly at 00:00 on a later day does not cover that last day.
 * A multi-day shift is shown on each date it touches; it is never treated as a continuous
 * 24-hour work block (hours are kept as given, not expanded).
 */
import { addDays, isCalendarDate } from '../expenses/calendar.js';

export const TYPES = Object.freeze(['work', 'vacation', 'task', 'reminder', 'other']);
/**
 * V6.2.2 shift subtype. Recognised ONLY from an explicit label at the start of the title ("Day Shift",
 * "night  shift – Plant A"; case / whitespace-insensitive) — never from times of day or gaps. Stored as
 * `shift: 'day' | 'night' | null`; a shift is always Work. Older events without the field are read by
 * the same rule (nothing rewritten). An explicit null (user override) wins over detection.
 */
export const SHIFTS = Object.freeze(['day', 'night']);
export function detectShift(title) { const m = /^\s*(day|night)\s+shift(?![a-z])/i.exec(String(title || '')); return m ? m[1].toLowerCase() : null; }
export const shiftOf = (e) => (e && e.shift !== undefined ? (SHIFTS.includes(e.shift) ? e.shift : null) : detectShift(e && e.title));
export const LIMITS = Object.freeze({ title: 120, description: 1000, location: 200, importRows: 500, importBytes: 200000 });
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const fail = (detail, fields) => Object.assign(new Error(detail), { code: 'validation', detail, fields });
const txt = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '');

// ---------------------------------------------------------------- validation
export function validateEvent(input = {}) {
  const errors = {};
  const title = txt(input.title);
  if (!title) errors.title = 'calendar.err.title'; else if (title.length > LIMITS.title) errors.title = 'calendar.err.tooLong';
  // shift: undefined / 'auto' → detect from the title; null / 'none' → explicitly not a shift; 'day' | 'night'
  const shift = input.shift === undefined || input.shift === 'auto' ? detectShift(title) : SHIFTS.includes(input.shift) ? input.shift : null;
  const type = shift ? 'work' : TYPES.includes(input.type) ? input.type : 'other';
  const allDay = input.allDay === true;
  const startDate = input.startDate; const endDate = input.endDate || input.startDate;
  if (!isCalendarDate(startDate)) errors.startDate = 'calendar.err.date';
  if (!isCalendarDate(endDate)) errors.endDate = 'calendar.err.date';
  const startTime = allDay ? null : (input.startTime || null); const endTime = allDay ? null : (input.endTime || null);
  if (!allDay && (!TIME.test(startTime || '') || !TIME.test(endTime || ''))) errors.time = 'calendar.err.time';
  if (!errors.startDate && !errors.endDate) {
    if (endDate < startDate) errors.endDate = 'calendar.err.order';
    else if (!allDay && !errors.time && endDate === startDate && endTime <= startTime && type !== 'reminder') errors.time = 'calendar.err.order';
  }
  const description = txt(input.description); if (description.length > LIMITS.description) errors.description = 'calendar.err.tooLong';
  const location = txt(input.location); if (location.length > LIMITS.location) errors.location = 'calendar.err.tooLong';
  const audience = input.audience === 'private' ? 'private' : 'household';
  return { value: { title, type, shift, allDay, startDate, startTime, endDate, endTime, description: description || null, location: location || null, audience }, errors };
}
export const EDITABLE = Object.freeze(['title', 'type', 'shift', 'allDay', 'startDate', 'startTime', 'endDate', 'endTime', 'description', 'location']);
export function createDoc(v, { uid, now, timezone, source = 'manual', sourceKey = null, importBatchId = null }) {
  return { ...v, timezone, done: false, source, sourceKey, importBatchId, importRev: importBatchId ? 1 : null,
    deletedAt: null, deletedBy: null, rev: 1, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
}

// ------------------------------------------------------------------ V6.2.1 CSV import batches
/** Soft-delete writes per Firestore batch (well under the 500-write limit; bounded rule evaluation). */
export const REMOVE_CHUNK = 20;
export const BATCH_STATUS = Object.freeze(['importing', 'active', 'removing', 'removed']);
export function batchDoc({ fileName, audience, uid, now }) {
  const name = String(fileName || '').trim().slice(0, 200);
  return { fileName: name || 'CSV', audience: audience === 'private' ? 'private' : 'household', status: 'importing', createdCount: 0, removedCount: 0, keptCount: 0,
    rev: 1, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
}
/** Changed after import (edit, done…)? importRev = the revision the import (or re-import) left. */
export const isEdited = (e) => (e.rev || 1) > (e.importRev ?? 1);
/** Events PROVEN to belong to a batch (by their stored importBatchId — never by title / date). */
export const batchMembers = (all, batchId) => (typeof batchId === 'string' && batchId ? all.filter((e) => e.importBatchId === batchId) : []);
/** V6.2 imports made before batches existed: shown ungrouped, deletable one by one only. */
export const ungroupedImports = (all) => all.filter((e) => isLive(e) && e.source === 'csv' && !e.importBatchId);
/** Removal plan: live members, minus (optionally) those edited after import. */
export function removalPlan(all, batchId, { keepEdited = true } = {}) {
  const live = batchMembers(all, batchId).filter(isLive);
  const edited = live.filter(isEdited);
  return { targets: keepEdited ? live.filter((e) => !isEdited(e)) : live, edited, keep: keepEdited ? edited : [] };
}
/** Re-import of a previously removed row (same fingerprint id): restore it into the NEW batch. */
export function reviveDoc(cur, v, { uid, now, importBatchId }) {
  const p = {}; for (const k of EDITABLE) p[k] = v[k] ?? null;
  const rev = (cur.rev || 1) + 1;
  return { ...p, done: false, deletedAt: null, deletedBy: null, importBatchId, importRev: rev, rev, updatedBy: uid, updatedAt: now };
}
export function editPatch(cur, v, { uid, now }) {
  const p = {}; for (const k of EDITABLE) if ((cur[k] ?? null) !== (v[k] ?? null)) p[k] = v[k] ?? null;
  return Object.keys(p).length ? { ...p, rev: (cur.rev || 0) + 1, updatedBy: uid, updatedAt: now } : null;
}
export const isLive = (e) => !!e && !e.deletedAt;

// ---------------------------------------------------------------- date coverage
/** Last local date the event covers (see policy above). */
export function lastDate(e) {
  if (!e.allDay && e.endTime === '00:00' && e.endDate > e.startDate) return addDays(e.endDate, -1);
  return e.endDate;
}
export const covers = (e, date) => e.startDate <= date && date <= lastDate(e);
/** Events touching a date range [from, to] (inclusive), live only. */
export const inRange = (events, from, to) => events.filter((e) => isLive(e) && e.startDate <= to && lastDate(e) >= from);
export function eventsOn(events, date) {
  return events.filter((e) => isLive(e) && covers(e, date)).sort((a, b) => (a.allDay === b.allDay ? String(a.startTime).localeCompare(String(b.startTime)) : a.allDay ? -1 : 1) || a.title.localeCompare(b.title));
}

/**
 * Finance ↔ Calendar contract: stable intervals by id, inclusive LOCAL dates (same policy).
 * kind: 'work' | 'vacation'. Only explicitly typed events count — off-duty gaps are NEVER vacation.
 */
export function intervals(events, kind) {
  // V6.2.2: day / night shifts are ALWAYS Work and never Vacation, whatever their stored type.
  const match = kind === 'work' ? (e) => e.type === 'work' || !!shiftOf(e) : kind === 'vacation' ? (e) => e.type === 'vacation' && !shiftOf(e) : (e) => e.type === kind;
  return events.filter((e) => isLive(e) && match(e)).map((e) => ({ id: e.id, title: e.title, start: e.startDate, end: lastDate(e) }))
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}
/** A date is inside the union of intervals (overlaps never double-count: membership, not sums). */
export const inAny = (ivs, date) => ivs.some((i) => i.start <= date && date <= i.end);

/** Gaps of ≥1 whole day between consecutive work intervals → "Unclassified off-duty" SUGGESTIONS. */
export function offDutyGaps(events, { minDays = 1 } = {}) {
  const work = intervals(events, 'work'); const vac = intervals(events, 'vacation');
  const merged = [];
  for (const w of work) { const last = merged[merged.length - 1]; if (last && w.start <= addDays(last.end, 1)) { if (w.end > last.end) last.end = w.end; } else merged.push({ ...w }); }
  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    const start = addDays(merged[i - 1].end, 1); const end = addDays(merged[i].start, -1);
    if (end < start) continue;
    const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
    if (days < minDays) continue;
    const confirmed = vac.some((v) => v.start <= start && v.end >= end);
    gaps.push({ start, end, days, confirmed });
  }
  return gaps;
}

// ---------------------------------------------------------------- month grid (Monday-first)
export function monthGrid(ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`; const dow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;   // Mon = 0
  const start = addDays(first, -dow); const days = [];
  for (let i = 0; i < 42; i++) days.push(addDays(start, i));
  return days.slice(0, days[35].slice(0, 7) === ym ? 42 : 35);
}
export function shiftMonth(ym, n) { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }
export function weekOf(date) { const [y, m, d] = date.split('-').map(Number); const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; const s = addDays(date, -dow); return Array.from({ length: 7 }, (_, i) => addDays(s, i)); }

// ---------------------------------------------------------------- CSV (RFC 4180: quotes, "" escapes, CRLF, BOM)
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, ''); const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (q) throw fail('calendar.import.badQuotes');
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const COLS = ['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All Day Event', 'Description', 'Location', 'Private'];
/** "1/5/2026" → "2026-01-05" (US M/D/YYYY, as Google Calendar exports). */
export function usDate(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim()); if (!m) return null;
  const d = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; return isCalendarDate(d) ? d : null;
}
/** "7:00:00 PM" / "7:00 AM" → "19:00". */
export function usTime(v) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])$/.exec(String(v || '').trim()); if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]); if (h < 1 || h > 12 || min > 59) return null;
  const pm = /p/i.test(m[4]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
const truthy = (v) => /^(true|yes|1)$/i.test(String(v || '').trim());
/** Default classification (user-editable in the preview): shifts → work; explicit leave words → vacation. */
export function classify(subject) {
  const s = String(subject || '').toLowerCase();
  if (/\bshift\b|وردي|نوبت/.test(s)) return 'work';
  if (/vacation|holiday|\bleave\b|إجاز|اجاز|عطلة/.test(s)) return 'vacation';
  if (/remind|تذكير/.test(s)) return 'reminder';
  return 'other';
}
/** Stable import identity: 16 hex chars (FNV-1a 64) of the normalized source fields. */
export function fingerprint(r) {
  const key = [r.title.toLowerCase(), r.startDate, r.startTime || '', r.endDate, r.endTime || '', r.allDay ? 1 : 0].join('|');
  let h = 0xcbf29ce484222325n; for (const ch of new TextEncoder().encode(key)) { h ^= BigInt(ch); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}
export const importId = (sourceKey) => `csv_${sourceKey}`;

/**
 * Google Calendar CSV → preview rows. Blank lines ignored. Each row: { line, ok, errors[], value, sourceKey, id, private }.
 * `existingIds`: ids already in Firestore (live or deleted) → marked duplicate, never rewritten.
 */
export function previewImport(text, { existingIds = new Set(), removedIds = new Set() } = {}) {
  if (String(text || '').length > LIMITS.importBytes) throw fail('calendar.import.tooBig');
  const rows = parseCsv(text);
  if (!rows.length) throw fail('calendar.import.empty');
  const head = rows[0].map((c) => c.trim()); const ix = Object.fromEntries(COLS.map((c) => [c, head.indexOf(c)]));
  for (const c of ['Subject', 'Start Date', 'End Date']) if (ix[c] < 0) throw fail('calendar.import.columns');
  const out = []; const seen = new Set(); let blank = 0;
  rows.slice(1).forEach((r, i) => {
    const get = (c) => (ix[c] >= 0 ? String(r[ix[c]] ?? '').trim() : '');
    if (r.every((c) => !String(c).trim())) { blank++; return; }
    if (out.length >= LIMITS.importRows) throw fail('calendar.import.tooMany');
    const errors = []; const allDay = truthy(get('All Day Event'));
    const startDate = usDate(get('Start Date')); const endDate = usDate(get('End Date')) || startDate;
    const startTime = allDay ? null : usTime(get('Start Time')); const endTime = allDay ? null : usTime(get('End Time'));
    if (!startDate) errors.push('calendar.err.date');
    if (!allDay && (!startTime || !endTime)) errors.push('calendar.err.time');
    const { value, errors: ve } = validateEvent({ title: get('Subject'), type: classify(get('Subject')), allDay, startDate, startTime, endDate, endTime,
      description: get('Description'), location: get('Location') });
    for (const e of Object.values(ve)) if (!errors.includes(e)) errors.push(e);
    const sourceKey = errors.length ? null : fingerprint(value); const id = sourceKey && importId(sourceKey);
    const dupInFile = !!id && seen.has(id); if (id) seen.add(id);
    out.push({ line: i + 2, ok: !errors.length, errors, value, sourceKey, id, private: truthy(get('Private')),
      duplicate: !!id && (existingIds.has(id) || dupInFile), removed: !!id && !dupInFile && removedIds.has(id) });
  });
  return { rows: out, blank };
}

// ------------------------------------------------------------------ V6.2.2 multi-day bars (month grid)
/** An event drawn as a bar: it covers 2+ calendar dates (timed events ending 00:00 exclude that day). */
export const isMultiDay = (e) => lastDate(e) > e.startDate;
/**
 * Bar segments for ONE week row (7 consecutive dates), clipped to the month `ym` (out-of-month cells get
 * no bar) and to the row. Lanes are assigned greedily (earlier start first, then longer, then id) so
 * overlapping spans stack. Returns { segs: [{ event, from, to, lane, contBefore, contAfter, startsHere }],
 * lanes, hidden: { [date]: n } } with segments beyond `maxLanes` counted in `hidden` (for "+N").
 */
export function weekBars(events, days, ym, maxLanes = 3) {
  const inMonth = days.map((d) => d.slice(0, 7) === ym);
  const first = inMonth.indexOf(true); const last = inMonth.lastIndexOf(true);
  if (first < 0) return { segs: [], lanes: 0, hidden: {} };
  const lo = days[first]; const hi = days[last];
  const segs = events.filter((e) => isLive(e) && isMultiDay(e) && e.startDate <= hi && lastDate(e) >= lo).map((e) => {
    const s = e.startDate < lo ? lo : e.startDate; const t = lastDate(e) > hi ? hi : lastDate(e);
    return { event: e, from: days.indexOf(s), to: days.indexOf(t), contBefore: e.startDate < s, contAfter: lastDate(e) > t, startsHere: e.startDate === s };
  }).sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || String(a.event.id).localeCompare(String(b.event.id)));
  const lanesEnd = [];
  for (const g of segs) { let l = lanesEnd.findIndex((end) => end < g.from); if (l < 0) { l = lanesEnd.length; lanesEnd.push(-1); } lanesEnd[l] = g.to; g.lane = l; }
  const hidden = {};
  for (const g of segs) if (g.lane >= maxLanes) for (let i = g.from; i <= g.to; i++) hidden[days[i]] = (hidden[days[i]] || 0) + 1;
  return { segs: segs.filter((g) => g.lane < maxLanes), lanes: Math.min(lanesEnd.length, maxLanes), hidden };
}
