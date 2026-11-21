// V6.4.1 Stage B — unified Upcoming model, contact-activity Calendar fields, Calendar / Finance reminders,
// time zones + midnight rollover, the shared sources hub (one clock, reference-counted, cleanup on Home switch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateEvent, createDoc, editPatch, reviveDoc, EDITABLE, isActivity, statusOf, reminderOf, isOpenItem } from '../../src/modules/calendar/calendar-model.js';
import { createCalendarStore } from '../../src/modules/calendar/calendar-store.js';
import { calendarItems, commitmentItems, homeCareItems, deriveUpcoming, reminderDueAt, calendarReminders, nextReminderAt, commitmentReminders,
  nowMinutesIn, DASHBOARD_HORIZON, OVERDUE_LOOKBACK } from '../../src/core/upcoming/upcoming-model.js';
import { deriveReminders, prefsOf, PREF_DEFAULTS, applyState, stateDocId } from '../../src/core/reminders/reminders-model.js';
import { createRemindersStore } from '../../src/core/reminders/reminders-store.js';
import { createSources } from '../../src/core/upcoming/upcoming-hub.js';
import { sourceFlags, canSeeReminders } from '../../src/core/upcoming/access.js';
import { setContactsFocus, takeContactsFocus } from '../../src/modules/contacts/contacts-nav.js';
import { setCalendarFocus, takeCalendarFocus } from '../../src/modules/calendar/calendar-focus.js';
import { setFinanceFocus, takeFinanceFocus } from '../../src/modules/expenses/finance-focus.js';
import { advance } from '../../src/modules/expenses/recurrence.js';
import { todayIn, addDays } from '../../src/modules/expenses/calendar.js';
import en from '../../src/core/i18n/locales/en.js';
import ar from '../../src/core/i18n/locales/ar.js';

const TODAY = '2026-11-21';
const E = (id, x = {}) => ({ id, title: id, type: 'other', shift: null, allDay: true, startDate: TODAY, endDate: TODAY, startTime: null, endTime: null, audience: 'household',
  createdBy: 'u1', done: false, deletedAt: null, rev: 1, ...x });
const ACT = (id, x = {}) => E(id, { kind: 'contactActivity', contactId: 'contact01', status: 'planned', ...x });
const CM = (id, x = {}) => ({ id, name: id, amountMinor: 150000, currency: 'EGP', category: 'utilities', recurrence: { unit: 'month', interval: 1 }, anchorDay: 31, nextDueDate: TODAY, active: true, audience: 'household', ...x });

