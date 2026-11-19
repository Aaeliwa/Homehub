import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAction, buildBoard, afterNextDue, ACTION_FROM } from '../../src/modules/cleaning/cleaning-model.js';
import { settingsOf, validateSettings, routineDate, buildRoutinePlan, routineItems, routineProgress, quickPick, computeStats, SETTINGS_DEFAULTS } from '../../src/modules/cleaning/cleaning-advanced.js';
import { createCleaningStore } from '../../src/modules/cleaning/cleaning-store.js';

const can = (p) => p === 'cleaning.complete';
const T = (id, extra = {}) => ({ id, title: id, active: true, startDate: '2026-10-01', recurrence: { kind: 'days', interval: 1 }, assignMode: 'shared', assigneeUids: [], eligibleUids: [], priority: 'normal', ...extra });
const A = (id, extra = {}) => T(id, { recurrence: { kind: 'after', unit: 'day', interval: 7 }, ...extra });
const occ = (taskId, date, extra) => ({ id: `${taskId}_${date.replace(/-/g, '')}`, taskId, dueDate: date, rev: 1, ...extra });
const board = (tasks, occurrences, today) => buildBoard({ tasks, occurrences, today, uid: 'u', can, isChild: false, tz: 'UTC' });

test('actions: skip/postpone/resume state machine; never a completion; minutes 1..600; postpone ≤ 30 days', () => {
  assert.deepEqual(ACTION_FROM.skip, ['open', 'skipped']);
  const s = buildAction({ task: T('t'), date: '2026-10-15', occ: null, action: 'skip', uid: 'u', now: 'N', today: '2026-10-15' });
  assert.deepEqual([s.data.status, s.data.skippedOn, s.data.completedBy, s.data.claimedBy, s.log.data.action], ['skipped', '2026-10-15', null, null, 'skip']);
  const p = buildAction({ task: T('t'), date: '2026-10-15', occ: null, action: 'postpone', uid: 'u', now: 'N', postponedTo: '2026-10-20', today: '2026-10-15' });
  assert.deepEqual([p.data.status, p.data.postponedTo, p.log.data.postponedTo, p.data.completedBy], ['postponed', '2026-10-20', '2026-10-20', null]);
  for (const bad of ['2026-10-15', '2026-11-15', 'nope']) assert.throws(() => buildAction({ task: T('t'), date: '2026-10-15', occ: null, action: 'postpone', uid: 'u', now: 'N', postponedTo: bad, today: '2026-10-15' }), (e) => e.detail === 'cleaning.validation.postponeDate', bad);
  const r = buildAction({ task: T('t'), date: '2026-10-15', occ: { id: p.id, ...p.data }, action: 'resume', uid: 'u', now: 'N' });
  assert.deepEqual([r.data.status, r.data.postponedTo, r.data.skippedOn, r.data.rev, r.log.data.action], ['open', null, null, 2, 'resume']);
  const d = buildAction({ task: T('t'), date: '2026-10-15', occ: { id: p.id, ...p.data }, action: 'complete', uid: 'u', now: 'N', minutes: 12 });
  assert.deepEqual([d.data.status, d.data.actualMinutes, d.log.data.actualMinutes], ['done', 12, 12], 'complete from postponed, with minutes');
  for (const m of [0, 601, 2.5, 'x']) assert.throws(() => buildAction({ task: T('t'), date: '2026-10-15', occ: null, action: 'complete', uid: 'u', now: 'N', minutes: m }), (e) => e.detail === 'cleaning.validation.minutes');
  assert.throws(() => buildAction({ task: T('t'), date: '2026-10-15', occ: { id: 'x', status: 'done', rev: 3 }, action: 'skip', uid: 'u', now: 'N', today: '2026-10-15' }), (e) => e.detail === 'cleaning.validation.stale');
});

