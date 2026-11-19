import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_CATEGORIES } from '../../src/modules/devices/device-model.js';
import { validRecurrence, nextDue, planStatus, validatePlan, planEditPatch, planArchivePatch, buildCompletion, completionId, validateService,
  validateFault, allowedTransitions, buildTransition, TRANSITIONS, totalsByCurrency } from '../../src/modules/maintenance/maintenance-model.js';
import { maintenanceSuggestionsFor, CATEGORY_MAINTENANCE, SUBTYPE_MAINTENANCE } from '../../src/modules/maintenance/maintenance-catalog.js';
import { createMaintenanceStore } from '../../src/modules/maintenance/maintenance-store.js';
import { setMaintenanceFocus, takeMaintenanceFocus } from '../../src/modules/maintenance/maintenance-focus.js';

const P = (extra = {}) => ({ id: 'plan01', title: 'Service', deviceId: 'ac1', priority: 'normal', recurrence: { kind: 'every', unit: 'month', interval: 6 }, firstDueDate: '2026-01-31', completedCount: 0, lastDoneDate: null, active: true, rev: 1, ...extra });

test('recurrence: once / every N days, weeks, months AFTER the last completion; month-end clamp; status', () => {
  for (const r of [{ kind: 'once' }, { kind: 'every', unit: 'day', interval: 365 }, { kind: 'every', unit: 'week', interval: 52 }, { kind: 'every', unit: 'month', interval: 24 }]) assert.ok(validRecurrence(r), JSON.stringify(r));
  for (const r of [{ kind: 'once', unit: 'day' }, { kind: 'every', unit: 'day', interval: 0 }, { kind: 'every', unit: 'month', interval: 25 }, { kind: 'every', unit: 'year', interval: 1 }, { kind: 'every', unit: 'day', interval: 1.5 }]) assert.ok(!validRecurrence(r), JSON.stringify(r));
  assert.equal(nextDue(P()), '2026-01-31', 'no completion yet → first due date');
  assert.equal(nextDue(P({ lastDoneDate: '2026-08-31', completedCount: 1, recurrence: { kind: 'every', unit: 'month', interval: 6 } })), '2027-02-28', 'clamped to the month end');
  assert.equal(nextDue(P({ lastDoneDate: '2026-10-01', completedCount: 3, recurrence: { kind: 'every', unit: 'week', interval: 2 } })), '2026-10-15');
  assert.equal(nextDue(P({ recurrence: { kind: 'once' }, completedCount: 1 })), null);
  assert.equal(planStatus(P({ recurrence: { kind: 'once' }, completedCount: 1 }), '2026-10-18'), 'completed');
  assert.equal(planStatus(P(), '2026-10-18'), 'overdue'); assert.equal(planStatus(P({ firstDueDate: '2026-10-18' }), '2026-10-18'), 'dueToday');
  assert.equal(planStatus(P({ firstDueDate: '2026-11-01' }), '2026-10-18'), 'upcoming'); assert.equal(planStatus(P({ active: false }), '2026-10-18'), 'archived');
});

test('plan validation and edits: members only; deviceId never editable; rev + 1; archive patch', () => {
  const base = { title: 'Service', deviceId: 'ac1', recurrence: { kind: 'every', unit: 'month', interval: 12 }, firstDueDate: '2026-11-01' };
  assert.deepEqual(validatePlan(base).errors, {});
  assert.equal(validatePlan({ ...base, assigneeUid: 'stranger' }, { memberUids: ['u1'] }).errors.assigneeUid, 'maintenance.err.assignee');
  assert.equal(validatePlan({ ...base, deviceId: 'bad/id' }).errors.deviceId, 'maintenance.err.device');
  assert.equal(validatePlan({ ...base, estimatedMinutes: 1441 }).errors.estimatedMinutes, 'maintenance.err.minutes');
  assert.equal(validatePlan({ ...base, title: ' ' }).errors.title, 'maintenance.err.required');
  const cur = P({ rev: 4 });
  const patch = planEditPatch(cur, { ...validatePlan({ ...cur, title: 'New', deviceId: 'OTHER' }).value }, { uid: 'u', now: 'N' });
  assert.deepEqual(Object.keys(patch).sort(), ['rev', 'title', 'updatedAt', 'updatedBy']); assert.equal(patch.rev, 5);
  assert.equal(planEditPatch(cur, validatePlan(cur).value, { uid: 'u', now: 'N' }), null, 'no change → no write');
  assert.deepEqual(planArchivePatch(cur, true, { uid: 'u', now: 'N' }), { active: false, archivedAt: 'N', archivedBy: 'u', rev: 5, updatedBy: 'u', updatedAt: 'N' });
});