// --------------------------------------------------------------------------------------------- B1 model
test('B-cal: optional fields validate; ordinary events keep the exact V6.2 shape; legacy edits never add them; CSV revive unchanged', () => {
  const plain = validateEvent({ title: 'Dentist', startDate: TODAY, allDay: true });
  assert.deepEqual([plain.value.kind, plain.value.contactId, plain.value.status, plain.value.reminderMinutes], [null, null, null, null]);
  const doc = createDoc(plain.value, { uid: 'u1', now: 'N', timezone: 'Africa/Cairo' });
  for (const k of ['kind', 'contactId', 'status', 'reminderMinutes']) assert.equal(k in doc, false, `${k} not written on an ordinary event`);
  const act = validateEvent({ title: 'Call back', startDate: TODAY, allDay: false, startTime: '10:00', endTime: '10:15', kind: 'contactActivity', contactId: 'contact01', reminderMinutes: '15' });
  assert.deepEqual(act.errors, {}); assert.deepEqual([act.value.kind, act.value.contactId, act.value.status, act.value.reminderMinutes], ['contactActivity', 'contact01', 'planned', 15]);
  const ad = createDoc(act.value, { uid: 'u1', now: 'N', timezone: 'UTC' });
  assert.deepEqual([ad.kind, ad.contactId, ad.status, ad.reminderMinutes], ['contactActivity', 'contact01', 'planned', 15]);
  assert.equal(createDoc(act.value, { uid: 'u1', now: 'N', timezone: 'UTC', source: 'csv', sourceKey: 'a'.repeat(16), importBatchId: 'batch01' }).kind, undefined, 'CSV imports never carry them');
  assert.equal(validateEvent({ title: 'x', startDate: TODAY, kind: 'contactActivity' }).errors.contact, 'calendar.err.contact', 'an activity needs a contact');
  assert.equal(validateEvent({ title: 'x', startDate: TODAY, kind: 'contactActivity', contactId: '../evil' }).errors.contact, 'calendar.err.contact');
  for (const bad of [5, 30, -15, '2h', 99999]) assert.equal(validateEvent({ title: 'x', startDate: TODAY, reminderMinutes: bad }).value.reminderMinutes, null, `offset ${bad} refused`);
  assert.equal(validateEvent({ title: 'x', startDate: TODAY, kind: 'meeting', contactId: 'contact01', status: 'done' }).value.kind, null, 'unknown kind → ordinary event, no link');
  assert.equal(validateEvent({ title: 'x', startDate: TODAY, kind: 'contactActivity', contactId: 'contact01', status: 'weird' }).value.status, 'planned');
  // an older event (no Stage B keys) edited with the same values → no patch at all
  const legacy = E('old1', { description: null, location: null });
  assert.equal(editPatch(legacy, validateEvent({ ...legacy }).value, { uid: 'u1', now: 'N' }), null);
  // reminders: setting one only patches that field
  assert.deepEqual(Object.keys(editPatch(legacy, validateEvent({ ...legacy, reminderMinutes: 60 }).value, { uid: 'u1', now: 'N' })).sort(), ['reminderMinutes', 'rev', 'updatedAt', 'updatedBy']);
  assert.deepEqual(Object.keys(reviveDoc(legacy, plain.value, { uid: 'u1', now: 'N', importBatchId: 'b' })).filter((k) => ['kind', 'contactId', 'status', 'reminderMinutes'].includes(k)), [], 'revive writes only the V6.2.1 field set');
  assert.ok(EDITABLE.includes('reminderMinutes'));
  assert.deepEqual([isActivity(ACT('a')), statusOf(E('b')), reminderOf(E('c', { reminderMinutes: 7 })), isOpenItem(E('d')), isOpenItem(E('t', { type: 'task' }))], [true, null, null, false, true]);
});

test('B-cal store: setStatus only for activities; edit keeps the contact link and status / reminder unless given', async () => {
  const ops = []; let docs = [];
  const repo = { now: () => 'N', newId: () => 'newid001', watchHousehold: (h, on) => { on(docs); return () => {}; }, watchMine: (h, u, on) => { on([]); return () => {}; },
    watchImportsHousehold: (h, on) => { on([]); return () => {}; }, watchImportsMine: (h, u, on) => { on([]); return () => {}; }, commit: async (h, o) => { ops.push(...o); } };
  docs = [ACT('act00001', { title: 'Call', rev: 3, reminderMinutes: 15 }), E('evt00001')];
  const s = createCalendarStore({ homeId: 'H', uid: 'u1', timezone: 'UTC', repo });
  await s.setStatus('act00001', 'done');
  assert.deepEqual(ops.at(-1), { mode: 'update', id: 'act00001', data: { status: 'done', rev: 4, updatedBy: 'u1', updatedAt: 'N' } });
  await assert.rejects(s.setStatus('evt00001', 'done'), (e) => e.detail === 'calendar.err.notActivity');
  await assert.rejects(s.setStatus('act00001', 'lost'), (e) => e.detail === 'calendar.err.status');
  await s.edit('act00001', { title: 'Call back', startDate: TODAY, allDay: true, kind: null, contactId: 'other0001' });
  const p = ops.at(-1).data;
  assert.equal(p.title, 'Call back'); for (const k of ['kind', 'contactId', 'status', 'reminderMinutes']) assert.equal(k in p, false, `${k} unchanged`);
  s.dispose();
});