test("skip on a completion-based task: hidden only that day; basis unchanged; still due afterwards", () => {
  const t = A('a', { startDate: '2026-10-01' });
  const done = occ('a', '2026-10-01', { status: 'done', completedAt: '2026-10-01T09:00:00Z' });
  const skipped = occ('a', '2026-10-08', { status: 'skipped', skippedOn: '2026-10-08', rev: 2 });
  assert.equal(afterNextDue(t, [done, skipped], 'UTC', '2026-10-08'), '2026-10-08', 'skip is not a completion');
  let b = board([t], [done, skipped], '2026-10-08');
  assert.equal(b.today[0].occ.status, 'skipped'); assert.equal(b.mine.length + b.sharedAvailable.length, 0, 'not actionable today');
  b = board([t], [done, skipped], '2026-10-09');
  assert.deepEqual(b.overdue.map((i) => i.date), ['2026-10-08'], 'next day: still due (overdue) on the original basis');
  assert.equal(b.sharedAvailable.length, 1, 'actionable again');
});

test('skip on a fixed-calendar task: that date is handled (never missed); the schedule continues', () => {
  const t = T('f', { startDate: '2026-10-01' });
  const b = board([t], [occ('f', '2026-10-07', { status: 'done', completedAt: 'x' }), occ('f', '2026-10-08', { status: 'skipped', skippedOn: '2026-10-08' })], '2026-10-09');
  assert.deepEqual(b.overdue, [], 'the skipped 8th is not overdue');
  assert.deepEqual(b.today.map((i) => i.date), ['2026-10-09']);
});

test('postpone: shown on the new date (not overdue before it); recurrence definition unchanged', () => {
  const f = T('f', { startDate: '2026-10-10' });
  const o = occ('f', '2026-10-10', { status: 'postponed', postponedTo: '2026-10-13' });
  let b = board([f], [o], '2026-10-11');
  assert.ok(!b.overdue.some((i) => i.date === '2026-10-10'), 'not overdue while postponed');
  assert.ok(b.upcoming.some((i) => i.date === '2026-10-10' && i.showDate === '2026-10-13'));
  b = board([f], [o], '2026-10-13');
  assert.ok(b.today.some((i) => i.showDate === '2026-10-13' && i.occ && i.occ.status === 'postponed'));
  const a = A('a', { startDate: '2026-10-10' });
  const ao = occ('a', '2026-10-10', { status: 'postponed', postponedTo: '2026-10-14' });
  assert.equal(afterNextDue(a, [ao], 'UTC', '2026-10-11'), '2026-10-10', 'basis unchanged');
  assert.equal(board([a], [ao], '2026-10-14').today[0].showDate, '2026-10-14');
});

test('routine plan: today + all high overdue + catchUpMax others; skipped-today excluded; stable selection, live statuses', () => {
  const tasks = [T('today1', { startDate: '2026-10-15' }), A('hi', { startDate: '2026-10-05', priority: 'high' }), A('o1', { startDate: '2026-10-01' }), A('o2', { startDate: '2026-10-10' }), A('o3', { startDate: '2026-10-12' }), A('sk', { startDate: '2026-10-15' })];
  const occs = [occ('sk', '2026-10-15', { status: 'skipped', skippedOn: '2026-10-15' })];
  const b = board(tasks, occs, '2026-10-15');
  const plan = buildRoutinePlan({ board: b, today: '2026-10-15', catchUpMax: 2 });
  assert.deepEqual(plan, ['today1_20261015', 'hi_20261005', 'o1_20261001', 'o2_20261010'], 'o3 not picked (catchUpMax 2, least overdue); skipped excluded');
  // Later: a task is completed and another reopened elsewhere → same plan, live statuses.
  const live = [...occs, occ('today1', '2026-10-15', { status: 'done', completedAt: 'x' }), occ('hi', '2026-10-05', { status: 'claimed', claimedBy: 'w' })];
  const items = routineItems({ plan, tasks, occurrences: live });
  assert.deepEqual(items.map((i) => i.state), ['done', 'claimed', 'open', 'open']);
  assert.deepEqual(routineProgress(items), { done: 1, total: 4, skipped: 0, postponed: 0 });
  const archived = routineItems({ plan, tasks: tasks.map((t) => (t.id === 'o1' ? { ...t, active: false } : t)), occurrences: live });
  assert.equal(archived[2].state, 'inactive', 'an archived task stays listed, marked inactive');
  assert.equal(buildRoutinePlan({ board: { today: Array.from({ length: 250 }, (_, i) => ({ task: T(`x${i}`), date: '2026-10-15' })), overdue: [] }, today: '2026-10-15', catchUpMax: 0 }).length, 200);
});

