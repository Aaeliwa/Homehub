/**
 * Rooms & Devices → Cleaning integration — PURE (Phase 5.3.1).
 * Adapts the standalone Cleaning app's template workflow (homeCleaning.html: createRooms / missingFor /
 * syncType / deviceTaskDoc / syncDeviceType) to HomeHub's data and rules:
 *   - templates come from cleaning-templates.js (extracted verbatim; stable keys);
 *   - HomeHub room types / device subtypes map onto the template types below;
 *   - one task per (room|device, template key) with a DETERMINISTIC id → duplicates are impossible
 *     (repeated setup, two people at once); an ARCHIVED generated task is the "removed by the user"
 *     tombstone (standalone `appliedKeys`) → never recreated;
 *   - an existing task in the same room with the same (Arabic or English) title "covers" a template
 *     task (standalone: `t.title === tt.title`);
 *   - first due dates are staggered like the standalone (offset = n % min(period, 7)).
 * Nothing here writes; the store commits the reviewed plan.
 */
import { ROOM_TEMPLATES, DEVICE_TEMPLATES, TEMPLATE_VERSION } from './cleaning-templates.js';
import { addDays } from '../expenses/calendar.js';

/** HomeHub room type → standalone room template (unmapped types: manual tasks only). */
export const ROOM_TYPE_MAP = Object.freeze({
  living_room: 'living', bedroom: 'bedroom', master_bedroom: 'bedroom', kids_room: 'bedroom',
  kitchen: 'kitchen', bathroom: 'bathroom', balcony: 'balcony', entrance: 'entrance', hallway: 'entrance',
});
/** HomeHub device subtype → standalone device template. */
export const DEVICE_SUBTYPE_MAP = Object.freeze({
  split_ac: 'ac', window_ac: 'ac', portable_ac: 'ac', central_ac: 'ac',
  refrigerator: 'fridge', freezer: 'fridge', dishwasher: 'dishwasher', air_fryer: 'airfryer',
  vacuum_cleaner: 'vacuum', robot_vacuum: 'vacuum', microwave: 'microwave', oven: 'stove', cooker: 'stove',
});

export const generatedTaskId = (kind, sourceId, templateKey) => `${kind === 'room' ? 'r' : 'd'}_${sourceId}_${templateKey}`;
export const roomTemplateFor = (room) => ROOM_TEMPLATES.find((T) => T.key === ROOM_TYPE_MAP[room.type]) || null;
export const deviceTemplateFor = (device) => DEVICE_TEMPLATES.find((T) => T.key === DEVICE_SUBTYPE_MAP[device.subtype]) || null;
export const periodDays = (f) => (!f ? 0 : f.unit === 'day' ? f.n : f.n * 30);   // standalone periodDays (day / month)

/**
 * Phase 5.4b: how a template task is generated (null = still deferred, key kept in the library).
 *   periodic (non-seasonal device)      → 'periodic'   recurrence after{unit, n}
 *   afterUse / afterCycle               → 'afterUse'   recurrence onUse, trigger afterUse
 *   seasonal device, periodic (active)  → 'seasonalActive'  recurrence after, trigger seasonal/active
 *   seasonal device, phase start / end  → 'seasonStart' / 'seasonEnd'  recurrence onSeason
 *   conditionBased / manual (non-seasonal) → deferred (no safe trigger model yet)
 */
export function generatableAs(T, tt) {
  if (T.mode === 'seasonal') {
    if (tt.phase === 'start') return 'seasonStart';
    if (tt.phase === 'end') return 'seasonEnd';
    if (tt.trigger === 'periodic' && tt.freq) return 'seasonalActive';
    return null;
  }
  if (tt.trigger === 'afterUse' || tt.trigger === 'afterCycle') return 'afterUse';
  if (tt.trigger === 'periodic' && tt.freq) return 'periodic';
  return null;
}
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The reviewable plan: for every ACTIVE room/device with a mapped template, which template tasks
 * would be added, which are already present (any state), which are covered by an equivalent task,
 * and how many are deferred to a later phase. Order is stable (rooms by name, devices by name).
 */
