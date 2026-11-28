/**
 * Pantry store (V6.5). ONE bounded listener (active products, with snapshot metadata) per Home scope, disposed on
 * sign-out / Home switch. Every write is CONFIRMED (no optimistic success), revisioned and stamped; the Firestore rules
 * re-check permissions and the schema. Updates send a field MASK (update(), never set()), so a catalog edit (rev) and a
 * stock write (stockRev) never overwrite each other.
 *
 * Phase 02 stock protocol (submitStock):
 *   1. preconditions — server-confirmed snapshot (not fromCache, product without pending writes), browser online, product
 *      active, stockRev and dimension still the ones the dialog captured, no unresolved operation on this product, a
 *      never-used operationId, and an explicit confirmation when the same change was just confirmed (repeat guard).
 *      navigator.onLine alone is never treated as confirmation.
 *   2. the intent is RECORDED (pending-ops registry: memory + localStorage) before anything is sent, so it survives
 *      store disposal (Home switch, sign-out, unmount) and page reload.
 *   3. ONE atomic batch: product stock mask + movement at the deterministic id {pid}_s{stockRev + 1}. One product per
 *      batch is an APPLICATION constraint (simple, reviewable outcomes); the rules validate every product / movement pair
 *      independently and are the security boundary.
 *   4. success only when the commit resolves (server acknowledged). While it is pending the operation stays "submitting".
 *   5. on failure, or for an operation recovered from an earlier store / page: SERVER read of that movement id. Same
 *      operationId + actor + every value → "confirmed" (lost ack). A different movement → "conflict". None, after the
 *      commit settled → "rejected" (not applied). Server unreachable → "unknown": the product stays blocked until a
 *      review (review / reviewAll) resolves it. There is NO automatic retry and never a fresh revision for a retry.
 */
import { assertValid, createDoc, editPatch, archivePatch, restorePatch, LIMITS, ID_RE } from './product-model.js';
import { planStock, computeStock, movementMatches, HISTORY_LIMIT } from './stock-model.js';
import * as registry from './pending-ops.js';

const fail = (detail) => Object.assign(new Error(detail), { code: 'validation', detail });
const denied = (e) => e && (e.code === 'permission-denied' || e.code === 'PERMISSION_DENIED');
const browserOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