test('routine day starts at startHour (Home time zone); settings defaults and validation', () => {
  const at = Date.parse('2026-10-15T00:30:00Z');   // 03:30 Cairo (UTC+3)
  assert.equal(routineDate('Africa/Cairo', 3, at), '2026-10-15');
  assert.equal(routineDate('Africa/Cairo', 4, at), '2026-10-14', 'before 04:00 → still the previous routine day');
  assert.deepEqual(SETTINGS_DEFAULTS, { catchUpMax: 2, startHour: 3 });
  assert.deepEqual(settingsOf(null), { catchUpMax: 2, startHour: 3 }); assert.deepEqual(settingsOf({ catchUpMax: 5, startHour: 99 }), { catchUpMax: 5, startHour: 3 });
  assert.deepEqual(validateSettings({ catchUpMax: '4', startHour: '0' }).value, { catchUpMax: 4, startHour: 0 });
  assert.deepEqual(Object.keys(validateSettings({ catchUpMax: 11, startHour: 7 }).errors).sort(), ['catchUpMax', 'startHour']);
});

test('quick routine and statistics', () => {
  const items = [{ task: T('a', { estimatedMinutes: 10, priority: 'high' }), date: '2026-10-15' }, { task: T('b', { estimatedMinutes: 20 }), date: '2026-10-14' }, { task: T('c'), date: '2026-10-15' }];
  assert.deepEqual(quickPick(items, 15).items.map((i) => i.task.id), ['a', 'c'], 'high first; c uses the 5-min default');
  assert.equal(quickPick(items, 15).minutes, 15);
  const log = [{ action: 'complete', taskId: 'a', actorUid: 'u', at: '2026-10-15T08:00:00Z', actualMinutes: 12 }, { action: 'complete', taskId: 'b', actorUid: 'w', at: '2026-10-14T08:00:00Z' },
    { action: 'skip', taskId: 'c', at: '2026-10-15T08:00:00Z' }, { action: 'postpone', at: '2026-10-15T08:00:00Z' }, { action: 'reopen', at: '2026-10-15T09:00:00Z' }, { action: 'complete', taskId: 'a', actorUid: 'u', at: '2026-09-01T08:00:00Z' }];
  const st = computeStats({ log, tasks: [T('a', { roomId: 'k' }), T('b', { estimatedMinutes: 20 })], tz: 'UTC', days: 7, today: '2026-10-15' });
  assert.deepEqual([st.completions, st.minutes, st.skips, st.postpones, st.reopens], [2, 32, 1, 1, 1]);
  assert.deepEqual(st.byMember, { u: 1, w: 1 }); assert.deepEqual(st.byRoom, { k: 1, none: 1 });
});

