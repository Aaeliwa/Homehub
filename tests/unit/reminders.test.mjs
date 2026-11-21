import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveReminders, applyState, counts, prefsOf, isQuiet, staleStates, stateDocId, fnv64, PREF_DEFAULTS } from '../../src/core/reminders/reminders-model.js';
import { createRemindersStore } from '../../src/core/reminders/reminders-store.js';

const can = (set) => (p) => set.includes(p);
const ALL = can(['cleaning.view', 'cleaning.complete', 'maintenance.view']);
const base = { active: true, assignMode: 'shared', assigneeUids: [], eligibleUids: [], priority: 'normal' };
const T = (id, extra = {}) => ({ id, title: id, recurrence: { kind: 'days', interval: 1 }, startDate: '2026-10-10', ...base, ...extra });
const freeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
const D = (args) => deriveReminders({ today: '2026-10-18', tz: 'UTC', uid: 'u', can: ALL, isChild: false, prefs: PREF_DEFAULTS, ...args });
const C = (tasks, occurrences = [], extra = {}) => ({ tasks, occurrences, deviceEvents: [], deviceStates: new Map(), ...extra });

test('V6.2 cleaning: ONE "Pending cleaning tasks" reminder (overdue + today, mine); count + rooms; done / skipped / not-mine / child / archived / upcoming excluded', () => {
  const P1 = (r) => r.filter((x) => x.sourceKind === 'cleaning');
  const r = P1(D({ cleaning: C([T('daily'), T('later', { recurrence: { kind: 'once' }, startDate: '2026-10-25', dueDate: '2026-10-25' }), T('soon', { recurrence: { kind: 'once' }, startDate: '2026-10-20', dueDate: '2026-10-20' })]) }));
  assert.equal(r.length, 1, 'one aggregated reminder, not one per task or per day');
  assert.deepEqual([r[0].key, r[0].titleKey, r[0].bucket, r[0].count, r[0].target.module], ['c:pending@2026-10-18', 'reminders.cleaningPending', 'overdue', 1, 'cleaning'], 'the daily task is pending (missed + today = ONE task)');
  assert.equal(P1(D({ cleaning: C([T('fresh', { startDate: '2026-10-19' })]) })).length, 0, 'only upcoming → nothing pending → no reminder');
  const ONCE = { recurrence: { kind: 'once' }, startDate: '2026-10-18', dueDate: '2026-10-18' };
  assert.equal(D({ cleaning: C([T('x', ONCE)], [{ id: 'x_20261018', taskId: 'x', dueDate: '2026-10-18', status: 'done', completedAt: '2026-10-18T08:00:00Z', rev: 1 }]) }).length, 0, 'done → nothing');
  assert.equal(D({ cleaning: C([T('x', ONCE)], [{ id: 'x_20261018', taskId: 'x', dueDate: '2026-10-18', status: 'skipped', skippedOn: '2026-10-18', rev: 1 }]) }).length, 0, 'skipped today → nothing');
  assert.equal(D({ cleaning: C([T('a', { assignMode: 'assigned', assigneeUids: ['other'] })]) }).length, 0, 'assigned to someone else → not mine');
  assert.equal(D({ cleaning: C([T('a')]), isChild: true }).length, 0, 'a child only sees tasks that list them');
  assert.equal(D({ cleaning: C([T('a', { startDate: '2026-10-18' })]), isVisible: () => false }).length, 0, 'archived room / device → hidden');
  const two = P1(D({ cleaning: C([T('a', { startDate: '2026-10-18', roomId: 'kit' }), T('b', { startDate: '2026-10-18', roomId: 'bath' }), T('c', { startDate: '2026-10-18', roomId: 'kit' })]) }));
  assert.deepEqual([two.length, two[0].count, two[0].rooms, two[0].bucket], [1, 3, 2, 'today'], 'count + distinct rooms');
  const fewer = P1(D({ cleaning: C([T('a', { startDate: '2026-10-18', roomId: 'kit' })]) }));
  assert.equal(fewer[0].key, two[0].key, 'same identity as counts change (no new notification per task)');
});

test('cleaning device triggers: after-use counts as ONE pending task; off-season seasonal tasks never remind', () => {
  const use = (id, at) => ({ id, deviceId: 'af', kind: 'use', voidsEventId: null, at });
  const t = T('basket', { recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'af' } });
  const r = D({ cleaning: C([t], [], { deviceEvents: [use('e1', '2026-10-18T08:00:00Z'), use('e2', '2026-10-18T09:00:00Z'), use('e3', '2026-10-18T10:00:00Z')] }) });
  assert.deepEqual(r.map((x) => [x.key, x.count]), [['c:pending@2026-10-18', 1]], 'three uses coalesce into one pending task');
  const season = T('acf', { recurrence: { kind: 'after', unit: 'day', interval: 14 }, trigger: { kind: 'seasonal', deviceId: 'ac', phase: 'active' } });
  assert.equal(D({ cleaning: C([season]) }).length, 0, 'no state → off season → nothing');
  assert.equal(D({ cleaning: C([season], [], { deviceStates: new Map([['ac', { state: 'active', rev: 1, updatedAt: '2026-10-15T00:00:00Z' }]]) }) }).length, 1);
});