test('completion: deterministic <planId>_c<n>; one-time plans once; archived refused', () => {
  const svc = validateService({ serviceDate: '2026-10-18', workPerformed: 'Filter replaced', costMinor: 45000, currency: 'egp' }, { today: '2026-10-18', homeCurrency: 'EGP' }).value;
  const b = buildCompletion(P({ completedCount: 2, rev: 7 }), svc, { uid: 'u', now: 'N' });
  assert.deepEqual([b.id, b.planPatch.completedCount, b.planPatch.lastDoneDate, b.planPatch.rev, b.record.kind, b.record.planId, b.record.currency, b.record.costMinor], ['plan01_c3', 3, '2026-10-18', 8, 'preventive', 'plan01', 'EGP', 45000]);
  assert.equal(completionId('plan01', 3), b.id);
  assert.throws(() => buildCompletion(P({ recurrence: { kind: 'once' }, completedCount: 1 }), svc, { uid: 'u', now: 'N' }), (e) => e.detail === 'maintenance.err.alreadyDone');
  assert.throws(() => buildCompletion(P({ active: false }), svc, { uid: 'u', now: 'N' }), (e) => e.detail === 'maintenance.err.archived');
});

test('costs: integer minor units, currency with cost, date bounds; totals per currency (estimates and superseded records excluded)', () => {
  const V = (x) => validateService(x, { today: '2026-10-18', homeCurrency: 'EGP' });
  assert.deepEqual(V({}).value, { serviceDate: '2026-10-18', workPerformed: null, provider: null, parts: null, notes: null, costMinor: null, currency: null });
  assert.equal(V({ costMinor: -1 }).errors.cost, 'maintenance.err.cost'); assert.equal(V({ costMinor: 1.5 }).errors.cost, 'maintenance.err.cost');
  assert.equal(V({ costMinor: 100, currency: 'EURO' }).errors.currency, 'maintenance.err.currency');
  assert.equal(V({ costMinor: 100 }).value.currency, 'EGP', 'defaults to the Home currency');
  assert.equal(V({ serviceDate: '2026-10-21' }).errors.serviceDate, 'maintenance.err.serviceDate', 'not in the future');
  assert.equal(V({ serviceDate: '2022-01-01' }).errors.serviceDate, 'maintenance.err.serviceDate', 'within 3 years');
  assert.deepEqual(totalsByCurrency([{ costMinor: 100, currency: 'EGP' }, { costMinor: 250, currency: 'EGP' }, { costMinor: 10, currency: 'USD' }, { costMinor: null, currency: null }, { estimateMinor: 999, estimateCurrency: 'EGP' }]), { EGP: 350, USD: 10 });
});

test('fault state machine: allowed transitions by permission; closed final; fields set / cleared; repair record only on resolve', () => {
  const can = (set) => (p) => set.includes(p);
  const F = (status, extra = {}) => ({ id: 'f1', deviceId: 'ac1', status, rev: 3, ...extra });
  assert.deepEqual(allowedTransitions(F('open'), can(['maintenance.complete'])), ['inProgress']);
  assert.deepEqual(allowedTransitions(F('open'), can(['maintenance.complete', 'maintenance.edit'])).sort(), ['cancelled', 'inProgress']);
  assert.deepEqual(allowedTransitions(F('resolved'), can(['maintenance.edit'])).sort(), ['closed', 'inProgress']);
  assert.deepEqual(allowedTransitions(F('closed'), () => true), [], 'closed is final');
  assert.deepEqual(allowedTransitions(F('open'), can(['maintenance.view'])), [], 'viewer: nothing');
  assert.throws(() => buildTransition(F('open'), 'resolved', { uid: 'u', now: 'N' }), (e) => e.detail === 'maintenance.err.transition');
  assert.throws(() => buildTransition(F('closed'), 'open', { uid: 'u', now: 'N' }), (e) => e.detail === 'maintenance.err.transition');
  const svc = { serviceDate: '2026-10-18', workPerformed: 'Replaced capacitor', provider: 'CoolFix', parts: 'capacitor', notes: null, costMinor: 80000, currency: 'EGP' };
  const r = buildTransition(F('inProgress'), 'resolved', { uid: 'u', now: 'N', note: 'done', service: svc });
  assert.deepEqual([r.patch.status, r.patch.rev, r.patch.resolvedAt, r.patch.resolvedBy, r.event.id, r.event.data.fromStatus, r.event.data.toStatus, r.record.id, r.record.data.kind, r.record.data.faultId], ['resolved', 4, 'N', 'u', 'f1_r4', 'inProgress', 'resolved', 'f1_r4', 'repair', 'f1']);
  assert.deepEqual([buildTransition(F('resolved'), 'inProgress', { uid: 'u', now: 'N' }).patch.resolvedAt, buildTransition(F('resolved'), 'closed', { uid: 'u', now: 'N' }).patch.closedBy], [null, 'u']);
  assert.equal(buildTransition(F('inProgress'), 'open', { uid: 'u', now: 'N', service: svc }).record, null, 'only resolve writes a repair record');
  assert.equal(Object.keys(TRANSITIONS).length, 8);
  assert.equal(validateFault({ summary: 'Leak', deviceId: 'ac1', estimateMinor: 500 }, { homeCurrency: 'EGP' }).value.estimateCurrency, 'EGP');
});