test('B-upcoming calendar: buckets, multi-day once, plain past dropped, open items overdue (bounded), done / cancelled / deleted out, horizon, contact filter, private flag', () => {
  const evs = [
    E('today1', { allDay: false, startTime: '18:00', endTime: '19:00' }), E('tomorrow', { startDate: addDays(TODAY, 1), endDate: addDays(TODAY, 1) }),
    E('trip', { startDate: addDays(TODAY, -2), endDate: addDays(TODAY, 2) }),                         // running → today, once
    E('pastPlain', { startDate: addDays(TODAY, -3), endDate: addDays(TODAY, -3) }),
    E('pastTask', { type: 'task', startDate: addDays(TODAY, -3), endDate: addDays(TODAY, -3) }),
    E('pastTaskDone', { type: 'task', done: true, startDate: addDays(TODAY, -3), endDate: addDays(TODAY, -3) }),
    E('ancientTask', { type: 'task', startDate: addDays(TODAY, -(OVERDUE_LOOKBACK + 1)), endDate: addDays(TODAY, -(OVERDUE_LOOKBACK + 1)) }),
    ACT('pastAct', { startDate: addDays(TODAY, -1), endDate: addDays(TODAY, -1) }), ACT('cancelled', { status: 'cancelled' }), ACT('doneAct', { status: 'done' }),
    E('deleted', { deletedAt: 'x' }), E('far', { startDate: addDays(TODAY, DASHBOARD_HORIZON + 1), endDate: addDays(TODAY, DASHBOARD_HORIZON + 1) }),
    E('edge', { startDate: addDays(TODAY, DASHBOARD_HORIZON), endDate: addDays(TODAY, DASHBOARD_HORIZON) }),
    ACT('privAct', { audience: 'private', contactId: 'contact02', startDate: addDays(TODAY, 3), endDate: addDays(TODAY, 3) }),
    E('midnight', { allDay: false, startDate: addDays(TODAY, -1), endDate: TODAY, startTime: '22:00', endTime: '00:00' }),   // ended at 00:00 → not today
  ];
  const items = calendarItems(evs, { today: TODAY });
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(by).sort(), ['edge', 'pastAct', 'pastTask', 'privAct', 'today1', 'tomorrow', 'trip'].sort());
  assert.deepEqual([by.today1.bucket, by.trip.bucket, by.trip.date, by.tomorrow.bucket, by.pastTask.bucket, by.pastAct.bucket], ['today', 'today', TODAY, 'upcoming', 'overdue', 'overdue']);
  assert.equal(by.trip.key, `e:trip@${addDays(TODAY, -2)}`, 'one key per event start, whatever day it is viewed');
  assert.deepEqual([by.privAct.private, by.privAct.source, by.privAct.contactId, by.privAct.status], [true, 'contactActivity', 'contact02', 'planned']);
  assert.deepEqual(calendarItems(evs, { today: TODAY, horizonDays: 30, contactId: 'contact01' }).map((i) => i.id), ['pastAct'], 'contact panel: that contact only, open items only');
});

test('B-upcoming finance: next due only (no duplicate occurrences), overdue, recurrence advance → new key, amounts only when allowed, inactive out', () => {
  const list = [CM('rent', { nextDueDate: addDays(TODAY, -2) }), CM('net', { nextDueDate: TODAY }), CM('gym', { nextDueDate: addDays(TODAY, 5), recurrence: { unit: 'week', interval: 1 } }),
    CM('old', { active: false }), CM('later', { nextDueDate: addDays(TODAY, 30) }), CM('mine', { audience: 'restricted', nextDueDate: addDays(TODAY, 1) })];
  const items = commitmentItems(list, { today: TODAY });
  assert.deepEqual(items.map((i) => [i.id, i.bucket]), [['rent', 'overdue'], ['net', 'today'], ['mine', 'upcoming'], ['gym', 'upcoming']]);
  assert.equal(items.filter((i) => i.id === 'gym').length, 1, 'a weekly commitment is ONE row (its next due date), never expanded');
  assert.ok(items.every((i) => i.amountMinor === null), 'no amounts without expenses.viewFinancialTotals');
  assert.equal(commitmentItems(list, { today: TODAY, showAmounts: true })[0].amountMinor, 150000);
  assert.equal(items.find((i) => i.id === 'mine').private, true);
  // paying advances nextDueDate with Finance's own recurrence (anchor day 31 → Feb clamps) → a new identity
  const paid = CM('rent', { nextDueDate: advance('2026-01-31', { unit: 'month', interval: 1 }, 31) });
  assert.equal(paid.nextDueDate, '2026-02-28');
  assert.equal(commitmentItems([paid], { today: '2026-02-20', horizonDays: 10 })[0].key, 'm:rent@2026-02-28');
  assert.equal(advance('2026-02-28', { unit: 'month', interval: 1 }, 31), '2026-03-31', 'anchor day restored after a short month');
});