const P = (extra = {}) => ({ id: 'pl1', title: 'AC service', deviceId: 'ac', priority: 'normal', recurrence: { kind: 'every', unit: 'month', interval: 1 }, firstDueDate: '2026-10-18', completedCount: 0, lastDoneDate: null, active: true, rev: 1, ...extra });
const F = (extra = {}) => ({ id: 'f1', summary: 'Leak', deviceId: 'ac', severity: 'high', status: 'open', rev: 1, ...extra });

test('maintenance: plans by after-last-completion (month clamp); completion → new cycle key; completed / archived excluded; faults open only, no date', () => {
  assert.deepEqual(D({ maintenance: { plans: [P()], faults: [] } }).map((x) => [x.key, x.bucket]), [['p:pl1@2026-10-18', 'today']]);
  const clamped = D({ maintenance: { plans: [P({ lastDoneDate: '2026-01-31', completedCount: 1, firstDueDate: '2026-01-01' })], faults: [] }, today: '2026-03-01' });
  assert.deepEqual(clamped.map((x) => [x.key, x.bucket]), [['p:pl1@2026-02-28', 'overdue']], '31 Jan + 1 month = 28 Feb');
  assert.equal(D({ maintenance: { plans: [P({ lastDoneDate: '2026-10-18', completedCount: 1 })], faults: [] } }).length, 0, 'completed today → next cycle beyond the look-ahead');
  assert.equal(D({ maintenance: { plans: [P({ recurrence: { kind: 'once' }, completedCount: 1 })], faults: [] } }).length, 0, 'one-time plan done');
  assert.equal(D({ maintenance: { plans: [P({ active: false })], faults: [] } }).length, 0, 'archived');
  const faults = D({ maintenance: { plans: [], faults: [F(), F({ id: 'f2', status: 'inProgress', severity: 'critical' }), F({ id: 'f3', status: 'resolved' }), F({ id: 'f4', status: 'closed' }), F({ id: 'f5', status: 'cancelled' })] } });
  assert.deepEqual(faults.map((x) => [x.key, x.bucket, x.date]), [['f:f2@r1', 'openFault', null], ['f:f1@r1', 'openFault', null]], 'critical first; never a fabricated date');
  assert.equal(D({ maintenance: { plans: [], faults: [F({ rev: 4, status: 'open' })] } })[0].key, 'f:f1@r4', 'reopen / change → new key');
});

test('permissions: no view permission → nothing (not even counts) from that source; prefs only change presentation', () => {
  const cl = C([T('a', { startDate: '2026-10-18' })]); const mt = { plans: [P()], faults: [F()] };
  assert.ok(D({ cleaning: null, maintenance: mt }).every((x) => x.sourceKind !== 'cleaning'));
  assert.ok(D({ cleaning: cl, maintenance: null }).every((x) => x.sourceKind === 'cleaning'));
  assert.equal(D({ cleaning: cl, maintenance: mt, prefs: { ...PREF_DEFAULTS, cleaning: false, maintenanceFaults: false } }).map((x) => x.sourceKind).join(), 'maintenancePlan');
});

test('identity, dedupe, ordering and NO mutation of source data', () => {
  const cl = freeze(C([T('a', { startDate: '2026-10-18' }), T('b', { recurrence: { kind: 'once' }, startDate: '2026-10-20', dueDate: '2026-10-20', priority: 'high' })]));
  const mt = freeze({ plans: [P({ firstDueDate: '2026-10-01' })], faults: [F({ severity: 'low' }), F({ id: 'f9', severity: 'critical' })] });
  const a = D({ cleaning: cl, maintenance: mt }); const b = D({ cleaning: cl, maintenance: mt });
  assert.deepEqual(a.map((x) => x.key), b.map((x) => x.key), 'deterministic');
  assert.equal(new Set(a.map((x) => x.key)).size, a.length, 'no duplicates');
  assert.deepEqual(a.map((x) => x.bucket), ['overdue', 'today', 'openFault', 'openFault'], 'V6.2: overdue maintenance plan, then ONE cleaning item (today); no per-task upcoming');
  assert.deepEqual(a.filter((x) => x.bucket === 'openFault').map((x) => x.severity), ['critical', 'low']);
  assert.equal(stateDocId('u1', 'p:pl1@2026-10-18'), `u1_${fnv64('p:pl1@2026-10-18')}`);
  assert.notEqual(stateDocId('u1', 'p:pl1@2026-10-18'), stateDocId('u1', 'p:pl1@2026-11-18'));
  assert.match(stateDocId('u1', 'c:x'), /^u1_[0-9a-f]{16}$/);
});

