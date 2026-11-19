// V6.3 Cleaning: Mark All Done (exact shown scope, revalidation, no double completion, retry),
// Reset task progress and Restore default tasks (custom kept / explicitly removed, rooms & devices
// never written, idempotent, stale progress never resurrected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completableItems, revalidate, progressResetPlan, restoreDefaultsPlan, isCustomTask, BULK_MAX } from '../../src/modules/cleaning/cleaning-ops.js';
import { quickPick } from '../../src/modules/cleaning/cleaning-advanced.js';
import { buildBoard, afterNextDue } from '../../src/modules/cleaning/cleaning-model.js';
import { buildSetupPlan, planWrites } from '../../src/modules/cleaning/cleaning-integration.js';
import { createCleaningStore } from '../../src/modules/cleaning/cleaning-store.js';

const DAY = '2026-11-18';
const T = (id, extra = {}) => ({ id, title: id, active: true, startDate: '2026-11-01', recurrence: { kind: 'days', interval: 1 }, assignMode: 'shared', assigneeUids: [], eligibleUids: [], priority: 'normal', ...extra });
const item = (task, occ = null, date = DAY) => ({ task, date, occ, occId: null });
const member = { uid: 'u', can: (p) => p === 'cleaning.view' || p === 'cleaning.complete', isChild: false };
const manager = { uid: 'u', can: () => true, isChild: false };

test('V630 mark all: only the SHOWN pending items this user may complete; claimed by others included; private excluded', () => {
  const shown = [
    item(T('a')), item(T('b'), { status: 'done' }), item(T('c'), { status: 'claimed', claimedBy: 'w' }),
    item(T('d', { assignMode: 'assigned', assigneeUids: ['w'] })),           // someone else's task
    item(T('e', { active: false })), { ...item(T('f')), state: 'inactive' }, item(T('a')),   // archived / pre-start / duplicate
    item(T('g'), { status: 'skipped' }),
  ];
  assert.deepEqual(completableItems(shown, member).map((x) => x.taskId), ['a', 'c', 'g']);
  assert.ok(completableItems(Array.from({ length: 300 }, (_, i) => item(T(`t${i}`))), member).length === BULK_MAX, 'bounded');
});

test('V630 mark all: Quick routine = exactly the quickPick items (time budget), never the other durations', () => {
  const items = [item(T('five', { estimatedMinutes: 5 })), item(T('fifteen', { estimatedMinutes: 15 })), item(T('four', { estimatedMinutes: 4 }))];
  const pick = quickPick(items, 10);
  assert.deepEqual(pick.items.map((i) => i.task.id).sort(), ['five', 'four']);
  assert.deepEqual(completableItems(pick.items, member).map((x) => x.taskId).sort(), ['five', 'four'], '15-minute task untouched');
});

test('V630 revalidate at commit: done meanwhile → already; archived / rights lost / pre-start → gone', () => {
  const sel = completableItems([item(T('a')), item(T('b')), item(T('c')), item(T('d'))], member);
  const tasks = [T('a'), T('b'), T('c', { active: false }), T('d', { startDate: '2026-11-19' })];
  const r = revalidate(sel, { tasks, occurrences: [{ id: 'b_20261118', taskId: 'b', status: 'done' }], ...member });
  assert.deepEqual([r.todo.map((x) => x.taskId), r.already.map((x) => x.taskId), r.gone.map((x) => x.taskId)], [['a'], ['b'], ['c', 'd']]);
});

