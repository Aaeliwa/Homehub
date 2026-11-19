// V6.4 Batch A: post-reset "This task is no longer active" (root cause: the day's saved routine plan still
// names keys that a reset / restore / archive removed from the schedule), the monthly-budget dashboard
// selector, and the registry change (Rooms / Devices counts move into the Your Home card).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineView, routineSummary, routineItems, buildRoutinePlan } from '../../src/modules/cleaning/cleaning-advanced.js';
import { buildBoard } from '../../src/modules/cleaning/cleaning-model.js';
import { progressResetPlan, restoreDefaultsPlan, completableItems } from '../../src/modules/cleaning/cleaning-ops.js';
import { monthBudget } from '../../src/modules/expenses/finance-monthly.js';
import { registry as reg } from '../../src/modules/index.js';

const DAY = '2026-11-19';
const T = (id, extra = {}) => ({ id, title: id, active: true, startDate: '2026-11-01', recurrence: { kind: 'days', interval: 1 }, assignMode: 'shared', assigneeUids: [], eligibleUids: [], priority: 'normal', estimatedMinutes: 10, roomId: 'kit', ...extra });
const can = () => true;
const board = (tasks, occurrences) => buildBoard({ tasks, occurrences, today: DAY, uid: 'u', can, isChild: false, tz: 'UTC' });
const plan0 = ['a_20261117', 'a_20261118', 'a_20261119', 'b_20261119', 'gone_20261119', 'dev_u77'];
const occ0 = [
  { id: 'a_20261117', taskId: 'a', dueDate: '2026-11-17', status: 'done', rev: 1 },   // history before the reset
  { id: 'dev_u77', taskId: 'dev', dueDate: '2026-11-10', status: 'open', rev: 1, triggerEventId: '77' },
];

test('V640-A2 reproduce: after a progress reset the SAVED plan yields "inactive" rows (the reported symptom)', () => {
  const tasks = [T('a'), T('b'), T('dev', { recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'd1' }, deviceId: 'd1' })];
  const plan = progressResetPlan({ tasks, occurrences: occ0, today: DAY });
  const after = tasks.map((x) => ({ ...x, ...(plan.patches.find((p) => p.id === x.id) || { data: {} }).data }));
  const raw = routineItems({ plan: plan0, tasks: after, occurrences: occ0 });
  assert.deepEqual(raw.filter((i) => i.state === 'inactive').map((i) => [i.key, i.reason]),
    [['a_20261117', 'reset'], ['a_20261118', 'reset'], ['gone_20261119', 'missing']], 'pre-start dates + a deleted task = the repeated message');
});

test('V640-A2 fix: the routine view lists ONLY current work; obsolete keys counted once; valid due tasks kept; nothing listed twice', () => {
  const tasks = [T('a'), T('b'), T('dev', { recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'd1' }, deviceId: 'd1' })];
  const plan = progressResetPlan({ tasks, occurrences: occ0, today: DAY });
  const after = tasks.map((x) => ({ ...x, ...(plan.patches.find((p) => p.id === x.id) || { data: {} }).data }));
  const v = routineView({ plan: plan0, tasks: after, occurrences: occ0, board: board(after, occ0) });
  assert.deepEqual(v.items.map((i) => i.key), ['a_20261119', 'b_20261119', 'dev_u77'], 'today + device-triggered work stays');
  assert.ok(v.items.every((i) => i.state !== 'inactive'));
  assert.equal(v.obsolete.length, 3);
  assert.deepEqual(v.extras.map((i) => i.task.id), [], 'the restarted schedule is already in the plan → not duplicated');
  assert.deepEqual(v.progress, { done: 0, total: 3, skipped: 0, postponed: 0 });
  assert.equal(occ0[0].status, 'done', 'history occurrence untouched (pure view)');
  assert.deepEqual(completableItems([...v.items, ...v.extras], { uid: 'u', can, isChild: false }).map((x) => x.taskId).sort(), ['a', 'b', 'dev'], 'Mark All = exactly what is shown');
});

