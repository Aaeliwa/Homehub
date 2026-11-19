import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ROOM_TEMPLATES, DEVICE_TEMPLATES } from '../../src/modules/cleaning/cleaning-templates.js';
import { buildSetupPlan, planWrites, generatedTaskId, ROOM_TYPE_MAP, DEVICE_SUBTYPE_MAP, sourceActive, effectiveRoomId } from '../../src/modules/cleaning/cleaning-integration.js';
import { afterNextDue, addMonthsClamped, buildBoard, historyDaysNeeded, buildAction } from '../../src/modules/cleaning/cleaning-model.js';
import { ROOM_TYPES } from '../../src/modules/rooms/room-model.js';
import { DEVICE_CATEGORIES } from '../../src/modules/devices/device-model.js';

test('templates: shipped library equals homeCleaning.html (re-extracted here); 35 room + 70 device tasks; 38/32 device split', () => {
  // The standalone app ships as a read-only reference so this comparison ALWAYS runs (never skipped).
  const src = readFileSync(new URL('../../docs/reference/homeCleaning.html', import.meta.url), 'utf8');
  {
    const lit = (name) => { const m = new RegExp(`const ${name}\\s*=\\s*`).exec(src); let i = m.index + m[0].length; const o = src[i]; const c = o === '[' ? ']' : '}'; let d = 0; let q = null; let j = i;
      for (; j < src.length; j++) { const ch = src[j]; if (q) { if (ch === '\\') { j++; continue; } if (ch === q) q = null; continue; } if ("'\"`".includes(ch)) { q = ch; continue; } if (ch === o) d++; else if (ch === c) { d--; if (!d) break; } }
      // JSON round-trip: objects from the vm sandbox belong to another realm (different Array prototype).
      return JSON.parse(JSON.stringify(vm.runInContext(`(${src.slice(i, j + 1)})`, vm.createContext({})))); };
    const T = lit('TEMPLATES'); const D = lit('DEVICE_TEMPLATES');
    assert.deepEqual(ROOM_TEMPLATES.map((r) => [r.key, r.tasks.map((x) => [x.key, x.titleAr, `${x.freq.unit}:${x.freq.n}`, x.minutes])]),
      T.map((r) => [r.key, r.tasks.map(([title, fs, min], i) => [`${r.key}_${i}`, title, fs, min])]));
    assert.deepEqual(DEVICE_TEMPLATES.map((d) => [d.key, d.mode, d.tasks.map((x) => [x.key, x.titleAr, x.trigger, x.phase, x.freq])]),
      D.map((d) => [d.key, d.mode, d.tasks.map((x) => [x.k, x.t, x.tr, x.ph ?? null, x.freq || null])]));
  }
  assert.equal(ROOM_TEMPLATES.reduce((n, r) => n + r.tasks.length, 0), 35);
  assert.equal(DEVICE_TEMPLATES.reduce((n, d) => n + d.tasks.length, 0), 70);
  assert.equal(DEVICE_TEMPLATES.reduce((n, d) => n + d.tasks.filter((x) => x.generate).length, 0), 38);
  assert.ok(DEVICE_TEMPLATES.find((d) => d.key === 'ac').tasks.every((x) => !x.generate && x.deferredReason === 'seasonal-device'));
  for (const d of DEVICE_TEMPLATES) for (const x of d.tasks) if (x.generate) assert.ok(x.trigger === 'periodic' && x.freq && x.key.match(/^[a-z0-9_]{1,40}$/), x.key);
  for (const r of ROOM_TEMPLATES) for (const x of r.tasks) assert.match(x.key, /^[a-z0-9_]{1,40}$/);
});

test('mapping covers only real HomeHub room types / device subtypes', () => {
  const rt = ROOM_TYPES.map((x) => x.id); for (const k of Object.keys(ROOM_TYPE_MAP)) assert.ok(rt.includes(k), k);
  const st = Object.values(DEVICE_CATEGORIES).flatMap((c) => c.subtypes || c); for (const k of Object.keys(DEVICE_SUBTYPE_MAP)) assert.ok(st.includes(k), k);
});

const room = (id, type, extra = {}) => ({ id, name: id, type, active: true, ...extra });
const device = (id, subtype, extra = {}) => ({ id, name: id, subtype, roomId: null, active: true, ...extra });