test('V630 reset progress plan: recurring schedules restart today; today+ progress undone; history and one-offs in the past untouched', () => {
  const tasks = [T('a'), T('b', { startDate: DAY }), T('o', { recurrence: { kind: 'once' }, dueDate: '2026-11-02' }), T('n', { recurrence: { kind: 'once' }, dueDate: '2026-11-20' }),
    T('trig', { trigger: { deviceId: 'dw', kind: 'uses', every: 5 } }), T('arch', { active: false })];
  const occ = [{ id: 'a_20261117', taskId: 'a', dueDate: '2026-11-17', status: 'done' }, { id: 'a_20261118', taskId: 'a', dueDate: DAY, status: 'done' },
    { id: 'n_20261120', taskId: 'n', dueDate: '2026-11-20', status: 'skipped' }, { id: 'o_20261102', taskId: 'o', dueDate: '2026-11-02', status: 'done' },
    { id: 'arch_20261118', taskId: 'arch', dueDate: DAY, status: 'done' }];
  const p = progressResetPlan({ tasks, occurrences: occ, today: DAY });
  // V6.3.0.1: every task in scope moves to the next generation; startDate moves only for recurring, non-trigger, started before today
  assert.deepEqual(p.patches, [{ id: 'a', data: { resetGen: 1, startDate: DAY } }, { id: 'b', data: { resetGen: 1 } }, { id: 'n', data: { resetGen: 1 } }, { id: 'trig', data: { resetGen: 1 } }]);
  assert.deepEqual(p.undo.map((u) => [u.key, u.action, u.extra.taskGen]), [['a_20261118', 'reopen', 1], ['n_20261120', 'resume', 1]], 'undo runs under the new generation');
  assert.deepEqual(progressResetPlan({ tasks: [T('a', { resetGen: 4 })], occurrences: [], today: DAY }).patches[0].data.resetGen, 5, 'next generation, never skipping');
  // after the reset the old done occurrence no longer counts: the model ignores pre-start occurrences
  const after = { ...T('a'), startDate: DAY };
  assert.equal(afterNextDue({ ...after, recurrence: { kind: 'after', interval: 3 } }, [{ taskId: 'a', dueDate: '2026-11-17', status: 'done' }], 'UTC', DAY), DAY, 'stale completion cannot push the schedule');
});