test('V640-A2 repeated resets, restore defaults (staggered start), archived and hidden tasks', () => {
  // second reset the same day: startDate already today → nothing new becomes obsolete, nothing disappears
  const once = [T('a', { startDate: DAY, resetGen: 1 })];
  const again = progressResetPlan({ tasks: once, occurrences: [], today: DAY });
  const twice = [{ ...once[0], ...again.patches[0].data }];
  const v2 = routineView({ plan: ['a_20261119'], tasks: twice, occurrences: [], board: board(twice, []) });
  assert.deepEqual([v2.items.length, v2.obsolete.length], [1, 0]);
  // restore defaults: a default restarts on a LATER staggered date → today's planned key is obsolete and the
  // task is not due today (so it is not invented as an extra either)
  const rooms = [{ id: 'k1', name: 'k1', type: 'kitchen', active: true }];
  const seed = restoreDefaultsPlan({ rooms, devices: [], tasks: [], lang: 'en', uid: 'u', now: 'N', today: '2026-11-01' }).creates.map((c) => ({ id: c.id, ...c.data }));
  const r = restoreDefaultsPlan({ rooms, devices: [], tasks: seed, lang: 'en', uid: 'u', now: 'N', today: DAY });
  const restored = seed.map((x) => ({ ...x, ...((r.patches.find((p) => p.id === x.id) || {}).data || {}) }));
  const plan = restored.map((x) => `${x.id}_20261118`).concat(restored.map((x) => `${x.id}_20261119`));
  const v = routineView({ plan, tasks: restored, occurrences: [], board: board(restored, []) });
  assert.ok(v.items.every((i) => i.date >= i.task.startDate), 'no pre-start key is shown');
  assert.ok(v.obsolete.length >= restored.length, 'yesterday keys + staggered defaults are obsolete');
  const dueToday = board(restored, []).today.map((i) => i.task.id).sort();
  assert.deepEqual([...v.items, ...v.extras].map((i) => i.task.id).sort(), dueToday, 'exactly the tasks due today');
  // archived / hidden (room archived) tasks
  const tasks = [T('a', { active: false }), T('b', { roomId: 'gone' }), T('c')];
  const vis = (t) => t.roomId !== 'gone';
  const v3 = routineView({ plan: ['a_20261119', 'b_20261119', 'c_20261119'], tasks, occurrences: [], board: buildBoard({ tasks, occurrences: [], today: DAY, uid: 'u', can, isChild: false, tz: 'UTC', isVisible: vis }), isVisible: vis });
  assert.deepEqual([v3.items.map((i) => i.key), v3.obsolete.map((i) => i.reason)], [['c_20261119'], ['archived', 'hidden']]);
});

test('V640-A2 legitimate current occurrences (done / skipped today) stay visible with their real state', () => {
  const tasks = [T('a', { startDate: DAY, resetGen: 1 })];
  const occ = [{ id: 'a_20261119', taskId: 'a', dueDate: DAY, status: 'done', rev: 3, taskGen: 1, completedBy: 'u' }];
  const v = routineView({ plan: ['a_20261119'], tasks, occurrences: occ, board: board(tasks, occ) });
  assert.deepEqual([v.items[0].state, v.extras.length, v.progress.done], ['done', 0, 1]);
  assert.equal(buildRoutinePlan ? typeof buildRoutinePlan : 'function', 'function');
});

// ---- V6.4.0-a review: progress / bar / empty state are computed over exactly what is shown
const view = (plan, tasks, occ) => routineView({ plan, tasks, occurrences: occ, board: board(tasks, occ) });
const restart = (tasks) => tasks.map((x) => ({ ...x, startDate: DAY, resetGen: (x.resetGen || 0) + 1 }));
const occAt = (taskId, status, gen = 1, date = DAY) => ({ id: `${taskId}_${date.replace(/-/g, '')}`, taskId, dueDate: date, status, rev: 2, taskGen: gen, ...(status === 'skipped' ? { skippedOn: DAY } : {}) });

test('V640-A2r all saved plan items obsolete but valid extras exist → progress counts the extras (never "nothing today")', () => {
  // the plan was saved on an older schedule (yesterday's catch-up + a task started later) → everything obsolete
  const tasks = restart([T('a'), T('b')]);
  const v = view(['a_20261117', 'a_20261118', 'b_20261118', 'gone_20261119'], tasks, []);
  assert.deepEqual([v.items.length, v.obsolete.length], [0, 4]);
  assert.deepEqual(v.extras.map((i) => i.key).sort(), ['a_20261119', 'b_20261119']);
  assert.ok(v.extras.every((i) => i.state === 'open'), 'extras normalised to plan-item states');
  assert.deepEqual(v.progress, { done: 0, total: 2, skipped: 0, postponed: 0 });
  assert.deepEqual(routineSummary(v), { kind: 'progress', done: 0, total: 2, skipped: 0, postponed: 0, pct: 0 });
});