test('presentation: read / dismissed / snoozed (until a date, then unread again); counts', () => {
  const items = [{ key: 'a', bucket: 'overdue' }, { key: 'b', bucket: 'today' }, { key: 'c', bucket: 'upcoming' }, { key: 'd', bucket: 'openFault' }, { key: 'e', bucket: 'today' }];
  const st = [{ key: 'a', state: 'read' }, { key: 'b', state: 'dismissed' }, { key: 'c', state: 'snoozed', snoozeUntil: '2026-10-20' }, { key: 'e', state: 'snoozed', snoozeUntil: '2026-10-18' }];
  const r = applyState(items, st, '2026-10-18');
  assert.deepEqual(r.map((x) => x.presentation), ['read', 'dismissed', 'snoozed', 'unread', 'unread'], 'a snooze ending today → unread');
  assert.deepEqual(counts(r), { actionable: 3, unread: 2, hidden: 2, overdue: 1 });
});

test('prefs, quiet hours, bounded stale cleanup', () => {
  assert.deepEqual(prefsOf(null), PREF_DEFAULTS);
  assert.deepEqual(prefsOf({ lookAheadDays: 5, cleaning: 'no', quietStart: 25 }), PREF_DEFAULTS, 'invalid values fall back');
  assert.equal(prefsOf({ lookAheadDays: 14, maintenanceFaults: false }).lookAheadDays, 14);
  assert.equal(isQuiet({ quietStart: 22, quietEnd: 6 }, 23), true); assert.equal(isQuiet({ quietStart: 22, quietEnd: 6 }, 5), true);
  assert.equal(isQuiet({ quietStart: 22, quietEnd: 6 }, 12), false); assert.equal(isQuiet({ quietStart: 9, quietEnd: 9 }, 9), false); assert.equal(isQuiet(PREF_DEFAULTS, 3), false);
  const now = Date.parse('2026-10-18T00:00:00Z');
  const s = [{ id: 'x1', key: 'old', updatedAt: '2026-08-01T00:00:00Z' }, { id: 'x2', key: 'cur', updatedAt: '2026-08-01T00:00:00Z' }, { id: 'x3', key: 'recent', updatedAt: '2026-10-10T00:00:00Z' }];
  assert.deepEqual(staleStates(s, ['cur'], now).map((x) => x.id), ['x1'], 'only stale AND no longer current');
  assert.equal(staleStates(Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, key: `k${i}`, updatedAt: '2026-01-01T00:00:00Z' })), [], now).length, 20, 'bounded');
});

test('store: owner-scoped writes (presentation only), prefs validated, listeners disposed', async () => {
  const ops = []; let w = 0;
  const repo = { now: () => 'N', watchStates: (h, uid, on) => { w++; queueMicrotask(() => on([])); return () => w--; }, watchPrefs: (h, uid, on) => { w++; queueMicrotask(() => on(null)); return () => w--; },
    commit: async (h, o) => { ops.push(...o); } };
  const s = createRemindersStore({ homeId: 'H', uid: 'u1', repo });
  await s.mark('p:pl1@2026-10-18', 'snoozed', '2026-10-21'); await s.mark('f:f1@r2', 'dismissed', '2026-10-21'); await s.clear('c:x');
  assert.deepEqual(ops[0], { mode: 'set', name: 'reminderStates', id: stateDocId('u1', 'p:pl1@2026-10-18'), data: { ownerUid: 'u1', key: 'p:pl1@2026-10-18', state: 'snoozed', snoozeUntil: '2026-10-21', sourceKind: 'maintenancePlan', updatedAt: 'N', schemaVersion: 1 } });
  assert.equal(ops[1].data.snoozeUntil, null, 'snooze date only for snoozed');
  assert.deepEqual(ops[2], { mode: 'delete', name: 'reminderStates', id: stateDocId('u1', 'c:x') });
  assert.ok(ops.every((o) => ['reminderStates', 'reminderPrefs'].includes(o.name)), 'never writes Cleaning / Maintenance');
  await assert.rejects(s.savePrefs({ ...PREF_DEFAULTS, lookAheadDays: 5 }), (e) => e.detail === 'reminders.err.prefs');
  await s.savePrefs({ ...PREF_DEFAULTS, quietStart: 22, quietEnd: 6 });
  assert.deepEqual(ops.at(-1).data, { lookAheadDays: 3, cleaning: true, maintenancePlans: true, maintenanceFaults: true, calendar: true, commitments: true, quietStart: 22, quietEnd: 6, updatedAt: 'N', schemaVersion: 1 });
  assert.equal(ops.at(-1).id, 'u1');
  assert.equal(w, 2); s.dispose(); assert.equal(w, 0);
});
