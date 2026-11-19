/**
 * Calendar store (V6.2): ONE Home-scoped store (household events + my private events), shared by the
 * Calendar page, the dashboard widget and Finance's work/vacation filter. Confirmed writes only.
 * Delete = soft delete (deletedAt): a vacation used by a Finance filter simply stops matching; the
 * ledger is never rewritten. CSV import = create-only deterministic ids → re-import never duplicates.
 */
import { validateEvent, createDoc, editPatch, isLive, intervals, batchDoc, removalPlan, reviveDoc, ungroupedImports, batchMembers, REMOVE_CHUNK } from './calendar-model.js';

const IMPORTS = 'calendarImports';
const ms = (x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : typeof x === 'string' ? Date.parse(x) || 0 : 0);

const fail = (detail, fields) => Object.assign(new Error(detail), { code: 'validation', detail, fields });
const denied = (e) => e && (e.code === 'permission-denied' || e.code === 'PERMISSION_DENIED');

export function createCalendarStore({ homeId, uid, timezone, repo }) {
  let hh = []; let mine = []; const st = { h: 'loading', m: 'loading' }; let lastError = null; let cache = null;
  // V6.2.1 import batches: separate, NON-fatal listeners (a failure never hides the calendar itself).
  let bh = []; let bm = []; const bst = { h: 'loading', m: 'loading' }; let batchError = null;
  const subs = new Set(); const stops = []; let disposed = false;
  const emit = () => { cache = null; for (const fn of subs) fn(snapshot()); };
  function snapshot() {
    if (cache) return cache;
    const byId = new Map(); for (const e of [...hh, ...mine]) byId.set(e.id, e);
    const all = [...byId.values()];
    const s = Object.values(st);
    const bById = new Map(); for (const b of [...bh, ...bm]) bById.set(b.id, b);
    const bs = Object.values(bst);
    cache = Object.freeze({ status: s.includes('error') ? 'error' : s.every((x) => x === 'ready') ? 'ready' : 'loading', error: lastError,
      all, events: all.filter(isLive),
      batches: [...bById.values()].sort((a, b) => ms(b.createdAt) - ms(a.createdAt) || String(b.id).localeCompare(String(a.id))),
      batchStatus: bs.includes('error') ? 'error' : bs.every((x) => x === 'ready') ? 'ready' : 'loading', batchError,
      ungrouped: ungroupedImports(all) });
    return cache;
  }
  stops.push(repo.watchHousehold(homeId, (d) => { hh = d; st.h = 'ready'; emit(); }, (e) => { st.h = 'error'; lastError = e; emit(); }));
  stops.push(repo.watchMine(homeId, uid, (d) => { mine = d; st.m = 'ready'; emit(); }, (e) => { st.m = 'error'; lastError = e; emit(); }));
  stops.push(repo.watchImportsHousehold(homeId, (d) => { bh = d; bst.h = 'ready'; emit(); }, (e) => { bst.h = 'error'; batchError = e; emit(); }));
  stops.push(repo.watchImportsMine(homeId, uid, (d) => { bm = d; bst.m = 'ready'; emit(); }, (e) => { bst.m = 'error'; batchError = e; emit(); }));
  const guard = () => { if (disposed) throw fail('disposed'); };
  const live = (id) => { const e = snapshot().all.find((x) => x.id === id); if (!e) throw fail('calendar.err.notFound'); if (!isLive(e)) throw fail('calendar.err.deleted'); return e; };
  const check = (errors) => { const k = Object.keys(errors); if (k.length) throw fail(errors[k[0]], errors); };
  const api = {
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    getSnapshot: snapshot, listenerCount: () => stops.length,
    event: (id) => snapshot().all.find((x) => x.id === id) || null,
    /** Finance contract (stable ids, inclusive local dates). */
    intervals: (kind) => intervals(snapshot().events, kind),
    async create(input) {
      guard(); const { value, errors } = validateEvent(input); check(errors);
      const id = repo.newId(homeId);
      await repo.commit(homeId, [{ mode: 'set', id, data: createDoc(value, { uid, now: repo.now(), timezone }) }]);   // manual: importBatchId null
      return id;
    },
    async edit(id, input) {
      guard(); const cur = live(id); const { value, errors } = validateEvent({ ...input, audience: cur.audience }); check(errors);
      const p = editPatch(cur, value, { uid, now: repo.now() }); if (!p) return;
      try { await repo.commit(homeId, [{ mode: 'update', id, data: p }]); } catch (e) { if (denied(e)) throw fail('calendar.err.conflict'); throw e; }
    },
    async setDone(id, done) {
      guard(); const cur = live(id); if (cur.type !== 'task') throw fail('calendar.err.notTask');
      await repo.commit(homeId, [{ mode: 'update', id, data: { done: !!done, rev: cur.rev + 1, updatedBy: uid, updatedAt: repo.now() } }]);
    },
    async remove(id) {
      guard(); const cur = live(id); const now = repo.now();
      await repo.commit(homeId, [{ mode: 'update', id, data: { deletedAt: now, deletedBy: uid, rev: cur.rev + 1, updatedBy: uid, updatedAt: now } }]);
    },
    /**
     * Confirmed CSV import (V6.2.1: one BATCH per import). Order: batch doc ('importing') → one create per
     * new row, each stamped importBatchId → batch 'active' with its count. Rows already live are skipped
     * (create-only ids); rows removed earlier are restored ONLY when listed in `restore` (explicit choice).
     * An interrupted import leaves the batch 'importing' (shown as incomplete; it can still be removed).
     * Returns { created, restored, skipped, failed: [line], batchId }.
     */
    async importRows(rows, { audience, fileName, restore = [], onProgress } = {}) {
      guard(); const res = { created: 0, restored: 0, skipped: 0, failed: [], batchId: null };
      const byId = new Map(snapshot().all.map((e) => [e.id, e])); const again = new Set(restore);
      const aud = audience === 'private' ? 'private' : 'household';
      const plan = rows.map((r) => { const cur = byId.get(r.id); return { r, cur, op: !cur ? 'create' : !isLive(cur) && again.has(r.id) && cur.source === 'csv' ? 'revive' : 'skip' }; });
      const work = plan.filter((x) => x.op !== 'skip'); res.skipped = plan.length - work.length;
      if (!work.length) { if (onProgress) onProgress(res, rows.length); return res; }
      const batchId = repo.newId(homeId, IMPORTS);
      await repo.commit(homeId, [{ mode: 'set', name: IMPORTS, id: batchId, data: batchDoc({ fileName, audience: aud, uid, now: repo.now() }) }]);
      res.batchId = batchId;
      for (const { r, cur, op } of work) {
        try {
          if (op === 'create') {
            await repo.commit(homeId, [{ mode: 'set', id: r.id, data: createDoc({ ...r.value, audience: aud }, { uid, now: repo.now(), timezone, source: 'csv', sourceKey: r.sourceKey, importBatchId: batchId }) }]);
            res.created++;
          } else {
            await repo.commit(homeId, [{ mode: 'update', id: r.id, data: reviveDoc(cur, r.value, { uid, now: repo.now(), importBatchId: batchId }) }]);
            res.restored++;
          }
        } catch (e) { if (denied(e)) res.skipped++; else res.failed.push(r.line); }
        if (onProgress) onProgress(res, rows.length);
      }
      try { await repo.commit(homeId, [{ mode: 'update', name: IMPORTS, id: batchId, data: { status: 'active', createdCount: res.created + res.restored, rev: 2, updatedBy: uid, updatedAt: repo.now() } }]); }
      catch { /* the batch stays 'importing' (incomplete) — its events are still listed and removable */ }
      return res;
    },
    batch: (id) => snapshot().batches.find((b) => b.id === id) || null,
    /** What "Remove Import" would do now (proof = stored importBatchId only). */
    removalPreview: (batchId, opts) => removalPlan(snapshot().all, batchId, opts),
    /**
     * Remove ONE import batch: soft-delete only its own events (never manual events, never another batch),
     * in bounded chunks. Resumable and idempotent: the batch is marked 'removing' first; a failure leaves it
     * there and a retry only touches events still live. keepEdited (default) keeps events changed after import.
     * Vacations removed here stop matching Finance filters; expenses are never touched.
     */
    async removeBatch(batchId, { keepEdited = true, onProgress } = {}) {
      guard(); const b = api.batch(batchId); if (!b) throw fail('calendar.err.notFound');
      if (b.status === 'removed') return { removed: 0, kept: b.keptCount || 0, already: true };
      let rev = b.rev || 1;
      if (b.status !== 'removing') { rev++; await repo.commit(homeId, [{ mode: 'update', name: IMPORTS, id: batchId, data: { status: 'removing', rev, updatedBy: uid, updatedAt: repo.now() } }]); }
      const { targets, keep } = removalPlan(snapshot().all, batchId, { keepEdited });
      let done = 0;
      for (let i = 0; i < targets.length; i += REMOVE_CHUNK) {
        const chunk = targets.slice(i, i + REMOVE_CHUNK); const now = repo.now();
        try { await repo.commit(homeId, chunk.map((e) => ({ mode: 'update', id: e.id, data: { deletedAt: now, deletedBy: uid, rev: e.rev + 1, updatedBy: uid, updatedAt: now } }))); }
        catch (e) { throw Object.assign(fail('calendar.batch.partial'), { removed: done, remaining: targets.length - done, cause: e }); }
        done += chunk.length; if (onProgress) onProgress(done, targets.length);
      }
      const gone = batchMembers(snapshot().all, batchId).filter((e) => !isLive(e) || targets.includes(e)).length;
      await repo.commit(homeId, [{ mode: 'update', name: IMPORTS, id: batchId, data: { status: 'removed', removedCount: gone, keptCount: keep.length, rev: rev + 1, updatedBy: uid, updatedAt: repo.now() } }]);
      return { removed: done, kept: keep.length };
    },
    dispose() { disposed = true; for (const s of stops) { try { s(); } catch { /* ignore */ } } stops.length = 0; subs.clear(); },
  };
  return api;
}