test('catalog: every Add Device category / subtype (incl. null) has valid suggestions; hazards are professional-only; no DIY gas / refrigerant', () => {
  const combos = Object.entries(DEVICE_CATEGORIES).flatMap(([c, v]) => [...v.subtypes, null].map((s) => ({ category: c, subtype: s })));
  assert.equal(combos.length, 104);
  for (const d of combos) { const s = maintenanceSuggestionsFor(d); assert.ok(s.length >= 1, `${d.category}/${d.subtype}`); for (const x of s) assert.ok(validRecurrence(x.recurrence), x.key); }
  assert.deepEqual(Object.keys(CATEGORY_MAINTENANCE).sort(), Object.keys(DEVICE_CATEGORIES).sort());
  for (const k of Object.keys(SUBTYPE_MAINTENANCE)) assert.ok(Object.values(DEVICE_CATEGORIES).some((v) => v.subtypes.includes(k)), k);
  for (const sub of ['cooker', 'oven', 'grill', 'water_heater', 'generator', 'solar_panel', 'battery_bank', 'inverter', 'ups', 'central_ac', 'split_ac']) {
    const cat = Object.entries(DEVICE_CATEGORIES).find(([, v]) => v.subtypes.includes(sub))[0];
    assert.ok(maintenanceSuggestionsFor({ category: cat, subtype: sub }).some((x) => x.pro), `${sub}: professional item`);
  }
  for (const list of [...Object.values(CATEGORY_MAINTENANCE), ...Object.values(SUBTYPE_MAINTENANCE)]) for (const x of list) {
    if (!x.pro) assert.ok(!/gas|refrigerant|غاز|فريون|panel wiring/i.test(`${x.titleEn} ${x.titleAr}`), `user-level item must not be gas / refrigerant work: ${x.key}`);
    assert.ok(x.titleEn.length <= 120 && x.titleAr.length <= 120);
  }
  assert.ok(maintenanceSuggestionsFor({ category: 'electrical', subtype: 'other' }).some((x) => x.pro), 'electrical category: professional inspection');
});