export function createInventoryStore({ homeId, uid, repo, canView, isOnline = browserOnline }) {
  let products = []; let truncated = false; let state = canView ? 'loading' : 'denied'; let lastError = null; let disposed = false;
  let meta = { fromCache: true, hasPendingWrites: false, pendingIds: [] };
  const subs = new Set(); const stops = []; let cache = null;
  /** operationId → { productId, operationId, movementId, expected, baseStockRev, trackMode, status: 'submitting' | 'unknown', settled, recovered, error } */
  const inflight = new Map();
  /** Outcomes of RECOVERED operations the user has not seen yet: { operationId, productId, status: confirmed | conflict | rejected } */
  const notices = [];
  // Recover unresolved operations recorded for this user + Home (earlier store, Home switch, sign-out or page reload).
  for (const r of (uid && homeId ? registry.listOps(uid, homeId) : [])) {
    inflight.set(r.operationId, { ...r, status: 'unknown', recovered: true, error: null });
  }
  let autoChecked = false;
  const emit = () => { if (disposed) return; cache = null; for (const fn of subs) fn(snapshot()); };
  function snapshot() {
    if (cache) return cache;
    cache = Object.freeze({ status: state, error: lastError, products, truncated, capacity: LIMITS.maxProducts,
      atLimit: truncated || products.length >= LIMITS.maxProducts,
      fromCache: meta.fromCache, hasPendingWrites: meta.hasPendingWrites, pendingIds: Object.freeze([...meta.pendingIds]),
      operations: Object.freeze([...inflight.values()].map((o) => Object.freeze({ productId: o.productId, operationId: o.operationId, status: o.status, movementId: o.movementId, settled: o.settled, recovered: !!o.recovered }))),
      notices: Object.freeze(notices.map((n) => Object.freeze({ ...n }))) });
    return cache;
  }
  if (canView) {
    stops.push(repo.watchProducts(homeId, (docs, m) => {
      const live = docs.filter((p) => p.archived !== true);
      truncated = live.length > LIMITS.maxProducts; products = live.slice(0, LIMITS.maxProducts); state = 'ready'; lastError = null;
      meta = { fromCache: !!(m && m.fromCache), hasPendingWrites: !!(m && m.hasPendingWrites), pendingIds: (m && Array.isArray(m.pendingIds)) ? m.pendingIds : [] };
      emit();
      // First server-confirmed snapshot: check recovered operations ONCE (server reads only — never a write or a retry).
      if (!autoChecked && !meta.fromCache && isOnline() && [...inflight.values()].some((o) => o.recovered)) { autoChecked = true; reviewAll().catch(() => {}); }
    }, (e) => { state = 'error'; lastError = e; emit(); }));
  }
  const guard = () => { if (disposed) throw fail('disposed'); };
  const product = (id) => products.find((p) => p.id === id) || null;
  const live = (id) => { const p = product(id); if (!p) throw fail('pantry.err.notFound'); return p; };
  const opsFor = (id) => [...inflight.values()].filter((o) => o.productId === id);
  /** A refused update whose base revision is no longer current → "changed by someone else". */
  async function update(id, baseRev, data) {
    try { await repo.commit(homeId, [{ mode: 'update', id, data }]); }
    catch (e) {
      if (!denied(e)) throw e;
      try { const cur = await repo.read(homeId, id); if (!cur || cur.rev !== baseRev) throw fail('pantry.err.stale'); } catch (re) { if (re && re.detail) throw re; }
      throw e;
    }
  }
  /** Why a stock write on this product cannot be submitted right now (i18n key), or null. */
  function stockBlock(id) {
    const p = product(id);
    if (state !== 'ready') return 'pantry.err.notConfirmed';
    if (!p) return 'pantry.err.notFound';
    if (p.archived === true) return 'pantry.err.archived';
    const ops = opsFor(id);
    if (ops.length) return ops.some((o) => o.status === 'unknown') ? 'pantry.err.reviewFirst' : 'pantry.err.inFlight';
    if (!isOnline()) return 'pantry.err.offline';
    if (meta.fromCache || meta.pendingIds.includes(id)) return 'pantry.err.notConfirmed';
    return null;
  }
  /** Final outcome: forget the operation everywhere (registry included); recovered outcomes become a notice. */
  function settle(entry, outcome) {
    registry.removeOp(uid, homeId, entry.operationId);
    if (outcome.status === 'confirmed') registry.noteConfirmed(uid, homeId, entry.expected);
    if (inflight.get(entry.operationId) === entry) inflight.delete(entry.operationId);
    if (entry.recovered && !disposed) notices.push({ operationId: entry.operationId, productId: entry.productId, status: outcome.status });
    emit(); return outcome;
  }
  /** Server-confirmed check of the deterministic movement id. Never writes. */
  async function reconcile(entry, error) {
    const rec = registry.getOp(uid, homeId, entry.operationId);
    entry.settled = entry.settled || !rec || rec.settled;   // a record removed meanwhile = its commit finished in this page
    let stored;
    try { stored = await repo.readMovementServer(homeId, entry.movementId); }
    catch (re) {
      if (disposed) return { status: 'unknown', error };
      if (!entry.settled) return { status: 'pending' };
      entry.status = 'unknown'; entry.error = error; emit();
      return { status: 'unknown', error };
    }
    if (stored && movementMatches(stored, entry.expected)) return settle(entry, { status: 'confirmed', movementId: entry.movementId, recovered: true });
    if (stored) return settle(entry, { status: 'conflict', error: fail('pantry.err.conflict') });
    if (!entry.settled) return { status: 'pending' };   // the original write is still queued and may still land — never "not applied"
    // Not applied. Explain a rejection by the current server state when we can (stale / archived), never by guessing.
    let reason = error || fail('pantry.err.notApplied');
    if (!error || denied(error)) {
      try {
        const cur = await repo.readProductServer(homeId, entry.productId);
        if (!cur || cur.archived === true) reason = fail('pantry.err.archivedNow');
        else if (cur.stockRev !== entry.baseStockRev || (cur.dimension ?? null) !== (entry.expected.dimension ?? null) || cur.trackMode !== entry.trackMode) reason = fail('pantry.err.stale');
      } catch { /* keep the original error */ }
    }
    return settle(entry, { status: 'rejected', error: reason });
  }
  async function reviewAll() {
    const out = [];
    for (const e of [...inflight.values()]) if (e.status === 'unknown') out.push(await reconcile(e, e.error));
    return out;
  }
  return {
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    getSnapshot: snapshot, product, listenerCount: () => stops.length, stockBlock,
    operation: (id) => { const ops = opsFor(id); const o = ops.find((x) => x.status === 'unknown') || ops[0]; return o ? { status: o.status, movementId: o.movementId, settled: o.settled, recovered: !!o.recovered } : null; },
    /** True when the same change on this product was confirmed moments ago (needs an explicit "record it again"). */
    isRepeat(id, intent) {
      const p = product(id); if (!p) return false;
      try { return registry.isRecentRepeat(uid, homeId, id, { ...computeStock(p, intent), productId: id }); } catch { return false; }
    },
    dismissNotice(operationId) { const i = notices.findIndex((n) => n.operationId === operationId); if (i >= 0) { notices.splice(i, 1); emit(); } },
    async createProduct(input) {
      guard(); const value = assertValid(input);
      if (snapshot().atLimit) throw fail('pantry.err.atLimit');
      const id = repo.newId(homeId);
      if (!ID_RE.test(id)) throw fail('pantry.err.id');
      await repo.commit(homeId, [{ mode: 'set', id, data: createDoc(value, { uid, now: repo.now() }) }]);
      return id;
    },
    /** baseRev = the revision the editor was opened with; a newer stored revision → pantry.err.stale. */
    async updateProduct(id, input, { baseRev } = {}) {
      guard(); const cur = live(id);
      if (Number.isInteger(baseRev) && cur.rev !== baseRev) throw fail('pantry.err.stale');
      const value = assertValid(input, { current: cur });
      const patch = editPatch(cur, value, { uid, now: repo.now() });
      if (!patch) return false;
      await update(id, cur.rev, patch);
      return true;
    },
    async archiveProduct(id) {
      guard(); const cur = live(id);
      await update(id, cur.rev, archivePatch(cur, { uid, now: repo.now() }));
    },
    /** Archived products are not in the live list: read on demand (rules: inventory.view). */
    async listArchived() {
      guard(); const docs = await repo.readArchived(homeId);
      const list = docs.filter((p) => p.archived === true);
      return { items: list.slice(0, LIMITS.archivedList), truncated: list.length > LIMITS.archivedList };
    },
    async restoreProduct(id) {
      guard(); const cur = await repo.read(homeId, id);
      if (!cur || cur.archived !== true) throw fail('pantry.err.notFound');
      if (snapshot().atLimit) throw fail('pantry.err.atLimit');
      await update(id, cur.rev, restorePatch(cur, { uid, now: repo.now() }));
    },
    /**
     * P02 stock write. ctx = what the dialog captured when it opened: { baseStockRev, dimension, trackMode, operationId,
     * confirmRepeat }. Resolves to { status: 'confirmed' | 'conflict' | 'rejected' | 'unknown', … }; throws only for
     * validation / preconditions (nothing sent).
     */
    async submitStock(id, intent, ctx = {}) {
      guard();
      const block = stockBlock(id); if (block) throw fail(block);
      const cur = live(id);
      if (cur.stockRev !== ctx.baseStockRev || (cur.dimension ?? null) !== (ctx.dimension ?? null) || cur.trackMode !== ctx.trackMode) throw fail('pantry.err.stale');
      if (registry.isUsedOperationId(uid, homeId, ctx.operationId)) throw fail('pantry.err.opReused');   // one operationId = one submission
      const plan = planStock(cur, intent, { uid, now: repo.now(), operationId: ctx.operationId, baseStockRev: ctx.baseStockRev });
      if (!ctx.confirmRepeat && registry.isRecentRepeat(uid, homeId, id, plan.movement)) throw fail('pantry.err.repeatConfirm');
      registry.addOp(uid, homeId, { productId: id, operationId: ctx.operationId, movementId: plan.id, expected: plan.movement, baseStockRev: ctx.baseStockRev, trackMode: cur.trackMode });
      const entry = { productId: id, operationId: ctx.operationId, movementId: plan.id, expected: plan.movement, baseStockRev: ctx.baseStockRev,
        trackMode: cur.trackMode, status: 'submitting', settled: false, recovered: false, error: null };
      inflight.set(entry.operationId, entry); emit();
      try {
        await repo.commitStock(homeId, id, plan.patch, plan.id, plan.movement);
        entry.settled = true;
        if (disposed) { registry.removeOp(uid, homeId, entry.operationId); registry.noteConfirmed(uid, homeId, entry.expected); return { status: 'confirmed', movementId: plan.id }; }
        return settle(entry, { status: 'confirmed', movementId: plan.id });
      } catch (e) {
        entry.settled = true; registry.markSettled(uid, homeId, entry.operationId);
        if (disposed) return { status: 'unknown', error: e };   // stays in the registry: the next store for this Home recovers it
        return reconcile(entry, e);
      }
    },
    /** Explicit user review of this product's unresolved operation: server read of its movement id, no write. */
    async review(id) {
      guard(); const entry = opsFor(id).find((o) => o.status === 'unknown') || opsFor(id)[0];
      if (!entry) return { status: 'none' };
      return reconcile(entry, entry.error);
    },
    /** Review every unresolved operation of this user + Home (including ones whose product is archived or gone). */
    async reviewAll() { guard(); return reviewAll(); },
    /** P02 recent history (newest first, at most HISTORY_LIMIT), on demand — no listener. */
    async history(id) {
      guard(); const docs = await repo.readHistory(homeId, id);
      const items = docs.filter((m) => m.productId === id).sort((a, b) => b.stockRev - a.stockRev).slice(0, HISTORY_LIMIT);
      return { items, limited: items.length >= HISTORY_LIMIT };
    },
    /** Disposal forgets only in-memory state: unresolved operations stay in the registry for the next store / page. */
    dispose() { disposed = true; inflight.clear(); notices.length = 0; for (const s of stops.splice(0)) { try { s(); } catch { /* ignore */ } } subs.clear(); },
  };
}