test('plan: existing rooms/devices recognised; deterministic ids; archived = never recreated; equivalent titles covered', () => {
  const rooms = [room('k1', 'kitchen'), room('g1', 'garage'), room('b1', 'bedroom', { active: false })];
  const devices = [device('dw', 'dishwasher', { roomId: 'k1' }), device('ac1', 'split_ac'), device('tv', 'television')];
  let plan = buildSetupPlan({ rooms, devices, tasks: [] });
  // Phase 5.4b: the AC (seasonal) now has generatable tasks too.
  assert.deepEqual(plan.pending.map((g) => `${g.kind}:${g.source.id}`), ['room:k1', 'device:ac1', 'device:dw'], 'garage/TV unmapped, archived bedroom skipped, AC fully deferred');
  assert.equal(plan.addCount, 11 + 16 + 7, 'kitchen 11 + AC 16 (seasonal) + dishwasher 7 (5 periodic + 2 after-cycle)');
  assert.equal(plan.groups.find((g) => g.source.id === 'ac1').deferred.length, 0, 'Phase 5.4b: all 16 AC tasks are generatable (seasonal)');
  assert.equal(plan.groups.find((g) => g.source.id === 'dw').deferred.length, 1, 'conditionBased stays deferred');
  assert.equal(generatedTaskId('room', 'k1', 'kitchen_0'), 'r_k1_kitchen_0');
  // Second run after setup: nothing to add (ids exist) — even when some were declined (archived).
  const tasks = plan.pending.flatMap((g) => g.add.map((it, i) => ({ id: it.id, title: it.template.titleAr, roomId: g.kind === 'room' ? g.source.id : null, active: i !== 0, source: { kind: g.kind, id: g.source.id } })));
  plan = buildSetupPlan({ rooms, devices, tasks });
  assert.equal(plan.addCount, 0, 'idempotent; declined tombstones are never recreated');
  // A manual task with the same (English or Arabic) title in that room covers the template task.
  const manual = [{ id: 'm1', title: '  wash THE dishes ', roomId: 'k1', active: true }];
  plan = buildSetupPlan({ rooms: [room('k1', 'kitchen')], devices: [], tasks: manual });
  assert.equal(plan.pending[0].covered.length, 1); assert.equal(plan.addCount, 10);
});

test('plan writes: staggered first dates (standalone n % min(period,7)), last-completion recurrence, declined → archived', () => {
  const plan = buildSetupPlan({ rooms: [room('k1', 'kitchen')], devices: [], tasks: [] });
  const ids = plan.pending[0].add.map((x) => x.id);
  const w = planWrites({ plan, accepted: new Set(ids.slice(1)), lang: 'en', uid: 'u', now: 'NOW', today: '2026-10-13' });
  assert.equal(w.length, 11);
  const daily = w.filter((x) => x.data.recurrence.unit === 'day' && x.data.recurrence.interval === 1);
  assert.ok(daily.every((x) => x.data.startDate === '2026-10-13'), 'daily tasks start today');
  const weekly = w.filter((x) => x.data.recurrence.interval === 7);
  assert.ok(new Set(weekly.map((x) => x.data.startDate)).size > 1, 'weekly tasks are spread');
  assert.deepEqual(w[0].data.recurrence, { kind: 'after', unit: 'day', interval: 1 });
  assert.deepEqual([w[0].data.active, w[0].data.archivedBy], [false, 'u'], 'unticked → declined tombstone');
  assert.deepEqual(w[1].data.source, { kind: 'room', id: 'k1', typeKey: 'kitchen', templateKey: 'kitchen_1', templateVersion: 1 });
  assert.equal(w[1].data.title, 'Wipe the counter'); assert.equal(w[1].data.roomId, 'k1');
  const dw = planWrites({ plan: buildSetupPlan({ rooms: [], devices: [device('dw', 'dishwasher', { roomId: 'k1' })], tasks: [] }), accepted: new Set(['d_dw_w_filter']), lang: 'ar', uid: 'u', now: 'N', today: '2026-10-13' });
  assert.equal(dw.find((x) => x.id === 'd_dw_w_filter').data.roomId, null, 'device tasks follow the device (no stale room copy)');
});

const T = (extra) => ({ id: 't', active: true, startDate: '2026-10-01', recurrence: { kind: 'after', unit: 'day', interval: 7 }, assignMode: 'shared', assigneeUids: [], eligibleUids: [], ...extra });
const done = (due, completedAt) => ({ id: `t_${due.replace(/-/g, '')}`, taskId: 't', dueDate: due, status: 'done', completedAt });