test('V640-A2r mixed plan items and extras; completing extras moves the SAME counter; skipped / postponed excluded from the total', () => {
  const tasks = [T('a', { startDate: DAY }), T('b', { startDate: DAY }), T('c', { startDate: DAY }), T('d', { startDate: DAY })];
  const plan = ['a_20261119', 'b_20261119'];   // c, d were created after the plan was saved
  let v = view(plan, tasks, []);
  assert.deepEqual([v.items.map((i) => i.key), v.extras.map((i) => i.key).sort()], [plan, ['c_20261119', 'd_20261119']]);
  assert.deepEqual(routineSummary(v), { kind: 'progress', done: 0, total: 4, skipped: 0, postponed: 0, pct: 0 });
  v = view(plan, tasks, [occAt('a', 'done'), occAt('c', 'done')]);   // one plan item + one extra completed
  assert.deepEqual(routineSummary(v), { kind: 'progress', done: 2, total: 4, skipped: 0, postponed: 0, pct: 50 });
  assert.equal(v.extras.find((i) => i.key === 'c_20261119').state, 'done', 'a completed extra stays visible as done');
  // a postponed PLAN item stays listed (excluded from the total); a postponed task that is not in the plan is
  // not due today on the board, so it is (correctly) not an extra at all
  v = view(plan, tasks, [occAt('a', 'done'), occAt('b', 'postponed'), occAt('c', 'done'), occAt('d', 'skipped')]);
  assert.deepEqual(routineSummary(v), { kind: 'progress', done: 2, total: 2, skipped: 1, postponed: 1, pct: 100 });
  v = view(plan, tasks, [occAt('a', 'skipped'), occAt('b', 'postponed'), occAt('c', 'skipped'), occAt('d', 'skipped')]);
  assert.equal(routineSummary(v).kind, 'settled', 'only skipped / postponed shown → not "empty", not 0 of 0');
  assert.equal(routineSummary(view([], [], [])).kind, 'empty');
  assert.deepEqual(completableItems(v.shown, { uid: 'u', can, isChild: false }).length, v.shown.length, 'skipped / postponed shown items are still completable');
});

test('V640-A2r no duplicate counting: a task in the plan is never counted again as an extra; device-triggered items once', () => {
  const tasks = [T('a', { startDate: DAY }), T('dev', { recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'd1' }, deviceId: 'd1' })];
  const occ = [{ id: 'dev_u77', taskId: 'dev', dueDate: '2026-11-10', status: 'open', rev: 1, triggerEventId: '77' }, occAt('a', 'done')];
  const v = view(['a_20261119', 'dev_u77'], tasks, occ);
  const keys = v.shown.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, 'each key once');
  assert.deepEqual(keys.sort(), ['a_20261119', 'dev_u77']);
  assert.deepEqual(v.progress, { done: 1, total: 2, skipped: 0, postponed: 0 });
  // the same extra appearing in both board lists (today + overdue) is still counted once
  const dup = routineView({ plan: [], tasks, occurrences: [], board: { today: [{ task: tasks[0], date: DAY, occ: null, occId: null }], overdue: [{ task: tasks[0], date: DAY, occ: null, occId: null }] } });
  assert.deepEqual([dup.extras.length, dup.progress.total], [1, 1]);
});

test('V640-A2r repeated resets: counters stay consistent (obsolete never counted, current work counted once)', () => {
  let tasks = [T('a'), T('b')];
  const plan = ['a_20261117', 'a_20261118', 'a_20261119', 'b_20261119'];
  let occ = [occAt('a', 'done', 0), occAt('b', 'done', 0)];
  let v = view(plan, tasks, occ);
  assert.deepEqual([routineSummary(v).done, routineSummary(v).total], [2, 4], 'before: a (17, 18, 19) + b (19); today\'s two done');
  for (let round = 1; round <= 3; round++) {
    tasks = restart(tasks);
    occ = occ.map((o) => ({ ...o, status: 'open', taskGen: round, rev: o.rev + 1 }));   // the audited undo of today's progress
    v = view(plan, tasks, occ);
    assert.deepEqual([v.items.map((i) => i.key), v.obsolete.length, v.extras.length], [['a_20261119', 'b_20261119'], 2, 0], `round ${round}`);
    assert.deepEqual(routineSummary(v), { kind: 'progress', done: 0, total: 2, skipped: 0, postponed: 0, pct: 0 }, `round ${round}`);
  }
  occ = occ.map((o) => (o.taskId === 'a' ? { ...o, status: 'done' } : o));
  assert.deepEqual(routineSummary(view(plan, tasks, occ)).done, 1, 'new progress after the resets counts');
});