test('B-upcoming merge: de-duplicated, sorted overdue → today → upcoming → date → time → title; Cleaning / Maintenance via their own logic, faults excluded, no prefs / states', () => {
  const P = { id: 'pl1', title: 'AC service', deviceId: 'ac', priority: 'normal', recurrence: { kind: 'every', unit: 'month', interval: 1 }, firstDueDate: TODAY, completedCount: 0, lastDoneDate: null, active: true, rev: 1 };
  const home = homeCareItems({ maintenance: { plans: [P], faults: [{ id: 'f1', summary: 'Leak', status: 'open', severity: 'high', rev: 1 }] }, cleaning: null, today: TODAY, tz: 'UTC', uid: 'u1', can: () => true, isChild: false });
  assert.deepEqual(home.map((i) => [i.key, i.bucket, i.source]), [[`p:pl1@${TODAY}`, 'today', 'maintenancePlan']], 'faults have no date → not in Upcoming');
  const all = deriveUpcoming({ events: [E('b', { allDay: false, startTime: '09:00', endTime: '10:00' }), E('a', { allDay: false, startTime: '08:00', endTime: '09:00' }), E('t', { type: 'task', startDate: addDays(TODAY, -1), endDate: addDays(TODAY, -1) })],
    commitments: [CM('bill', { nextDueDate: addDays(TODAY, 2) })], homeCare: [...home, ...home], today: TODAY });
  assert.deepEqual(all.map((i) => i.id), ['t', `p:pl1@${TODAY}`, 'a', 'b', 'bill'].map((x) => x));
  assert.equal(new Set(all.map((i) => i.key)).size, all.length, 'no duplicates');
});

// --------------------------------------------------------------------------------------------- B3 reminders
test('B-rem due moment: offsets 0 / 15 / 60 / 1440; all-day = 09:00 Home time; crossing midnight', () => {
  assert.equal(reminderDueAt(E('x')), null, 'no reminder set');
  assert.equal(reminderDueAt(E('x', { allDay: false, startTime: '10:00', endTime: '11:00', reminderMinutes: 0 })), `${TODAY} 10:00`);
  assert.equal(reminderDueAt(E('x', { allDay: false, startTime: '10:00', endTime: '11:00', reminderMinutes: 15 })), `${TODAY} 09:45`);
  assert.equal(reminderDueAt(E('x', { allDay: false, startTime: '00:30', endTime: '01:00', reminderMinutes: 60 })), `${addDays(TODAY, -1)} 23:30`);
  assert.equal(reminderDueAt(E('x', { reminderMinutes: 0 })), `${TODAY} 09:00`, 'all-day reference 09:00');
  assert.equal(reminderDueAt(E('x', { reminderMinutes: 1440 })), `${addDays(TODAY, -1)} 09:00`);
  assert.equal(reminderDueAt(E('x', { allDay: false, startTime: '00:00', endTime: '01:00', startDate: '2026-03-01', endDate: '2026-03-01', reminderMinutes: 1440 })), '2026-02-28 00:00', 'month boundary');
});

