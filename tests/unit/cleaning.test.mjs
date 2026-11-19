import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occursOn, dueDatesBetween, validateTaskInput, buildTaskCreate, mayAct, buildAction, buildBoard, occurrenceId, MAX_RANGE_DAYS } from '../../src/modules/cleaning/cleaning-model.js';
import { createCleaningStore } from '../../src/modules/cleaning/cleaning-store.js';
import { todayIn } from '../../src/modules/expenses/calendar.js';

const T = (recurrence, extra = {}) => ({ id: 't1', title: 'Kitchen', active: true, startDate: '2026-01-31', dueDate: null, endDate: null, assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence, priority: 'normal', ...extra });
const can = (perms) => (p) => perms.includes(p);

test('recurrence: monthly day 31 → last day of short months; leap year Feb 29', () => {
  assert.deepEqual(dueDatesBetween(T({ kind: 'months', interval: 1, dayOfMonth: 31 }), '2026-01-01', '2026-06-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
  assert.deepEqual(dueDatesBetween(T({ kind: 'months', interval: 1, dayOfMonth: 30 }, { startDate: '2028-01-30' }), '2028-02-01', '2028-03-31'), ['2028-02-29', '2028-03-30']);
  assert.deepEqual(dueDatesBetween(T({ kind: 'months', interval: 3, dayOfMonth: 15 }, { startDate: '2026-01-15' }), '2026-01-01', '2026-12-31'), ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
});

test('recurrence: every N days, weekly weekdays, every N weeks across a year boundary; end date; once', () => {
  assert.deepEqual(dueDatesBetween(T({ kind: 'days', interval: 1 }, { startDate: '2026-12-30' }), '2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.deepEqual(dueDatesBetween(T({ kind: 'weeks', interval: 2, weekdays: [0, 3] }, { startDate: '2026-12-20' }), '2026-12-20', '2027-01-16'), ['2026-12-20', '2026-12-23', '2027-01-03', '2027-01-06']);
  assert.deepEqual(dueDatesBetween(T({ kind: 'days', interval: 2 }, { startDate: '2026-10-01', endDate: '2026-10-06' }), '2026-10-01', '2026-10-31'), ['2026-10-01', '2026-10-03', '2026-10-05']);
  assert.deepEqual(dueDatesBetween(T({ kind: 'once' }, { startDate: '2026-10-01', dueDate: '2026-10-09' }), '2026-09-01', '2026-10-31'), ['2026-10-09']);
  assert.equal(occursOn(T({ kind: 'days', interval: 1 }, { startDate: '2026-10-05' }), '2026-10-04'), false, 'never before start');
  assert.throws(() => dueDatesBetween(T({ kind: 'days', interval: 1 }, { startDate: '2020-01-01' }), '2020-01-01', '2026-01-01'), 'bounded: refused, never truncated');
  assert.ok(validateTaskInput({ title: 'x', recurrence: { kind: 'days', interval: '' }, startDate: '2026-10-01' }).errors.recurrence, 'blank interval rejected, not defaulted');
  assert.equal(MAX_RANGE_DAYS, 400);
});

test('timezone: "today" is the Home\'s calendar date across midnight', () => {
  const ms = Date.parse('2026-10-11T22:30:00Z');   // 01:30 on the 12th in Cairo (UTC+3 in October 2026)
  assert.equal(todayIn('Africa/Cairo', ms), '2026-10-12');
  assert.equal(todayIn('America/New_York', ms), '2026-10-11');
});

test('validation: required title, 1–5 assignees, valid recurrence, dates in order, members only', () => {
  const base = { title: 'Bath', recurrence: { kind: 'days', interval: 1 }, startDate: '2026-10-01', assignMode: 'shared' };
  assert.deepEqual(Object.keys(validateTaskInput(base).errors), []);
  assert.ok(validateTaskInput({ ...base, title: '  ' }).errors.title);
  assert.ok(validateTaskInput({ ...base, assignMode: 'assigned', assigneeUids: [] }).errors.assigneeUids);
  assert.ok(validateTaskInput({ ...base, recurrence: { kind: 'weeks', interval: 1, weekdays: [] } }).errors.recurrence);
  assert.ok(validateTaskInput({ ...base, recurrence: { kind: 'days', interval: 0 } }).errors.recurrence);
  assert.ok(validateTaskInput({ ...base, recurrence: { kind: 'months', interval: 1, dayOfMonth: 32 } }).errors.recurrence);
  assert.ok(validateTaskInput({ ...base, recurrence: { kind: 'once' }, dueDate: '2026-09-01' }).errors.dueDate);
  assert.ok(validateTaskInput({ ...base, endDate: '2026-09-01' }).errors.endDate);
  assert.ok(validateTaskInput({ ...base, assignMode: 'assigned', assigneeUids: ['stranger'] }, { memberUids: ['a'] }).errors.assigneeUids);
  const d = buildTaskCreate({ input: { ...base, assignMode: 'assigned', assigneeUids: ['b', 'a', 'a'] }, uid: 'a', memberUids: ['a', 'b'], now: 'N' });
  assert.deepEqual([d.assigneeUids, d.eligibleUids, d.active, d.dueDate], [['a', 'b'], [], true, null]);
});

test('who may act: assigned people; shared → eligible list, or every ADULT when empty; children only when listed', () => {
  const adult = { uid: 'a', can: can(['cleaning.complete']), isChild: false };
  const kid = { uid: 'k', can: can(['cleaning.complete']), isChild: true };
  assert.equal(mayAct(T({ kind: 'once' }, { assignMode: 'assigned', assigneeUids: ['a'] }), adult), true);
  assert.equal(mayAct(T({ kind: 'once' }, { assignMode: 'assigned', assigneeUids: ['b'] }), adult), false);
  assert.equal(mayAct(T({ kind: 'once' }), adult), true, 'shared with everyone (adults)');
  assert.equal(mayAct(T({ kind: 'once' }), kid), false, 'child not included in "everyone"');
  assert.equal(mayAct(T({ kind: 'once' }, { eligibleUids: ['k'] }), kid), true, 'child explicitly listed');
  assert.equal(mayAct(T({ kind: 'once' }), { uid: 'v', can: can([]), isChild: false }), false, 'no complete permission');
  assert.equal(mayAct(T({ kind: 'once' }, { active: false }), adult), false, 'archived task');
});

test('state machine: claim → complete → reopen (reason) → claim; revisions +1; deterministic ids; stale refused', () => {
  const task = T({ kind: 'days', interval: 1 });
  const c = buildAction({ task, date: '2026-10-12', occ: null, action: 'claim', uid: 'a', now: 'N' });
  assert.deepEqual([c.id, c.create, c.data.status, c.data.rev, c.data.claimedBy, c.log.id, c.log.data.action], ['t1_20261012', true, 'claimed', 1, 'a', 't1_20261012_r1', 'claim']);
  assert.equal(occurrenceId('t1', '2026-10-12'), 't1_20261012');
  const occ1 = { id: c.id, ...c.data };
  const d = buildAction({ task, date: '2026-10-12', occ: occ1, action: 'complete', uid: 'a', notes: ' wiped   counters ', now: 'N' });
  assert.deepEqual([d.create, d.data.status, d.data.rev, d.data.completedBy, d.data.notes, d.log.id], [false, 'done', 2, 'a', 'wiped counters', 't1_20261012_r2']);
  const occ2 = { ...occ1, ...d.data };
  // V6.1: one-tap Reopen — no note required; the audit entry is still produced (with a null note).
  const quick = buildAction({ task, date: '2026-10-12', occ: occ2, action: 'reopen', uid: 'a', now: 'N' });
  assert.equal(quick.log.data.action, 'reopen'); assert.equal(quick.log.data.notes, null);
  const r = buildAction({ task, date: '2026-10-12', occ: occ2, action: 'reopen', uid: 'a', notes: 'missed the floor', now: 'N' });
  assert.deepEqual([r.data.status, r.data.rev, r.data.completedBy, r.log.data.notes], ['open', 3, null, 'missed the floor']);
  assert.throws(() => buildAction({ task, date: '2026-10-12', occ: occ2, action: 'claim', uid: 'b', now: 'N' }), (e) => e.detail === 'cleaning.validation.stale', 'cannot claim a done task');
  const direct = buildAction({ task, date: '2026-10-13', occ: null, action: 'complete', uid: 'a', now: 'N' });
  assert.deepEqual([direct.create, direct.data.status, direct.data.claimedBy, direct.data.rev], [true, 'done', null, 1], 'complete without claiming');
});

test('board: missed occurrences do not pile up — only the latest is actionable, the rest counted', () => {
  const daily = T({ kind: 'days', interval: 1 }, { id: 'd', startDate: '2026-10-01' });
  const occs = [{ id: 'd_20261005', taskId: 'd', dueDate: '2026-10-05', status: 'done', completedBy: 'a' }];
  const b = buildBoard({ tasks: [daily], occurrences: occs, today: '2026-10-12', uid: 'a', can: can(['cleaning.complete']), isChild: false });
  assert.deepEqual(b.overdue.map((i) => i.date), ['2026-10-11'], 'one overdue item: the latest miss');
  assert.equal(b.missedCounts.d, 6, '6..11 counted (after the last completion on the 5th)');
  assert.deepEqual(b.today.map((i) => i.date), ['2026-10-12']);
  assert.equal(b.upcoming.length, 14);
  assert.deepEqual(b.completed.map((i) => i.date), ['2026-10-05']);
  assert.deepEqual(b.progress, { done: 0, total: 1 });
});

test('board: Mine / Shared available / progress; claimed by someone else is not "available"', () => {
  const shared = T({ kind: 'days', interval: 1 }, { id: 's', startDate: '2026-10-12' });
  const mine = T({ kind: 'days', interval: 1 }, { id: 'm', startDate: '2026-10-12', assignMode: 'assigned', assigneeUids: ['a'] });
  const taken = T({ kind: 'days', interval: 1 }, { id: 'x', startDate: '2026-10-12' });
  const occs = [{ id: 'x_20261012', taskId: 'x', dueDate: '2026-10-12', status: 'claimed', claimedBy: 'b' }, { id: 'm_20261012', taskId: 'm', dueDate: '2026-10-12', status: 'done', completedBy: 'a' }];
  const b = buildBoard({ tasks: [shared, mine, taken], occurrences: occs, today: '2026-10-12', uid: 'a', can: can(['cleaning.complete']), isChild: false });
  assert.deepEqual(b.sharedAvailable.map((i) => i.task.id), ['s']);
  assert.deepEqual(b.mine.map((i) => i.task.id), [], 'my assigned task is already done');
  assert.deepEqual(b.progress, { done: 1, total: 3 });
  assert.deepEqual(buildBoard({ tasks: [shared], occurrences: [], today: '2026-10-12', uid: 'a', can: can(['cleaning.complete']), isChild: false, roomFilter: 'r9' }).today, [], 'room filter');
});

function fakeRepo() {
  const data = new Map(); const ws = new Set(); const commits = []; let n = 0; let watchers = 0;
  const fire = () => { for (const w of ws) w(); };
  return { data, commits, deny: false, now: () => 'NOW', newId: () => `task${++n}`, get watchers() { return watchers; },
    watchTasks(h, onValue) { const w = () => onValue([...data.entries()].filter(([k]) => k.startsWith('cleaningTasks/')).map(([k, d]) => ({ id: k.split('/')[1], ...d }))); ws.add(w); watchers++; queueMicrotask(w); return () => { ws.delete(w); watchers--; }; },
    watchOccurrences(h, from, onValue) { const w = () => onValue([...data.entries()].filter(([k, d]) => k.startsWith('cleaningOccurrences/') && d.dueDate >= from).map(([k, d]) => ({ id: k.split('/')[1], ...d }))); ws.add(w); watchers++; queueMicrotask(w); return () => { ws.delete(w); watchers--; }; },
    readLog: async (h, occId) => [...data.entries()].filter(([k, d]) => k.startsWith('cleaningLog/') && d.occurrenceId === occId).map(([, d]) => d),
    async commit(h, ops) {
      if (this.deny) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      for (const o of ops) if (o.mode === 'set' && data.has(`${o.name}/${o.id}`)) throw Object.assign(new Error('exists'), { code: 'permission-denied' });
      commits.push(ops.map((o) => `${o.mode}:${o.name}:${o.id}`));
      for (const o of ops) { const k = `${o.name}/${o.id}`; data.set(k, o.mode === 'set' ? { ...o.data } : { ...data.get(k), ...o.data }); }
      fire();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('store: create → claim → complete in atomic batches (occurrence + audit log); conflict mapped; dispose', async () => {
  const repo = fakeRepo();
  const s = createCleaningStore({ homeId: 'H', uid: 'a', repo, today: () => '2026-10-12' });
  s.ensure({ canView: true }); s.subscribe(() => {}); await tick();
  assert.equal(s.listenerCount(), 2);
  const id = await s.createTask({ title: 'Floors', recurrence: { kind: 'days', interval: 1 }, startDate: '2026-10-12', assignMode: 'shared' }, { memberUids: ['a', 'b'] }); await tick();
  await s.act(id, '2026-10-12', 'claim'); await tick();
  assert.deepEqual(repo.commits.at(-1), [`set:cleaningOccurrences:${id}_20261012`, `set:cleaningLog:${id}_20261012_r1`]);
  await s.act(id, '2026-10-12', 'complete', 'done before lunch'); await tick();
  assert.deepEqual(repo.commits.at(-1), [`update:cleaningOccurrences:${id}_20261012`, `set:cleaningLog:${id}_20261012_r2`]);
  assert.deepEqual((await s.history(`${id}_20261012`)).map((l) => l.action).sort(), ['claim', 'complete']);
  // Concurrency: a second client creating the same occurrence id is refused (first claimer wins).
  const other = createCleaningStore({ homeId: 'H', uid: 'b', repo, today: () => '2026-10-12' });
  other.ensure({ canView: true }); await tick();
  await other.act(id, '2026-10-13', 'claim'); await tick();
  const stale = createCleaningStore({ homeId: 'H', uid: 'c', repo: { ...repo, watchOccurrences: (h, f, onValue) => { queueMicrotask(() => onValue([])); return () => {}; } }, today: () => '2026-10-12' });
  stale.ensure({ canView: true }); await tick();
  await assert.rejects(stale.act(id, '2026-10-13', 'claim'), (e) => e.detail === 'cleaning.validation.conflict', 'stale view loses the race');
  repo.deny = true;
  await assert.rejects(s.act(id, '2026-10-14', 'claim'), (e) => e.detail === 'cleaning.validation.conflict');
  repo.deny = false;
  await s.archiveTask(id); await tick(); assert.equal(s.task(id).active, false);
  await s.restoreTask(id); await tick(); assert.equal(s.task(id).active, true);
  s.dispose(); other.dispose();
  assert.equal(repo.watchers, 1, 'only the stale test store (custom watcher) remains');
  await assert.rejects(s.act(id, '2026-10-12', 'claim'));
});

test('store: no listeners without cleaning.view', async () => {
  const repo = fakeRepo();
  const s = createCleaningStore({ homeId: 'H', uid: 'v', repo, today: () => '2026-10-12' });
  s.ensure({ canView: false });
  assert.equal(s.listenerCount(), 0);
});