const exp = (id, amountMinor, date, extra = {}) => ({ id, amountMinor, date, audience: 'household', status: 'active', category: 'food', ...extra });
const snap = (expenses, monthly = [], movements = []) => ({ expenses, movements, monthly });

test('V640-A6 monthly budget: remaining, usage %, over budget, clamp, no budget, zero, refunds, boundaries, inheritance', () => {
  const m = [{ id: '2026-11', budgetMinor: 1000000, categoryLimits: {} }];
  let r = monthBudget(snap([exp('e1', 250000, '2026-11-03'), exp('e0', 999999, '2026-10-31'), exp('e2', 50000, '2026-12-01')], m), '2026-11');
  assert.deepEqual([r.hasBudget, r.spentMinor, r.remainingMinor, r.pct, r.fillPct, r.over], [true, 250000, 750000, 25, 25, false], 'only this month (own date)');
  r = monthBudget(snap([exp('e1', 1000000, '2026-11-03')], m), '2026-11');
  assert.deepEqual([r.remainingMinor, r.pct, r.over], [0, 100, false]);
  r = monthBudget(snap([exp('e1', 1234567, '2026-11-03')], m), '2026-11');
  assert.deepEqual([r.remainingMinor, r.pct, r.fillPct, r.over], [-234567, 123, 100, true], 'real % shown, bar clamped');
  r = monthBudget(snap([exp('e1', 1, '2026-11-03')], [{ id: '2026-11', budgetMinor: 3 }]), '2026-11');
  assert.equal(r.pct, 33, 'rounded');
  r = monthBudget(snap([exp('e1', 100, '2026-11-03')], [{ id: '2026-11', budgetMinor: 0 }]), '2026-11');
  assert.deepEqual([r.hasBudget, r.remainingMinor, r.pct, r.fillPct], [true, -100, null, 100], 'zero budget: no division');
  r = monthBudget(snap([exp('e1', 100, '2026-11-03')]), '2026-11');
  assert.deepEqual([r.hasBudget, r.remainingMinor, r.pct, r.spentMinor], [false, null, null, 100], 'no budget: no invented values');
  r = monthBudget(snap([exp('e1', 100, '2026-11-03')], [{ id: '2026-11', budgetMinor: null }]), '2026-11');
  assert.equal(r.hasBudget, false);
  r = monthBudget(snap([exp('e1', 100, '2026-11-03')], [], [{ id: 'r1', type: 'refund', amountMinor: 300, date: '2026-11-04', audience: 'household', status: 'active', refundOf: 'e1' }]), '2026-11');
  assert.equal(r.spentMinor, -200, 'refunds net the month (accounting unchanged)');
  r = monthBudget(snap([exp('e1', 100, '2026-11-03')], [{ id: '2026-11', budgetMinor: 1000 }], [{ id: 'r1', type: 'refund', amountMinor: 300, date: '2026-11-04', audience: 'household', status: 'active', refundOf: 'e1' }]), '2026-11');
  assert.deepEqual([r.pct, r.fillPct, r.remainingMinor], [0, 0, 1200], 'never a negative bar');
  r = monthBudget(snap([exp('e1', 500, '2026-11-03'), exp('zk_1', 400, '2026-11-03', { category: 'zakat' }), exp('p1', 400, '2026-11-03', { audience: 'private' }), exp('v1', 400, '2026-11-03', { status: 'void' })], [{ id: '2026-09', budgetMinor: 1000 }]), '2026-11');
  assert.deepEqual([r.spentMinor, r.budgetMinor, r.inherited], [500, 1000, true], 'Zakat / private / void excluded; earlier setting inherited');
  for (const x of [r, monthBudget(snap([]), '2026-11')]) for (const v of Object.values(x)) assert.ok(!Number.isNaN(v), 'never NaN');
});

test('V640-A8 registry: Rooms / Devices are Your Home counts, not dashboard tiles', () => {
  const owner = { can: () => true, canAny: () => true };
  const widgets = reg.widgetsFor(owner).map((m) => m.id);
  assert.ok(!widgets.includes('rooms') && !widgets.includes('devices'));
  assert.deepEqual(reg.homeCountsFor(owner).map((m) => m.id), ['rooms', 'devices']);
  const none = { can: () => false, canAny: () => false };
  assert.deepEqual(reg.homeCountsFor(none), [], 'no rooms.view / devices.view → no count');
});