test('B-rem eligibility: never before the moment; exactly at it; plain past events expire; open items stay overdue; done / cancelled never', () => {
  const ev = E('meet', { allDay: false, startTime: '10:00', endTime: '11:00', reminderMinutes: 15 });
  assert.equal(calendarReminders([ev], { today: TODAY, nowMin: 9 * 60 + 44 }).length, 0, '09:44 → not yet');
  const at = calendarReminders([ev], { today: TODAY, nowMin: 9 * 60 + 45 });
  assert.deepEqual(at.map((r) => [r.key, r.sourceKind, r.bucket, r.time]), [[`e:meet@${TODAY}`, 'calendarEvent', 'today', '10:00']]);
  const tomorrow = E('dayBefore', { startDate: addDays(TODAY, 1), endDate: addDays(TODAY, 1), reminderMinutes: 1440 });
  assert.deepEqual(calendarReminders([tomorrow], { today: TODAY, nowMin: 9 * 60 }).map((r) => r.bucket), ['upcoming'], '1 day before an all-day event: due today 09:00, event tomorrow');
  assert.equal(calendarReminders([E('past', { startDate: addDays(TODAY, -1), endDate: addDays(TODAY, -1), reminderMinutes: 0 })], { today: TODAY, nowMin: 600 }).length, 0, 'a plain past event no longer reminds');
  const task = E('task', { type: 'task', startDate: addDays(TODAY, -1), endDate: addDays(TODAY, -1), reminderMinutes: 0 });
  assert.deepEqual(calendarReminders([task], { today: TODAY, nowMin: 600 }).map((r) => r.bucket), ['overdue']);
  assert.equal(calendarReminders([{ ...task, done: true }, ACT('c', { status: 'cancelled', reminderMinutes: 0 }), ACT('d', { status: 'done', reminderMinutes: 0 }), E('del', { deletedAt: 'x', reminderMinutes: 0 })], { today: TODAY, nowMin: 900 }).length, 0);
  assert.deepEqual(calendarReminders([ACT('a1', { reminderMinutes: 60 })], { today: TODAY, nowMin: 8 * 60 })[0].kind, 'contactActivity');
  assert.equal(nextReminderAt([ev, tomorrow, E('none')], { today: TODAY, nowMin: 0 }), `${TODAY} 09:00`.replace('09:00', '09:00'));
  assert.equal(nextReminderAt([ev], { today: TODAY, nowMin: 9 * 60 + 45 }), null, 'already due → nothing to wait for');
  assert.deepEqual(commitmentReminders([CM('a', { nextDueDate: addDays(TODAY, 3) }), CM('b', { nextDueDate: addDays(TODAY, 4) })], { today: TODAY, lookAheadDays: 3 }).map((r) => r.key), [`m:a@${addDays(TODAY, 3)}`]);
});

test('B-rem feed integration: prefs toggles (old documents → on), sources null without permission, presentation state for e: / m:, cleaning / maintenance unchanged', () => {
  assert.deepEqual([prefsOf({ lookAheadDays: 7, cleaning: false, maintenancePlans: true, maintenanceFaults: true }).calendar, prefsOf(null).commitments], [true, true], 'older prefs docs: new sources on');
  assert.equal(prefsOf({ calendar: false }).calendar, false);
  const args = { today: TODAY, tz: 'UTC', uid: 'u1', can: () => true, isChild: false, nowMin: 12 * 60,
    events: [E('ev', { reminderMinutes: 0 })], commitments: [CM('bill')], cleaning: null, maintenance: null };
  assert.deepEqual(deriveReminders({ ...args, prefs: PREF_DEFAULTS }).map((r) => r.sourceKind).sort(), ['calendarEvent', 'commitment']);
  assert.deepEqual(deriveReminders({ ...args, prefs: { ...PREF_DEFAULTS, calendar: false } }).map((r) => r.sourceKind), ['commitment']);
  assert.deepEqual(deriveReminders({ ...args, prefs: { ...PREF_DEFAULTS, commitments: false } }).map((r) => r.sourceKind), ['calendarEvent']);
  assert.deepEqual(deriveReminders({ ...args, events: null, commitments: null, prefs: PREF_DEFAULTS }), [], 'no permission → no source at all');
  const items = deriveReminders({ ...args, prefs: PREF_DEFAULTS });
  const st = applyState(items, [{ key: `e:ev@${TODAY}`, state: 'dismissed' }, { key: `m:bill@${TODAY}`, state: 'snoozed', snoozeUntil: addDays(TODAY, 1) }], TODAY);
  assert.deepEqual(st.map((r) => [r.sourceKind, r.presentation]).sort(), [['calendarEvent', 'dismissed'], ['commitment', 'snoozed']]);
  assert.equal(applyState(items, [{ key: `m:bill@${TODAY}`, state: 'snoozed', snoozeUntil: TODAY }], TODAY).find((r) => r.sourceKind === 'commitment').presentation, 'unread', 'snooze ends on its date');
});

