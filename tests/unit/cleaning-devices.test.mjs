import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, buildAction, afterNextDue, validateTaskInput } from '../../src/modules/cleaning/cleaning-model.js';
import { generatableAs, buildSetupPlan, planWrites, generatedPayloadProblems, sourceActive, effectiveRoomId } from '../../src/modules/cleaning/cleaning-integration.js';
import { DEVICE_TEMPLATES } from '../../src/modules/cleaning/cleaning-templates.js';
import { buildRoutinePlan, routineItems, planKey } from '../../src/modules/cleaning/cleaning-advanced.js';
import { createCleaningStore } from '../../src/modules/cleaning/cleaning-store.js';

const can = (p) => p === 'cleaning.complete';
const base = { active: true, assignMode: 'shared', assigneeUids: [], eligibleUids: [], priority: 'normal', startDate: '2026-10-01' };
const U = (id, extra = {}) => ({ id, title: id, recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'af' }, ...base, ...extra });
const use = (id, at, extra = {}) => ({ id, deviceId: 'af', kind: 'use', voidsEventId: null, actorUid: 'u', at, ...extra });
const B = (tasks, occurrences, today, deviceEvents = [], deviceStates = new Map(), tz = 'UTC') => buildBoard({ tasks, occurrences, today, uid: 'u', can, isChild: false, tz, deviceEvents, deviceStates });
const all = (b) => [...b.overdue, ...b.today].filter((i) => !(i.occ && i.occ.status === 'done'));

test('after-use: due on use; uses COALESCE into one occurrence (first pending use); Done resolves; next use starts a new one', () => {
  const t = U('t');
  assert.equal(all(B([t], [], '2026-10-15')).length, 0, 'never used → not due');
  const ev = [use('e1', '2026-10-15T08:00:00Z'), use('e2', '2026-10-15T09:00:00Z'), use('e3', '2026-10-15T12:00:00Z')];
  let items = all(B([t], [], '2026-10-15', ev));
  assert.equal(items.length, 1, 'three uses → ONE item');
  assert.deepEqual([items[0].occId, items[0].triggerEventId, items[0].usesSince, items[0].date], ['t_ue1', 'e1', 3, '2026-10-15']);
  const a = buildAction({ task: t, date: items[0].date, occ: null, action: 'complete', uid: 'u', now: 'N', occId: items[0].occId, triggerEventId: 'e1' });
  assert.deepEqual([a.id, a.data.triggerEventId, a.log.id], ['t_ue1', 'e1', 't_ue1_r1']);
  const done = { id: 't_ue1', taskId: 't', dueDate: '2026-10-15', status: 'done', completedAt: '2026-10-15T13:00:00Z', rev: 1 };
  assert.equal(all(B([t], [done], '2026-10-15', ev)).length, 0, 'resolved: no outstanding item');
  items = all(B([t], [done], '2026-10-16', [...ev, use('e4', '2026-10-16T07:00:00Z')]));
  assert.deepEqual(items.map((i) => i.occId), ['t_ue4'], 'a new use after completion → a new occurrence');
  items = all(B([t], [], '2026-10-17', ev));
  assert.equal(items[0].bucket, 'overdue', 'unresolved since an earlier day → overdue');
});

test('after-use: voided uses never count; uses before the task existed never count; Home time zone decides the day', () => {
  const t = U('t', { startDate: '2026-10-15' });
  const ev = [use('old', '2026-10-14T08:00:00Z'), use('e1', '2026-10-15T08:00:00Z'), { id: 'e1_void', deviceId: 'af', kind: 'void', voidsEventId: 'e1', at: '2026-10-15T08:05:00Z' }];
  assert.equal(all(B([t], [], '2026-10-15', ev)).length, 0, 'voided + pre-start uses ignored');
  const late = [use('e9', '2026-10-15T22:30:00Z')];
  assert.equal(all(B([t], [], '2026-10-16', late, new Map(), 'Africa/Cairo'))[0].date, '2026-10-16', 'Cairo: 01:30 on the 16th');
});