export function buildSetupPlan({ rooms = [], devices = [], tasks = [] }) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const titlesByRoom = new Map();
  for (const t of tasks) {
    const k = t.roomId || (t.source && t.source.kind === 'device' ? `device:${t.source.id}` : null);
    if (!k) continue;
    if (!titlesByRoom.has(k)) titlesByRoom.set(k, new Map());
    titlesByRoom.get(k).set(norm(t.title), t);
  }
  const groups = [];
  const consider = (kind, src, T, scopeKeys) => {
    const add = []; const present = []; const covered = []; const deferred = [];
    for (const tt of T.tasks) {
      const how = kind === 'room' ? (tt.generate ? 'periodic' : null) : generatableAs(T, tt);
      if (!how) { deferred.push(tt); continue; }
      const id = generatedTaskId(kind, src.id, tt.key);
      if (byId.has(id)) { present.push({ template: tt, task: byId.get(id) }); continue; }
      const eq = scopeKeys.map((k) => titlesByRoom.get(k)).filter(Boolean)
        .map((m) => m.get(norm(tt.titleAr)) || m.get(norm(tt.titleEn))).find(Boolean);
      if (eq) { covered.push({ template: tt, task: eq }); continue; }
      add.push({ id, template: tt });
    }
    groups.push({ kind, source: src, template: T, add, present, covered, deferred });
  };
  for (const r of [...rooms].filter((x) => x.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const T = roomTemplateFor(r); if (T) consider('room', r, T, [r.id]);
  }
  for (const d of [...devices].filter((x) => x.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const T = deviceTemplateFor(d); if (T) consider('device', d, T, [`device:${d.id}`, ...(d.roomId ? [d.roomId] : [])]);
  }
  const pending = groups.filter((g) => g.add.length);
  return { groups, pending, addCount: pending.reduce((n, g) => n + g.add.length, 0) };
}

/** Task document for one template task (active, or archived when the user declined it). */
export function buildGeneratedTask({ kind, source, template, item, lang, uid, now, today, offset, declined = false }) {
  const tt = item.template;
  const how = kind === 'room' ? 'periodic' : generatableAs(template, tt);
  const recurrence = how === 'afterUse' ? { kind: 'onUse' } : (how === 'seasonStart' || how === 'seasonEnd') ? { kind: 'onSeason' }
    : { kind: 'after', unit: tt.freq.unit, interval: tt.freq.n };
  const trigger = how === 'afterUse' ? { kind: 'afterUse', deviceId: source.id }
    : how === 'seasonalActive' ? { kind: 'seasonal', deviceId: source.id, phase: 'active' }
    : how === 'seasonStart' ? { kind: 'seasonal', deviceId: source.id, phase: 'start' }
    : how === 'seasonEnd' ? { kind: 'seasonal', deviceId: source.id, phase: 'end' } : null;
  return {
    title: lang === 'en' ? tt.titleEn : tt.titleAr,
    instructions: lang === 'en' ? null : tt.noteAr || null,      // notes exist in Arabic only in the standalone library
    roomId: kind === 'room' ? source.id : null,                   // device tasks follow the device's CURRENT room
    priority: tt.priority, assignMode: 'shared', assigneeUids: [], eligibleUids: [],
    recurrence,
    ...(trigger ? { trigger } : {}),   // Phase 5.4b (immutable; due status is derived)
    startDate: addDays(today, offset), dueDate: null, endDate: null,
    active: !declined, archivedAt: declined ? now : null, archivedBy: declined ? uid : null,
    source: { kind, id: source.id, typeKey: template.key, templateKey: tt.key, templateVersion: TEMPLATE_VERSION },
    estimatedMinutes: tt.minutes,
    createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1,
  };
}

/** Writes for the reviewed plan: `accepted` = Set of task ids to add active; the rest of `add` is declined. */
export function planWrites({ plan, accepted, lang, uid, now, today }) {
  const writes = []; const sp = { n: 0 };
  for (const g of plan.pending) {
    for (const item of g.add) {
      const p = periodDays(item.template.freq);   // tasks without a frequency (use / season triggered) start now
      const offset = p > 1 ? (sp.n++) % Math.min(p, 7) : 0;
      writes.push({ id: item.id, data: buildGeneratedTask({ kind: g.kind, source: g.source, template: g.template, item, lang, uid, now, today, offset, declined: !accepted.has(item.id) }) });
    }
  }
  return writes;
}

/** Phase 5.4d: the device a task belongs to — trigger device, plain link, or a generated task's source device. */
export function linkedDeviceId(task) {
  if (!task) return null;
  if (task.trigger && task.trigger.deviceId) return task.trigger.deviceId;
  if (task.deviceId) return task.deviceId;
  if (task.source && task.source.kind === 'device') return task.source.id;
  return null;
}
/** Is a generated task's room/device currently active? Manual tasks: always true. Plain device links
 *  (deviceId) stay visible when the device is archived — labelled, never hidden (history is kept). */
export function sourceActive(task, { roomById, deviceById }) {
  // Phase 5.4b: a task triggered by a device is hidden while that device is archived (history kept).
  if (task.trigger && task.trigger.deviceId) { const d = deviceById(task.trigger.deviceId); if (!d || d.active === false) return false; }
  if (!task.source) return true;
  const s = task.source.kind === 'room' ? roomById(task.source.id) : deviceById(task.source.id);
  return !!s && s.active !== false;
}
/** Effective room: device tasks follow the device's current room (fixes the standalone stale copy). */
export function effectiveRoomId(task, { deviceById }) {
  // Phase 5.4d: an explicit room is kept; device-linked tasks with no room follow the device's CURRENT room.
  if (task.roomId && !task.trigger && !(task.source && task.source.kind === 'device')) return task.roomId;
  const devId = linkedDeviceId(task);
  if (devId) { const d = deviceById(devId); return d ? d.roomId || null : null; }
  return task.roomId || null;
}

/** Generated titles come verbatim from the standalone library (longest English: 83). Rules: ≤ 120. */
export const GENERATED_TITLE_MAX = 120;
const GEN_KEYS = ['title', 'instructions', 'roomId', 'priority', 'assignMode', 'assigneeUids', 'eligibleUids', 'recurrence', 'startDate', 'dueDate', 'endDate',
  'active', 'archivedAt', 'archivedBy', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'schemaVersion', 'source', 'estimatedMinutes'].sort();
/**
 * Client-side mirror of the rules' cleanGeneratedOk (shape only; membership/room/device existence
 * are proven by the server). Returns a list of problems — empty = sendable.
 */
export function generatedPayloadProblems({ id, data: d }) {
  const p = [];
  if (JSON.stringify(Object.keys(d).filter((k) => k !== 'trigger').sort()) !== JSON.stringify(GEN_KEYS)) p.push('keys');
  if (!(typeof d.title === 'string' && d.title.trim() && d.title.length <= GENERATED_TITLE_MAX)) p.push('title');
  if (!(d.instructions === null || (typeof d.instructions === 'string' && d.instructions.trim() && d.instructions.length <= 1000))) p.push('instructions');
  if (!['low', 'normal', 'high'].includes(d.priority)) p.push('priority');
  if (!(d.assignMode === 'shared' && d.assigneeUids.length === 0 && d.eligibleUids.length === 0)) p.push('assignment');
  const r = d.recurrence || {};
  const tr = d.trigger || null;
  const periodicOk = r.kind === 'after' && Number.isInteger(r.interval) && r.interval >= 1 && (r.unit === 'day' ? r.interval <= 365 : r.unit === 'month' && r.interval <= 12);
  const recOk = !tr ? periodicOk
    : tr.kind === 'afterUse' ? (r.kind === 'onUse' && Object.keys(r).length === 1)
    : tr.kind === 'seasonal' && tr.phase === 'active' ? periodicOk
    : tr.kind === 'seasonal' && (tr.phase === 'start' || tr.phase === 'end') ? (r.kind === 'onSeason' && Object.keys(r).length === 1) : false;
  if (!recOk) p.push('recurrence');
  if (tr && !(d.source && d.source.kind === 'device' && tr.deviceId === d.source.id && Object.keys(tr).every((k) => ['kind', 'deviceId', 'phase'].includes(k)))) p.push('trigger');
  if (!(Number.isInteger(d.estimatedMinutes) && d.estimatedMinutes >= 1 && d.estimatedMinutes <= 600)) p.push('minutes');
  const s = d.source || {};
  if (!/^[a-z0-9_]{1,40}$/.test(String(s.templateKey))) p.push('templateKey');
  if (id !== generatedTaskId(s.kind, s.id, s.templateKey)) p.push('id');
  if (s.kind === 'room' ? d.roomId !== s.id : d.roomId !== null) p.push('roomId');
  if (d.dueDate !== null || d.endDate !== null) p.push('dates');
  return p;
}