test('B-rem store: e: / m: keys get their own sourceKind (rules bind prefix ↔ kind); unknown prefixes refused locally; prefs write both toggles', async () => {
  const ops = []; const repo = { now: () => 'N', watchStates: (h, u, on) => { on([]); return () => {}; }, watchPrefs: (h, u, on) => { on(null); return () => {}; }, commit: async (h, o) => { ops.push(...o); } };
  const s = createRemindersStore({ homeId: 'H', uid: 'u1', repo });
  await s.mark(`e:ev1@${TODAY}`, 'dismissed'); await s.mark(`m:bill@${TODAY}`, 'snoozed', addDays(TODAY, 3));
  assert.deepEqual(ops.map((o) => [o.id, o.data.sourceKind, o.data.ownerUid]), [[stateDocId('u1', `e:ev1@${TODAY}`), 'calendarEvent', 'u1'], [stateDocId('u1', `m:bill@${TODAY}`), 'commitment', 'u1']]);
  await assert.rejects(s.mark('x:abc', 'read'), (e) => e.detail === 'reminders.err.key');
  await s.savePrefs({ ...PREF_DEFAULTS, calendar: false });
  assert.deepEqual([ops.at(-1).data.calendar, ops.at(-1).data.commitments], [false, true]);
  s.dispose();
});

// --------------------------------------------------------------------------------------------- time zones
test('B-tz: Home time zone drives today and the reminder clock (Cairo, UTC+14, UTC−11); midnight rollover', () => {
  const at = new Date('2026-11-21T22:30:00Z');
  assert.deepEqual([todayIn('Africa/Cairo', at), nowMinutesIn('Africa/Cairo', at)], ['2026-11-22', 30], 'Cairo is UTC+2 → 00:30 next day');
  assert.deepEqual([todayIn('Pacific/Kiritimati', at), nowMinutesIn('Pacific/Kiritimati', at)], ['2026-11-22', 12 * 60 + 30]);
  assert.deepEqual([todayIn('Pacific/Pago_Pago', at), nowMinutesIn('Pacific/Pago_Pago', at)], ['2026-11-21', 11 * 60 + 30]);
  const ev = E('n', { startDate: '2026-11-22', endDate: '2026-11-22' });
  assert.equal(calendarItems([ev], { today: todayIn('Africa/Cairo', at) })[0].bucket, 'today', 'in Cairo it is already the 22nd');
  assert.equal(calendarItems([ev], { today: todayIn('Pacific/Pago_Pago', at) })[0].bucket, 'upcoming');
  assert.equal(nowMinutesIn('UTC', new Date('2026-11-21T00:00:00Z')), 0);
});