test('after-use: skip hides only today, postpone moves it; neither resolves the use (not a completion)', () => {
  const t = U('t'); const ev = [use('e1', '2026-10-15T08:00:00Z')];
  let items = B([t], [{ id: 't_ue1', taskId: 't', dueDate: '2026-10-15', status: 'skipped', skippedOn: '2026-10-15', rev: 1 }], '2026-10-15', ev);
  assert.equal(items.today[0].occ.status, 'skipped');
  items = B([t], [{ id: 't_ue1', taskId: 't', dueDate: '2026-10-15', status: 'skipped', skippedOn: '2026-10-15', rev: 1 }], '2026-10-16', ev);
  assert.equal(items.overdue.length, 1, 'still due the next day');
  items = B([t], [{ id: 't_ue1', taskId: 't', dueDate: '2026-10-15', status: 'postponed', postponedTo: '2026-10-18', rev: 1 }], '2026-10-16', ev);
  assert.deepEqual(items.upcoming.map((i) => i.showDate), ['2026-10-18']);
});

test('seasonal: no state = off season; in-season tasks only while active, clamped to the activation day (basis unchanged)', () => {
  const t = { id: 's', title: 's', recurrence: { kind: 'after', unit: 'day', interval: 14 }, trigger: { kind: 'seasonal', deviceId: 'ac', phase: 'active' }, ...base, startDate: '2026-08-01' };
  const done = { id: 's_20260901', taskId: 's', dueDate: '2026-09-01', status: 'done', completedAt: '2026-09-01T10:00:00Z', rev: 1 };
  assert.equal(all(B([t], [done], '2026-10-15')).length, 0, 'no state document → off season → not due');
  const on = new Map([['ac', { id: 'ac', state: 'active', rev: 1, updatedAt: '2026-10-12T10:00:00Z' }]]);
  assert.equal(afterNextDue(t, [done], 'UTC', '2026-10-15'), '2026-09-15', 'basis unchanged');
  const items = all(B([t], [done], '2026-10-15', [], on));
  assert.deepEqual([items[0].date, items[0].bucket], ['2026-10-12', 'overdue'], 'clamped to the activation day, not 2026-09-15');
  const off = new Map([['ac', { id: 'ac', state: 'inactive', rev: 2, updatedAt: '2026-10-14T10:00:00Z' }]]);
  assert.equal(all(B([t], [done], '2026-10-15', [], off)).length, 0, 'off season again → hidden, history kept');
});

test('season start/end checklists: due once per transition (<task>_s<rev>)', () => {
  const st = { id: 'st', title: 'st', recurrence: { kind: 'onSeason' }, trigger: { kind: 'seasonal', deviceId: 'ac', phase: 'start' }, ...base };
  const en = { id: 'en', title: 'en', recurrence: { kind: 'onSeason' }, trigger: { kind: 'seasonal', deviceId: 'ac', phase: 'end' }, ...base };
  const S = (state, rev, at) => new Map([['ac', { id: 'ac', state, rev, updatedAt: at }]]);
  let items = all(B([st, en], [], '2026-10-15', [], S('active', 1, '2026-10-15T08:00:00Z')));
  assert.deepEqual(items.map((i) => [i.occId, i.triggerSeasonRev]), [['st_s1', 1]]);
  items = all(B([st, en], [{ id: 'st_s1', taskId: 'st', dueDate: '2026-10-15', status: 'done', completedAt: 'x', rev: 1 }], '2026-10-15', [], S('active', 1, '2026-10-15T08:00:00Z')));
  assert.equal(items.length, 0, 'checklist done for this transition');
  items = all(B([st, en], [{ id: 'st_s1', taskId: 'st', status: 'done', rev: 1 }], '2026-10-20', [], S('inactive', 2, '2026-10-20T08:00:00Z')));
  assert.deepEqual(items.map((i) => i.occId), ['en_s2']);
  items = all(B([st, en], [{ id: 'st_s1', taskId: 'st', status: 'done', rev: 1 }], '2026-11-01', [], S('active', 3, '2026-11-01T08:00:00Z')));
  assert.deepEqual(items.map((i) => i.occId), ['st_s3'], 'reactivation → a NEW start checklist; earlier ones untouched');
});