function fakeRepo() {
  const data = new Map(); const ws = new Set(); let w = 0; let n = 0;
  const list = (p) => [...data.entries()].filter(([k]) => k.startsWith(p)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  const watch = (p, on) => { const fn = () => on(list(p)); ws.add(fn); w++; queueMicrotask(fn); return () => { ws.delete(fn); w--; }; };
  return { data, get watchers() { return w; }, now: () => 'N', newId: () => `id${String(++n).padStart(6, '0')}`,
    watchPlans: (h, on) => watch('maintenancePlans/', on), watchFaults: (h, on) => watch('maintenanceFaults/', on), watchRecords: (h, on) => watch('maintenanceRecords/', on),
    readRecord: async (h, id) => (data.has(`maintenanceRecords/${id}`) ? { id, ...data.get(`maintenanceRecords/${id}`) } : null),
    readFaultEvents: async (h, f) => list('maintenanceFaultEvents/').filter((e) => e.faultId === f),
    async commit(h, ops) {
      await new Promise((r) => setTimeout(r, 1));
      for (const o of ops) { const k = `${o.name}/${o.id}`;
        if (o.mode === 'set' && data.has(k)) throw Object.assign(new Error('exists'), { code: 'permission-denied' });
        if (o.mode === 'update' && (!data.has(k) || o.data.rev !== data.get(k).rev + 1)) throw Object.assign(new Error('stale'), { code: 'permission-denied' }); }
      for (const o of ops) { const k = `${o.name}/${o.id}`; data.set(k, o.mode === 'set' ? { ...o.data } : { ...data.get(k), ...o.data }); }
      for (const fn of ws) fn();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const mk = (repo, uid) => { const s = createMaintenanceStore({ homeId: 'H', uid, repo, today: () => '2026-10-18', homeCurrency: 'EGP' }); s.ensure({ canView: true }); s.subscribe(() => {}); return s; };

test('store: listeners on demand; two members completing at once → ONE record; my retry → "existing"; stale edit refused; faults audited', async () => {
  const repo = fakeRepo();
  const a = mk(repo, 'ua'); const b = mk(repo, 'ub'); await tick();
  assert.equal(a.listenerCount(), 3);
  const id = await a.createPlan({ title: 'AC service', deviceId: 'ac1', recurrence: { kind: 'every', unit: 'month', interval: 12 }, firstDueDate: '2026-10-18' }, { memberUids: ['ua', 'ub'] });
  await tick();
  const [ra, rb] = await Promise.allSettled([a.completePlan(id, { costMinor: 50000 }), b.completePlan(id, { costMinor: 50000 })]);
  assert.equal(ra.status, 'fulfilled'); assert.equal(rb.status, 'rejected'); assert.equal(rb.reason.detail, 'maintenance.err.alreadyCompleted');
  assert.equal([...repo.data.keys()].filter((k) => k.startsWith('maintenanceRecords/')).length, 1, 'one record, one cost');
  assert.equal(repo.data.get(`maintenancePlans/${id}`).completedCount, 1);
  // My own retry of a save that already succeeded (stale local snapshot) → recognised, nothing duplicated.
  const c = createMaintenanceStore({ homeId: 'H', uid: 'ua', repo, today: () => '2026-10-18', homeCurrency: 'EGP' });
  c.ensure({ canView: true }); c.subscribe(() => {}); await tick();
  repo.data.set(`maintenancePlans/${id}`, { ...repo.data.get(`maintenancePlans/${id}`), completedCount: 0, rev: 1 });   // simulate c's stale view…
  await repo.commit('H', []); await tick();
  repo.data.set(`maintenancePlans/${id}`, { ...repo.data.get(`maintenancePlans/${id}`), completedCount: 1, rev: 2 });   // …while the server already holds my save
  assert.equal(await c.completePlan(id, {}), 'existing');
  assert.equal([...repo.data.keys()].filter((k) => k.startsWith('maintenanceRecords/')).length, 1);
  // Stale edit → conflict, not an overwrite.
  await repo.commit('H', []); await tick();   // re-sync every view with the server after the simulation above
  await a.editPlan(id, { title: 'AC service (yearly)' }, { memberUids: ['ua'] }); await tick();
  repo.data.set(`maintenancePlans/${id}`, { ...repo.data.get(`maintenancePlans/${id}`), rev: 9 });
  await assert.rejects(b.editPlan(id, { title: 'Mine' }, { memberUids: ['ub'] }), (e) => e.detail === 'maintenance.err.conflict');
  // Faults: creation writes event r1; transitions are audited and rev-checked; invalid ones refused before writing.
  const fid = await a.reportFault({ summary: 'Leaking water', deviceId: 'ac1', severity: 'high' }, { memberUids: ['ua'] }); await tick();
  assert.ok(repo.data.has(`maintenanceFaultEvents/${fid}_r1`));
  await assert.rejects(a.transitionFault(fid, 'closed'), (e) => /transition/.test(e.message + e.detail));
  await a.transitionFault(fid, 'inProgress', { note: 'Technician booked' }); await tick();
  await a.transitionFault(fid, 'resolved', { fields: { resolution: 'Drain unblocked' }, service: { costMinor: 30000, provider: 'CoolFix' } }); await tick();
  assert.deepEqual([repo.data.get(`maintenanceFaults/${fid}`).status, repo.data.has(`maintenanceFaultEvents/${fid}_r3`), repo.data.get(`maintenanceRecords/${fid}_r3`).costMinor], ['resolved', true, 30000]);
  a.dispose(); b.dispose(); c.dispose(); assert.equal(repo.watchers, 0, 'all listeners disposed');
});

test('store: invalid input surfaces PER-FIELD errors (regression: AppError used to drop them)', async () => {
  const s = createMaintenanceStore({ homeId: 'H', uid: 'u', repo: fakeRepo(), today: () => '2026-10-18', homeCurrency: 'EGP' });
  await assert.rejects(s.createPlan({ title: '', deviceId: 'bad/id', recurrence: { kind: 'every', unit: 'day', interval: 0 }, firstDueDate: 'x' }, { memberUids: [] }),
    (e) => !!(e.fields && e.fields.title === 'maintenance.err.required' && e.fields.deviceId === 'maintenance.err.device' && e.fields.recurrence && e.fields.firstDueDate));
});

test('focus: Home-scoped and read-once', () => {
  setMaintenanceFocus({ homeId: 'hA', deviceId: 'd1', open: 'fault' });
  assert.equal(takeMaintenanceFocus('hB'), null); assert.equal(takeMaintenanceFocus('hA'), null, 'consumed');
  setMaintenanceFocus({ homeId: 'hA', deviceId: 'd1', open: 'bogus' });
  assert.deepEqual(takeMaintenanceFocus('hA'), { homeId: 'hA', deviceId: 'd1', open: null, preset: null });
});