function fakeRepo({ routineTaken = false } = {}) {
  const data = new Map(); const docW = new Map(); const ws = new Set(); let watchers = 0; const commits = [];
  const fire = () => { for (const w of ws) w(); for (const [k, fns] of docW) for (const fn of fns) fn(data.has(k) ? { id: k.split('/')[1], ...data.get(k) } : null); };
  const docWatch = (key, onValue) => { if (!docW.has(key)) docW.set(key, new Set()); docW.get(key).add(onValue); watchers++; queueMicrotask(() => onValue(data.has(key) ? { id: key.split('/')[1], ...data.get(key) } : null)); return () => { docW.get(key).delete(onValue); watchers--; }; };
  if (routineTaken) data.set('cleaningRoutines/2026-10-15', { date: '2026-10-15', items: ['someone_else'] });
  return { data, commits, get watchers() { return watchers; }, now: () => 'NOW', newId: () => 'tid',
    watchTasks(h, onValue) { const w = () => onValue([...data.entries()].filter(([k]) => k.startsWith('cleaningTasks/')).map(([k, d]) => ({ id: k.split('/')[1], ...d }))); ws.add(w); watchers++; queueMicrotask(w); return () => { ws.delete(w); watchers--; }; },
    watchOccurrences(h, f, onValue) { const w = () => onValue([...data.entries()].filter(([k]) => k.startsWith('cleaningOccurrences/')).map(([k, d]) => ({ id: k.split('/')[1], ...d }))); ws.add(w); watchers++; queueMicrotask(w); return () => { ws.delete(w); watchers--; }; },
    watchRoutine: (h, day, onValue) => docWatch(`cleaningRoutines/${day}`, onValue),
    watchSettings: (h, onValue) => docWatch('cleaningSettings/general', onValue),
    routineExists: async (h, day) => data.has(`cleaningRoutines/${day}`),
    readLogSince: async () => [...data.entries()].filter(([k]) => k.startsWith('cleaningLog/')).map(([, d]) => d),
    async commit(h, ops) {
      await new Promise((r) => setTimeout(r, 1)); commits.push(ops.map((o) => `${o.mode}:${o.name}:${o.id}`));
      for (const o of ops) if (o.mode === 'set' && /^(cleaningRoutines|cleaningOccurrences|cleaningLog)$/.test(o.name) && data.has(`${o.name}/${o.id}`)) throw Object.assign(new Error('exists'), { code: 'permission-denied' });
      for (const o of ops) data.set(`${o.name}/${o.id}`, o.mode === 'set' ? { ...o.data } : { ...data.get(`${o.name}/${o.id}`), ...o.data });
      fire();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('store: Advanced listeners only on demand (4 total) and disposed; routine saved once; concurrent creator wins', async () => {
  const repo = fakeRepo({ routineTaken: true });
  const s = createCleaningStore({ homeId: 'H', uid: 'u', repo, today: () => '2026-10-15' }); s.ensure({ canView: true }); s.subscribe(() => {}); await tick();
  assert.equal(s.listenerCount(), 2, 'Basic: tasks + occurrences');
  s.ensureAdvanced('2026-10-15'); await tick();
  assert.equal(s.listenerCount(), 4, '+ settings + routine');
  assert.deepEqual(s.getSnapshot().routine.items, ['someone_else'], 'the existing plan is used');
  assert.equal(await s.createRoutine('2026-10-15', ['mine'], SETTINGS_DEFAULTS), 'existing', 'second creator: refused → existing (no overwrite)');
  assert.deepEqual(repo.data.get('cleaningRoutines/2026-10-15').items, ['someone_else']);
  assert.equal(await s.createRoutine('2026-10-16', ['a'], SETTINGS_DEFAULTS), 'created');
  await s.saveSettings({ catchUpMax: 4, startHour: 2 }); await tick();
  assert.deepEqual(repo.commits.at(-1), ['set:cleaningSettings:general']);
  assert.equal(settingsOf(s.getSnapshot().settings).catchUpMax, 4);
  s.ensureAdvanced('2026-10-16'); await tick(); assert.equal(s.listenerCount(), 4, 're-targeted, not added');
  s.dispose(); assert.equal(repo.watchers, 0, 'all listeners stopped');
});

test('store: whole-room actMany — one confirmed write per task, confirmed progress, honest partial result', async () => {
  const repo = fakeRepo();
  const s = createCleaningStore({ homeId: 'H', uid: 'u', repo, today: () => '2026-10-15' }); s.ensure({ canView: true }); s.subscribe(() => {}); await tick();
  for (const id of ['a', 'b', 'c']) repo.data.set(`cleaningTasks/${id}`, T(id, { startDate: '2026-10-15' }));
  repo.data.set('cleaningOccurrences/b_20261015', { taskId: 'b', dueDate: '2026-10-15', status: 'done', rev: 1 });   // already done elsewhere
  await repo.commit('H', []); await tick();
  const seen = [];
  const r = await s.actMany(['a', 'b', 'c'].map((id) => ({ taskId: id, date: '2026-10-15' })), 'complete', { onProgress: (p) => seen.push(p.saved) });
  assert.deepEqual([r.saved, r.failed.map((f) => [f.taskId, f.detail])], [2, [['b', 'cleaning.validation.stale']]]);
  assert.deepEqual(seen, [0, 1, 1, 2], 'progress counts confirmed saves only');
  assert.ok(repo.commits.slice(1).every((c) => c.length === 2), 'each task: its occurrence + audit entry, nothing bigger');
});