test('routine: device items keep their occurrence id in the saved plan and resolve with their trigger', () => {
  const t = U('t'); const b = B([t], [], '2026-10-15', [use('e1', '2026-10-15T08:00:00Z')]);
  const plan = buildRoutinePlan({ board: b, today: '2026-10-15', catchUpMax: 2 });
  assert.deepEqual(plan, ['t_ue1']); assert.equal(planKey(b.today[0]), 't_ue1');
  const [it] = routineItems({ plan, tasks: [t], occurrences: [] });
  assert.deepEqual([it.state, it.occId, it.triggerEventId, it.task.id], ['open', 't_ue1', 'e1', 't']);
  const [s] = routineItems({ plan: ['st_s3'], tasks: [{ ...t, id: 'st' }], occurrences: [] });
  assert.equal(s.triggerSeasonRev, 3);
});

test('templates: usage + seasonal tasks generatable with their ORIGINAL keys (66/70); payloads pass the rules mirror', () => {
  const gen = DEVICE_TEMPLATES.flatMap((T) => T.tasks.filter((x) => generatableAs(T, x)));
  assert.equal(gen.length, 66);
  const deferred = DEVICE_TEMPLATES.flatMap((T) => T.tasks.filter((x) => !generatableAs(T, x)).map((x) => x.trigger));
  assert.deepEqual(deferred.sort(), ['conditionBased', 'conditionBased', 'manual', 'manual']);
  const plan = buildSetupPlan({ rooms: [], devices: [{ id: 'ac1', name: 'AC', subtype: 'split_ac', active: true }, { id: 'af1', name: 'AF', subtype: 'air_fryer', active: true }], tasks: [] });
  const w = planWrites({ plan, accepted: new Set(plan.pending.flatMap((g) => g.add.map((a) => a.id))), lang: 'en', uid: 'u', now: 'N', today: '2026-10-15' });
  assert.equal(w.length, 16 + 9);
  assert.deepEqual(w.map((x) => [x.id, generatedPayloadProblems(x)]).filter(([, p]) => p.length), []);
  const byKind = (k) => w.filter((x) => x.data.trigger && (x.data.trigger.phase || x.data.trigger.kind) === k).length;
  assert.deepEqual([byKind('afterUse'), byKind('active'), byKind('start'), byKind('end')], [4, 4, 8, 4]);
  assert.ok(w.every((x) => !x.data.trigger || x.data.trigger.deviceId === x.data.source.id));
  assert.ok(w.filter((x) => x.data.trigger && x.data.trigger.kind === 'afterUse').every((x) => x.data.recurrence.kind === 'onUse'));
});

test('manual trigger validation; archived trigger device hides the task; tasks follow the device room', () => {
  assert.deepEqual(validateTaskInput({ title: 'x', assignMode: 'shared', recurrence: { kind: 'onUse' }, startDate: '2026-10-15', trigger: { kind: 'afterUse', deviceId: 'd' } }).errors, {});
  assert.ok(validateTaskInput({ title: 'x', assignMode: 'shared', recurrence: { kind: 'days', interval: 1 }, startDate: '2026-10-15', trigger: { kind: 'afterUse', deviceId: 'd' } }).errors.recurrence);
  assert.ok(validateTaskInput({ title: 'x', assignMode: 'shared', recurrence: { kind: 'onUse' }, startDate: '2026-10-15' }).errors.recurrence, 'onUse needs a trigger');
  const t = U('t');
  assert.equal(sourceActive(t, { roomById: () => null, deviceById: () => ({ active: false }) }), false);
  assert.equal(effectiveRoomId(t, { deviceById: () => ({ roomId: 'kit' }) }), 'kit');
});

