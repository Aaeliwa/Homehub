/**
 * Maintenance store (Phase 5.5): one listener per collection per Home (plans, faults, records),
 * started on demand and disposed with the Home scope. Every write is awaited (server-confirmed).
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { MCOL } from './maintenance-collections.js';
import { validatePlan, planCreateDoc, planEditPatch, planArchivePatch, validateService, buildCompletion, buildCorrection,
  validateFault, faultCreateDoc, buildTransition, FAULT_EDITABLE, faultEventId } from './maintenance-model.js';

// AppError keeps only {cause, detail}: attach the per-field errors explicitly so forms can show them.
const fail = (detail, fields) => Object.assign(new AppError(ErrorCode.VALIDATION, { detail }), fields ? { fields } : {});
const denied = (e) => e && (e.code === 'permission-denied' || e.code === ErrorCode.PERMISSION_DENIED);

export function createMaintenanceStore({ homeId, uid, repo, today, homeCurrency }) {
  let plans = []; let faults = []; let records = []; const st = {}; let lastError = null; let disposed = false;
  const stops = []; const subs = new Set(); let cache = null;
  const emit = () => { cache = null; for (const fn of subs) fn(snapshot()); };
  function snapshot() {
    if (cache) return cache;
    const s = Object.values(st);
    cache = Object.freeze({ status: !s.length ? 'idle' : s.includes('error') ? 'error' : s.every((x) => x === 'ready') ? 'ready' : 'loading', error: lastError, plans, faults, records });
    return cache;
  }
  const guard = () => { if (disposed) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE); };
  const plan = (id) => plans.find((p) => p.id === id) || null;
  const fault = (id) => faults.find((f) => f.id === id) || null;
  const watch = (key, fn) => { st[key] = 'loading'; stops.push(fn((d) => { if (key === 'p') plans = d; if (key === 'f') faults = d; if (key === 'r') records = d; st[key] = 'ready'; emit(); }, (e) => { st[key] = 'error'; lastError = e; emit(); })); };
  const throwFields = (errors) => { if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','), errors); };

  const api = {
    ensure({ canView }) {
      guard();
      if (!canView || stops.length) return;
      watch('p', (on, er) => repo.watchPlans(homeId, on, er));
      watch('f', (on, er) => repo.watchFaults(homeId, on, er));
      watch('r', (on, er) => repo.watchRecords(homeId, on, er));
    },
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    getSnapshot: snapshot, plan, fault,
    listenerCount: () => stops.length,
    now: () => repo.now(),

    // ---- preventive plans
    async createPlan(input, { memberUids }) {
      guard();
      const { value, errors } = validatePlan(input, { memberUids }); throwFields(errors);
      const id = repo.newId(homeId, MCOL.plans);
      await repo.commit(homeId, [{ mode: 'set', name: MCOL.plans, id, data: planCreateDoc(value, { uid, now: repo.now() }) }]);
      return id;
    },
    async editPlan(id, input, { memberUids }) {
      guard();
      const cur = plan(id); if (!cur) throw fail('maintenance.err.notFound');
      const { value, errors } = validatePlan({ ...cur, ...input, deviceId: cur.deviceId }, { memberUids: [...memberUids, ...(cur.assigneeUid ? [cur.assigneeUid] : [])] }); throwFields(errors);
      const patch = planEditPatch(cur, value, { uid, now: repo.now() }); if (!patch) return;
      try { await repo.commit(homeId, [{ mode: 'update', name: MCOL.plans, id, data: patch }]); }
      catch (e) { if (denied(e)) throw fail('maintenance.err.conflict'); throw e; }
    },
    async archivePlan(id, archive) {
      guard();
      const cur = plan(id); if (!cur) throw fail('maintenance.err.notFound');
      try { await repo.commit(homeId, [{ mode: 'update', name: MCOL.plans, id, data: planArchivePatch(cur, archive, { uid, now: repo.now() }) }]); }
      catch (e) { if (denied(e)) throw fail('maintenance.err.conflict'); throw e; }
    },
    /**
     * Complete a plan ONCE: record <planId>_c<n> + plan {completedCount n, lastDoneDate, rev+1}, one batch.
     * Refused → server read: my record → it was a retry that already succeeded ('existing');
     * someone else's → 'maintenance.err.alreadyCompleted'. Never double-counted.
     */
    async completePlan(id, serviceInput) {
      guard();
      const cur = plan(id); if (!cur) throw fail('maintenance.err.notFound');
      const { value, errors } = validateService(serviceInput, { today: today(), homeCurrency }); throwFields(errors);
      const b = buildCompletion(cur, value, { uid, now: repo.now() });
      try {
        await repo.commit(homeId, [{ mode: 'set', name: MCOL.records, id: b.id, data: b.record }, { mode: 'update', name: MCOL.plans, id, data: b.planPatch }]);
        return 'created';
      } catch (e) {
        if (!denied(e)) throw e;
        let existing = null; try { existing = await repo.readRecord(homeId, b.id); } catch { existing = null; }
        if (existing && existing.actorUid === uid) return 'existing';
        if (existing) throw fail('maintenance.err.alreadyCompleted');
        throw fail('maintenance.err.conflict');
      }
    },
    /** A correction is a NEW immutable record (<recordId>_fix<n>); history is never rewritten. */
    async addCorrection(recordId, serviceInput) {
      guard();
      const orig = records.find((r) => r.id === recordId); if (!orig) throw fail('maintenance.err.notFound');
      const { value, errors } = validateService(serviceInput, { today: today(), homeCurrency }); throwFields(errors);
      const n = records.filter((r) => r.correctsRecordId === recordId).length + 1;
      const b = buildCorrection(orig, value, { uid, now: repo.now(), id: `${recordId}_fix${n}` });
      try { await repo.commit(homeId, [{ mode: 'set', name: MCOL.records, id: b.id, data: b.record }]); }
      catch (e) { if (denied(e)) throw fail('maintenance.err.conflict'); throw e; }
    },

    // ---- faults
    async reportFault(input, { memberUids }) {
      guard();
      const { value, errors } = validateFault(input, { memberUids, homeCurrency }); throwFields(errors);
      const id = repo.newId(homeId, MCOL.faults); const now = repo.now();
      await repo.commit(homeId, [
        { mode: 'set', name: MCOL.faults, id, data: faultCreateDoc(value, { uid, now }) },
        { mode: 'set', name: MCOL.events, id: faultEventId(id, 1), data: { faultId: id, rev: 1, fromStatus: null, toStatus: 'open', note: null, actorUid: uid, at: now, schemaVersion: 1 } }]);
      return id;
    },
    /** Status transition and/or field edit: fault rev+1 + event <faultId>_r<rev> [+ repair record], one batch. */
    async transitionFault(id, to, { note = null, fields = {}, service = null, memberUids = [] } = {}) {
      guard();
      const cur = fault(id); if (!cur) throw fail('maintenance.err.notFound');
      let cleanFields = {};
      if (Object.keys(fields).length) {
        const { value, errors } = validateFault({ ...cur, ...fields }, { memberUids: [...memberUids, ...(cur.assigneeUid ? [cur.assigneeUid] : [])], homeCurrency }); throwFields(errors);
        for (const k of FAULT_EDITABLE) if (k in fields && JSON.stringify(cur[k] ?? null) !== JSON.stringify(value[k] ?? null)) cleanFields[k] = value[k] ?? null;
      }
      let svc = null;
      if (service) { const v = validateService(service, { today: today(), homeCurrency }); throwFields(v.errors); svc = v.value; }
      const b = buildTransition(cur, to, { uid, now: repo.now(), note, fields: cleanFields, service: svc });
      const ops = [{ mode: 'update', name: MCOL.faults, id, data: b.patch }, { mode: 'set', name: MCOL.events, id: b.event.id, data: b.event.data }];
      if (b.record) ops.push({ mode: 'set', name: MCOL.records, id: b.record.id, data: b.record.data });
      try { await repo.commit(homeId, ops); }
      catch (e) { if (denied(e)) throw fail('maintenance.err.conflict'); throw e; }
    },
    faultEvents: (faultId) => repo.readFaultEvents(homeId, faultId),

    dispose() { disposed = true; for (const s of stops) s(); stops.length = 0; subs.clear(); },
  };
  return api;
}