// --------------------------------------------------------------------------------------------- hub / subscriptions
function fakeWorld({ perms = ['calendar.view', 'expenses.view', 'cleaning.view', 'maintenance.view'], homeId = 'H1', tz = 'UTC' } = {}) {
  let now = new Date(`${TODAY}T08:00:00Z`); const intervals = new Map(); let seq = 0; const focus = new Set();
  const clock = { now: () => now, setInterval: (f) => { intervals.set(++seq, f); return seq; }, clearInterval: (id) => intervals.delete(id), onFocus: (f) => { focus.add(f); return () => focus.delete(f); } };
  const mk = (snap) => { const subs = new Set(); let s = snap; return { subs, getSnapshot: () => s, subscribe: (fn) => { subs.add(fn); fn(s); return () => subs.delete(fn); }, set(x) { s = { ...s, ...x }; for (const f of subs) f(s); }, watchDevices() {} }; };
  const stores = { calendar: mk({ status: 'ready', events: [] }), finance: mk({ status: 'ready', commitments: [] }), cleaning: mk({ status: 'ready', tasks: [], occurrences: [], deviceEvents: [], deviceStates: new Map() }),
    maintenance: mk({ status: 'ready', plans: [], faults: [] }), devices: mk({ status: 'ready', devices: [] }), rooms: mk({ status: 'ready', rooms: [] }) };
  const opened = []; const getters = Object.fromEntries(Object.keys(stores).map((k) => [k, () => { opened.push(k); return stores[k]; }]));
  const permissions = { can: (p) => perms.includes(p) };
  const ctx = { getState: () => ({ home: { id: homeId, timezone: tz }, identity: { uid: 'u1' }, permissions, membership: { roleId: 'member' } }) };
  return { ctx, clock, stores, getters, opened, intervals, focus, flags: sourceFlags(permissions), setNow: (d) => { now = d; } };
}

test('B-hub: one clock + one subscription per store for ALL consumers; released when the last one leaves; Home switch disposal leaves nothing', () => {
  const w = fakeWorld(); const hub = createSources(w.ctx, w.flags, w.clock, w.getters);
  assert.equal(w.intervals.size, 0, 'no clock before a consumer');
  const seen1 = []; const seen2 = [];
  const off1 = hub.subscribe((s) => seen1.push(s.status)); const off2 = hub.subscribe((s) => seen2.push(s.status));
  assert.equal(w.intervals.size, 1, 'ONE interval for bell + page + panel'); assert.equal(w.focus.size, 1);
  for (const k of ['calendar', 'finance', 'cleaning', 'maintenance']) assert.equal(w.stores[k].subs.size, 1, `${k}: one subscription`);
  assert.equal(seen1.at(-1), 'ready'); assert.equal(seen2.at(-1), 'ready');
  off1(); assert.equal(w.intervals.size, 1);
  off2(); assert.equal(w.intervals.size, 0, 'last consumer gone → clock stopped'); assert.equal(w.focus.size, 0);
  for (const k of Object.keys(w.stores)) assert.equal(w.stores[k].subs.size, 0, `${k}: unsubscribed`);
  hub.subscribe(() => {}); hub.dispose();
  assert.deepEqual([w.intervals.size, w.focus.size, ...Object.values(w.stores).map((s) => s.subs.size)], [0, 0, 0, 0, 0, 0, 0, 0], 'Home switch / sign-out: nothing survives');
  assert.throws(() => hub.subscribe(() => {}));
});

test('B-hub: permissions decide the sources (no store opened without its view permission); error / loading states propagate', () => {
  const w = fakeWorld({ perms: ['calendar.view'] }); const hub = createSources(w.ctx, w.flags, w.clock, w.getters);
  let last; const off = hub.subscribe((s) => { last = s; });
  assert.deepEqual(w.opened, ['calendar'], 'Finance / Cleaning / Maintenance never opened');
  assert.deepEqual([last.commitments, last.cleaning, last.maintenance, last.sources.finance], [null, null, null, false]);
  w.stores.calendar.set({ status: 'loading' }); assert.equal(last.status, 'loading');
  w.stores.calendar.set({ status: 'error' }); assert.equal(last.status, 'error');
  off();
  assert.equal(canSeeReminders({ can: () => false }), false); assert.equal(canSeeReminders({ can: (p) => p === 'expenses.view' }), true);
});