test('after-scheduling: first due = start; Done → completion + N; overdue completion counts from the day DONE; reopen → recomputed', () => {
  const tz = 'Africa/Cairo';
  assert.equal(afterNextDue(T(), [], tz, '2026-10-13'), '2026-10-01');
  assert.equal(afterNextDue(T(), [done('2026-10-01', '2026-10-01T09:00:00Z')], tz, '2026-10-13'), '2026-10-08', 'on time');
  assert.equal(afterNextDue(T(), [done('2026-10-08', '2026-10-11T09:00:00Z')], tz, '2026-10-13'), '2026-10-18', 'overdue: 11th + 7');
  const occs = [done('2026-10-01', '2026-10-01T09:00:00Z'), { ...done('2026-10-08', '2026-10-11T09:00:00Z'), status: 'open' }];
  assert.equal(afterNextDue(T(), occs, tz, '2026-10-13'), '2026-10-08', 'reopened: back to the previous completion + N (same occurrence id)');
  assert.equal(afterNextDue(T(), [done('2026-10-01', '2026-10-01T21:30:00Z')], tz, '2026-10-13'), '2026-10-09', 'Cairo midnight: completed on the 2nd locally');
  assert.equal(addMonthsClamped('2026-01-31', 1), '2026-02-28'); assert.equal(addMonthsClamped('2028-01-31', 1), '2028-02-29'); assert.equal(addMonthsClamped('2026-11-30', 3), '2027-02-28');
  assert.equal(afterNextDue(T({ startDate: '2026-01-01', recurrence: { kind: 'after', unit: 'month', interval: 3 } }), [done('2026-01-31', '2026-01-31T10:00:00Z')], tz, '2026-02-01'), '2026-04-30');
  assert.equal(afterNextDue(T({ startDate: '2026-12-01' }), [done('2026-10-01', '2026-10-01T09:00:00Z')], tz, '2026-10-13'), '2026-12-01', 'never before the start date');
  assert.equal(historyDaysNeeded([T({ recurrence: { kind: 'after', unit: 'month', interval: 3 } })]), 100, 'window covers 3 months');
  assert.equal(historyDaysNeeded([T({ recurrence: { kind: 'after', unit: 'month', interval: 12 } })]), 379);
});

test('after-scheduling on the board: one open date (no pile-up); completed today stays in today\'s progress; state machine reused', () => {
  const tz = 'UTC'; const can = (p) => p === 'cleaning.complete';
  let b = buildBoard({ tasks: [T()], occurrences: [done('2026-10-01', '2026-10-02T09:00:00Z')], today: '2026-10-20', uid: 'u', can, isChild: false, tz });
  assert.deepEqual(b.overdue.map((i) => i.date), ['2026-10-09'], 'only the single next date is overdue');
  assert.equal(b.today.length, 0);
  b = buildBoard({ tasks: [T()], occurrences: [done('2026-10-09', '2026-10-20T08:00:00Z')], today: '2026-10-20', uid: 'u', can, isChild: false, tz });
  assert.deepEqual(b.progress, { done: 1, total: 1 }, 'done today still counts today');
  assert.deepEqual(b.upcoming.map((i) => i.date), ['2026-10-27']);
  const a = buildAction({ task: T(), date: '2026-10-09', occ: null, action: 'complete', uid: 'u', now: 'N' });
  assert.equal(a.id, 't_20261009', 'completing an overdue instance uses its due date id');
});

test('lifecycle: archived room/device hides its tasks (history kept); restore shows them; rename live; device relocation followed', () => {
  const rooms = new Map([['k1', { id: 'k1', name: 'Kitchen', active: true }]]); const devices = new Map([['dw', { id: 'dw', name: 'Dishwasher', roomId: 'k1', active: true }]]);
  const env = { roomById: (id) => rooms.get(id), deviceById: (id) => devices.get(id) };
  const rt = T({ id: 'r_k1_kitchen_0', roomId: 'k1', source: { kind: 'room', id: 'k1' } });
  const dt = T({ id: 'd_dw_w_filter', roomId: null, source: { kind: 'device', id: 'dw' } });
  const board = () => buildBoard({ tasks: [rt, dt, T({ id: 'manual' })], occurrences: [], today: '2026-10-01', uid: 'u', can: () => true, isChild: false, tz: 'UTC', isVisible: (t) => sourceActive(t, env), roomOf: (t) => effectiveRoomId(t, env) });
  assert.equal(board().today.length, 3);
  rooms.set('k1', { ...rooms.get('k1'), active: false });
  assert.deepEqual(board().today.map((i) => i.task.id).sort(), ['d_dw_w_filter', 'manual'], 'archived room hides its generated tasks');
  rooms.set('k1', { ...rooms.get('k1'), active: true, name: 'Big Kitchen' });
  assert.equal(board().today.length, 3, 'restored');
  devices.set('dw', { ...devices.get('dw'), roomId: 'k2' });
  assert.equal(effectiveRoomId(dt, env), 'k2', 'device moved → its tasks follow');
  devices.set('dw', { ...devices.get('dw'), active: false });
  assert.ok(!board().today.some((i) => i.task.id === 'd_dw_w_filter'), 'archived device hides its tasks');
});