function fakeRepo() {
  const data = new Map(); const ws = new Set(); let watchers = 0;
  const list = (prefix) => [...data.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, d]) => ({ id: k.split('/')[1], ...d }));
  const watch = (fn) => { ws.add(fn); watchers++; queueMicrotask(fn); return () => { ws.delete(fn); watchers--; }; };
  let n = 0;
  return { data, get watchers() { return watchers; }, now: () => new Date().toISOString(), newId: () => `t${++n}`, newEventId: () => `EVT${String(++n).padStart(12, '0')}`,
    watchTasks: (h, on) => watch(() => on(list('cleaningTasks/'))), watchOccurrences: (h, f, on) => watch(() => on(list('cleaningOccurrences/'))),
    watchDeviceEvents: (h, s, on) => watch(() => on(list('cleaningDeviceEvents/'))), watchDeviceStates: (h, on) => watch(() => on(list('cleaningDeviceState/'))),
    eventExists: async (h, id) => data.has(`cleaningDeviceEvents/${id}`), readSeasonLog: async () => list('cleaningDeviceSeasons/'),
    async commit(h, ops) {
      await new Promise((r) => setTimeout(r, 1));
      for (const o of ops) {
        const k = `${o.name}/${o.id}`;
        if (o.mode === 'set' && data.has(k)) throw Object.assign(new Error('exists'), { code: 'permission-denied' });
        if (o.name === 'cleaningDeviceState' && o.mode === 'update' && data.get(k).rev + 1 !== o.data.rev) throw Object.assign(new Error('stale'), { code: 'permission-denied' });
      }
      for (const o of ops) { const k = `${o.name}/${o.id}`; data.set(k, o.mode === 'set' ? { ...o.data } : { ...data.get(k), ...o.data }); }
      for (const w of ws) w();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('store: device listeners only with device-triggered tasks; idempotent use; one void; season revisions; stale toggle refused', async () => {
  const repo = fakeRepo();
  const s = createCleaningStore({ homeId: 'H', uid: 'u', repo, today: () => '2026-10-15' }); s.ensure({ canView: true }); s.subscribe(() => {}); await tick();
  assert.equal(s.listenerCount(), 2, 'no device-triggered tasks → no device listeners');
  repo.data.set('cleaningTasks/t', U('t')); await repo.commit('H', []); await tick();
  assert.equal(s.listenerCount(), 4, '+ device events + season states');
  const id = s.newEventId();
  assert.equal(await s.logUse('af', { eventId: id, note: ' after  dinner ' }), 'created');
  assert.equal(await s.logUse('af', { eventId: id }), 'existing', 'retry / double click: same id → no second event');
  assert.equal([...repo.data.keys()].filter((k) => k.startsWith('cleaningDeviceEvents/')).length, 1);
  assert.equal(repo.data.get(`cleaningDeviceEvents/${id}`).note, 'after dinner');
  await s.voidUse('af', id);
  await assert.rejects(s.voidUse('af', id), (e) => e.detail === 'cleaning.device.voidConflict');
  assert.equal(await s.setSeason('ac', 'active'), 1); await tick();
  assert.equal(await s.setSeason('ac', 'inactive'), 2); await tick();
  assert.deepEqual([repo.data.get('cleaningDeviceState/ac').rev, repo.data.has('cleaningDeviceSeasons/ac_s1'), repo.data.has('cleaningDeviceSeasons/ac_s2')], [2, true, true]);
  await assert.rejects(s.setSeason('ac', 'inactive'), (e) => e.detail === 'cleaning.device.seasonUnchanged');
  repo.data.set('cleaningDeviceState/ac', { ...repo.data.get('cleaningDeviceState/ac'), rev: 5 });   // another member moved on; our snapshot is stale
  await assert.rejects(s.setSeason('ac', 'active'), (e) => e.detail === 'cleaning.device.seasonConflict');
  s.dispose(); assert.equal(repo.watchers, 0);
});