test('B-hub clock: recomputes at the Home midnight and when the next reminder moment passes — not every minute', () => {
  const w = fakeWorld({ tz: 'Africa/Cairo' }); const hub = createSources(w.ctx, w.flags, w.clock, w.getters);
  w.setNow(new Date('2026-11-21T06:00:00Z'));   // 08:00 Cairo
  w.stores.calendar.set({ events: [E('m', { allDay: false, startTime: '10:00', endTime: '11:00', reminderMinutes: 15 })] });
  let n = 0; let last; const off = hub.subscribe((s) => { n++; last = s; });
  assert.equal(last.nextReminderAt, '2026-11-21 09:45');
  const tick = [...w.intervals.values()][0]; const base = n;
  w.setNow(new Date('2026-11-21T07:00:00Z')); tick(); assert.equal(n, base, '09:00: nothing changed → no recompute');
  w.setNow(new Date('2026-11-21T07:45:00Z')); tick(); assert.equal(n, base + 1, '09:45: reminder moment → recompute');
  assert.equal(last.nextReminderAt, null);
  w.setNow(new Date('2026-11-21T22:01:00Z')); tick(); assert.equal(last.today, '2026-11-22', 'Cairo midnight rollover');
  for (const f of w.focus) f(); assert.equal(last.today, '2026-11-22');
  off();
});

// --------------------------------------------------------------------------------------------- navigation intents, i18n, rules text
test('B-nav: read-once, Home-scoped intents (another Home never consumes them; invalid ids refused)', () => {
  setContactsFocus({ homeId: 'H1', contactId: 'contact01' }); assert.equal(takeContactsFocus('H2'), null); assert.equal(takeContactsFocus('H1'), null, 'consumed by the wrong Home → gone');
  setContactsFocus({ homeId: 'H1', contactId: 'contact01' }); assert.deepEqual(takeContactsFocus('H1'), { homeId: 'H1', contactId: 'contact01' }); assert.equal(takeContactsFocus('H1'), null);
  setContactsFocus({ homeId: 'H1', contactId: '<script>' }); assert.equal(takeContactsFocus('H1'), null);
  setCalendarFocus({ homeId: 'H1', date: TODAY, eventId: 'e1' }); assert.equal(takeCalendarFocus('H1').date, TODAY);
  setFinanceFocus({ homeId: 'H1', tab: 'commitments' }); assert.equal(takeFinanceFocus('H9'), null);
});

test('B-i18n: every Stage B key (incl. dynamic ones) exists in English AND Arabic', () => {
  const keys = ['calendar.status.planned', 'calendar.status.done', 'calendar.status.cancelled', ...[0, 15, 60, 1440].map((m) => `calendar.rem.m${m}`), 'calendar.rem.none',
    ...['overdue', 'today', 'upcoming'].map((b) => `upcoming.group.${b}`), ...['contactActivity', 'commitment', 'cleaning', 'maintenancePlan'].map((s) => `upcoming.src.${s}`),
    'reminders.kind.calendarEvent', 'reminders.kind.commitment', 'reminders.kind.contactActivity', 'reminders.filter.calendar', 'reminders.filter.bills', 'calendar.newActivity', 'calendar.editActivity'];
  for (const k of keys) { assert.ok(en[k], `en ${k}`); assert.ok(ar[k], `ar ${k}`); assert.notEqual(en[k], ar[k], `ar ${k} translated`); }
  assert.match(ar['upcoming.group.upcoming'], /\{n\}/);
});

test('B-rules (text): calendar fields optional + validated; reminder prefixes bound to kinds; prefs accept old and new shapes', () => {
  const r = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
  assert.match(r, /function calLinkOk\(d\)/); assert.match(r, /d\.get\('reminderMinutes', null\) in \[null, 0, 15, 60, 1440\]/);
  assert.match(r, /d\.status in \['planned', 'done', 'cancelled'\]/); assert.ok(!/exists\([^)]*contacts/.test(r.slice(r.indexOf('function calLinkOk'), r.indexOf('function calMine'))), 'no contact read per write');
  assert.match(r, /incoming\(\)\.sourceKind == 'calendarEvent' \? incoming\(\)\.key\.matches\('\^e:\.\*'\)/);
  assert.match(r, /incoming\(\)\.sourceKind == 'commitment' && incoming\(\)\.key\.matches\('\^m:\.\*'\)/);
  assert.match(r, /'quietEnd', 'updatedAt', 'schemaVersion', 'calendar', 'commitments'\]\)/);
});