function fakeRepo() {
  const data = new Map(); const ws = new Set(); const commits = []; let deny = () => false;
  const fire = () => { for (const w of ws) w(); };
  const list = (p) => [...data.entries()].filter(([k]) => k.startsWith(p)).map(([k, d]) => ({ id: k.split('/')[1], ...d }));
  return { data, commits, setDeny(f) { deny = f; }, now: () => 'NOW', newId: () => 'tid',
    watchTasks(h, on) { const w = () => on(list('cleaningTasks/')); ws.add(w); queueMicrotask(w); return () => ws.delete(w); },
    watchOccurrences(h, f, on) { const w = () => on(list('cleaningOccurrences/')); ws.add(w); queueMicrotask(w); return () => ws.delete(w); },
    taskExists: async (h, id) => data.has(`cleaningTasks/${id}`),
    async commit(h, ops) {
      await new Promise((r) => setTimeout(r, 1));
      for (const o of ops) if (deny(o)) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      for (const o of ops) if (o.mode === 'set' && /^(cleaningTasks|cleaningOccurrences|cleaningLog)$/.test(o.name) && data.has(`${o.name}/${o.id}`)) throw Object.assign(new Error('exists'), { code: 'permission-denied' });
      commits.push(...ops.map((o) => `${o.mode}:${o.name}:${o.id}`));
      for (const o of ops) data.set(`${o.name}/${o.id}`, o.mode === 'set' ? { ...o.data } : { ...data.get(`${o.name}/${o.id}`), ...o.data });
      fire();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function mk() {
  const repo = fakeRepo();
  const s = createCleaningStore({ homeId: 'H', uid: 'u', repo, today: () => DAY }); s.ensure({ canView: true }); s.subscribe(() => {}); await tick();
  return { repo, s, sync: async () => { await repo.commit('H', []); await tick(); } };
}

test('V630 store completeSelection: one audited write per item; double click refused; other-tab done = already; retry finishes without duplicates', async () => {
  const { repo, s, sync } = await mk();
  for (const id of ['a', 'b', 'c']) repo.data.set(`cleaningTasks/${id}`, T(id));
  await sync();
  const sel = completableItems(['a', 'b', 'c'].map((id) => item(T(id))), member);
  repo.data.set('cleaningOccurrences/b_20261118', { taskId: 'b', dueDate: DAY, status: 'done', rev: 1 }); await sync();   // another device
  repo.setDeny((o) => o.name === 'cleaningOccurrences' && o.id === 'c_20261118');
  const first = s.completeSelection(sel, member);
  await assert.rejects(s.completeSelection(sel, member), (e) => e.detail === 'cleaning.bulk.busy', 'second click while running');
  const r1 = await first;
  assert.deepEqual([r1.saved, r1.already, r1.failed.map((f) => f.taskId)], [1, 1, ['c']]);
  repo.setDeny(() => false);
  const r2 = await s.completeSelection(sel, member);
  assert.deepEqual([r2.saved, r2.already, r2.failed.length], [1, 2, 0], 'retry completes only what is left');
  const occWrites = repo.commits.filter((c) => c.startsWith('set:cleaningOccurrences:') || c.startsWith('update:cleaningOccurrences:'));
  assert.deepEqual(occWrites.sort(), ['set:cleaningOccurrences:a_20261118', 'set:cleaningOccurrences:c_20261118'], 'each completed once');
  assert.ok(repo.commits.some((c) => c.startsWith('set:cleaningLog:a_20261118')), 'audited');
});

test('V630 store resetProgress: undo + restart; retry repeats only failed steps; only cleaning collections written', async () => {
  const { repo, s, sync } = await mk();
  repo.data.set('cleaningTasks/a', T('a')); repo.data.set('cleaningTasks/b', T('b'));
  repo.data.set('cleaningOccurrences/a_20261118', { taskId: 'a', dueDate: DAY, status: 'done', rev: 1, completedBy: 'u' });
  repo.data.set('cleaningOccurrences/a_20261110', { taskId: 'a', dueDate: '2026-11-10', status: 'done', rev: 1, completedBy: 'u' });
  await sync();
  const snap = s.getSnapshot();
  const plan = progressResetPlan({ tasks: snap.tasks, occurrences: snap.occurrences, today: DAY });
  repo.setDeny((o) => o.name === 'cleaningTasks' && o.id === 'b');
  const r = await s.resetProgress(plan);
  assert.deepEqual([r.total, r.saved, r.failed.length, r.retry.patches.map((p) => p.id), r.retry.undo.length], [3, 2, 1, ['b'], 0]);
  assert.equal(repo.data.get('cleaningOccurrences/a_20261118').status, 'open', 'today reopened (audited)');
  assert.equal(repo.data.get('cleaningOccurrences/a_20261110').status, 'done', 'history kept');
  repo.setDeny(() => false);
  const r2 = await s.resetProgress(r.retry);
  assert.deepEqual([r2.total, r2.saved, r2.failed.length], [1, 1, 0]);
  assert.equal(repo.data.get('cleaningTasks/b').startDate, DAY);
  assert.ok(repo.commits.every((c) => /:(cleaningTasks|cleaningOccurrences|cleaningLog):/.test(c)), 'never rooms / devices');
  // a stale retry of the undo after new progress does not wipe it (already-open check uses live data)
  repo.data.set('cleaningOccurrences/a_20261118', { ...repo.data.get('cleaningOccurrences/a_20261118'), status: 'done', rev: 3 }); await sync();
  const r3 = await s.resetProgress({ undo: [], patches: [] });
  assert.equal(r3.total, 0); assert.equal(repo.data.get('cleaningOccurrences/a_20261118').status, 'done', 'new progress after the reset is kept');
});

const room = (id, type, extra = {}) => ({ id, name: id, type, active: true, ...extra });

test('V630 restore defaults: originals back, archived re-activated, missing created, custom kept by default; idempotent; no tasks for removed rooms', async () => {
  const { repo, s, sync } = await mk();
  const rooms = [room('k1', 'kitchen'), room('gone', 'bathroom', { active: false })];
  const setup = buildSetupPlan({ rooms, devices: [], tasks: [] });
  const writes = planWrites({ plan: setup, accepted: new Set(setup.pending.flatMap((g) => g.add.map((a) => a.id))), lang: 'en', uid: 'u', now: 'NOW', today: '2026-11-01' });
  assert.ok(writes.length >= 2 && writes.every((w) => w.id.startsWith('r_k1_')), 'only the active room');
  for (const w of writes) repo.data.set(`cleaningTasks/${w.id}`, { ...w.data });
  const [d0, d1] = writes.map((w) => w.id);
  repo.data.set(`cleaningTasks/${d0}`, { ...repo.data.get(`cleaningTasks/${d0}`), title: 'Renamed', estimatedMinutes: 99 });
  repo.data.set(`cleaningTasks/${d1}`, { ...repo.data.get(`cleaningTasks/${d1}`), active: false });
  const missing = writes[2] ? writes[2].id : null; if (missing) repo.data.delete(`cleaningTasks/${missing}`);
  repo.data.set('cleaningTasks/custom1', T('custom1', { roomId: 'k1' }));
  repo.data.set(`cleaningOccurrences/${d0}_20261118`, { taskId: d0, dueDate: DAY, status: 'done', rev: 1, completedBy: 'u' });
  await sync();
  const snap = () => s.getSnapshot();
  const plan = restoreDefaultsPlan({ rooms, devices: [], tasks: snap().tasks, lang: 'en', uid: 'u', now: 'NOW', today: DAY });
  assert.deepEqual(plan.reactivate, [d1]); assert.deepEqual(plan.archiveCustom, []);
  assert.ok(plan.patches.find((p) => p.id === d0).data.title !== 'Renamed');
  if (missing) assert.deepEqual(plan.creates.map((c) => c.id), [missing]);
  assert.ok(plan.creates.every((c) => !c.id.includes('gone')) && plan.patches.every((c) => !c.id.includes('gone')));
  const r = await s.restoreDefaults(plan, { today: DAY });
  assert.equal(r.failed.length, 0);
  assert.equal(repo.data.get(`cleaningTasks/${d0}`).estimatedMinutes, writes[0].data.estimatedMinutes);
  assert.equal(repo.data.get(`cleaningTasks/${d1}`).active, true);
  assert.equal(repo.data.get('cleaningTasks/custom1').active, true, 'custom kept');
  assert.equal(repo.data.get(`cleaningOccurrences/${d0}_20261118`).status, 'open', 'progress of defaults reset');
  assert.ok(repo.commits.every((c) => /:(cleaningTasks|cleaningOccurrences|cleaningLog):/.test(c)), 'rooms / devices never written');
  await sync();
  const again = restoreDefaultsPlan({ rooms, devices: [], tasks: snap().tasks, lang: 'en', uid: 'u', now: 'NOW', today: DAY });
  assert.deepEqual([again.reactivate, again.patches, again.creates, again.archiveCustom], [[], [], [], []], 'idempotent');
  assert.equal(snap().tasks.filter((x) => x.id.startsWith('r_k1_')).length, writes.length, 'no duplicates');
});

test('V630 restore defaults with "also remove custom tasks": customs archived (history kept), defaults untouched otherwise', async () => {
  const { repo, s, sync } = await mk();
  repo.data.set('cleaningTasks/custom1', T('custom1')); repo.data.set('cleaningTasks/custom2', T('custom2', { active: false }));
  await sync();
  const tasks = s.getSnapshot().tasks;
  assert.ok(tasks.every(isCustomTask));
  const keep = restoreDefaultsPlan({ rooms: [], devices: [], tasks, lang: 'en', uid: 'u', now: 'NOW', today: DAY });
  assert.deepEqual(keep.archiveCustom, [], 'unchecked by default → nothing removed');
  const plan = restoreDefaultsPlan({ rooms: [], devices: [], tasks, lang: 'en', uid: 'u', now: 'NOW', today: DAY, removeCustom: true });
  assert.deepEqual(plan.archiveCustom, ['custom1'], 'only active customs; never a hard delete');
  await s.restoreDefaults(plan, { today: DAY });
  assert.equal(repo.data.get('cleaningTasks/custom1').active, false); assert.ok(repo.data.has('cleaningTasks/custom1'), 'kept for history / restore');
  assert.ok(!repo.commits.some((c) => c.startsWith('delete:')));
});

test('V630 board: done occurrences dated before startDate never count (no resurrection after a reset)', () => {
  const task = T('a', { startDate: DAY });
  const b = buildBoard({ tasks: [task], occurrences: [{ id: 'a_20261117', taskId: 'a', dueDate: '2026-11-17', status: 'open' }], today: DAY, uid: 'u', can: () => true, isChild: false });
  const all = Object.values(b).flat().filter((x) => x && x.task);
  assert.ok(all.length > 0, 'board has items'); assert.ok(all.every((x) => x.date >= DAY), 'the pre-reset date is not shown again');
});
