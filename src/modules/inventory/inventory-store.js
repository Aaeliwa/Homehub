/**
 * Pantry catalog store (V6.5 Phase 01). ONE bounded listener (active products) per Home scope, disposed on
 * sign-out / Home switch. Every write is CONFIRMED (no optimistic success), revisioned (rev + 1; a stale editor
 * is refused) and stamped; the Firestore rules re-check permissions and the schema. Updates send a field MASK
 * (update(), never set()) so a later stock write (Phase 02, its own stockRev) can never be overwritten by a
 * catalog edit, and vice versa. Phase 01 has no stock operation at all.
 */
import { assertValid, createDoc, editPatch, archivePatch, restorePatch, LIMITS, ID_RE } from './product-model.js';

const fail = (detail) => Object.assign(new Error(detail), { code: 'validation', detail });
const denied = (e) => e && (e.code === 'permission-denied' || e.code === 'PERMISSION_DENIED');

export function createInventoryStore({ homeId, uid, repo, canView }) {
  let products = []; let truncated = false; let state = canView ? 'loading' : 'denied'; let lastError = null; let disposed = false;
  const subs = new Set(); const stops = []; let cache = null;
  const emit = () => { cache = null; for (const fn of subs) fn(snapshot()); };
  function snapshot() {
    if (cache) return cache;
    cache = Object.freeze({ status: state, error: lastError, products, truncated, capacity: LIMITS.maxProducts,
      atLimit: truncated || products.length >= LIMITS.maxProducts });
    return cache;
  }
  if (canView) {
    stops.push(repo.watchProducts(homeId, (docs) => {
      const live = docs.filter((p) => p.archived !== true);
      truncated = live.length > LIMITS.maxProducts; products = live.slice(0, LIMITS.maxProducts); state = 'ready'; lastError = null; emit();
    }, (e) => { state = 'error'; lastError = e; emit(); }));
  }
  const guard = () => { if (disposed) throw fail('disposed'); };
  const product = (id) => products.find((p) => p.id === id) || null;
  const live = (id) => { const p = product(id); if (!p) throw fail('pantry.err.notFound'); return p; };
  /** A refused update whose base revision is no longer current → "changed by someone else". */
  async function update(id, baseRev, data) {
    try { await repo.commit(homeId, [{ mode: 'update', id, data }]); }
    catch (e) {
      if (!denied(e)) throw e;
      try { const cur = await repo.read(homeId, id); if (!cur || cur.rev !== baseRev) throw fail('pantry.err.stale'); } catch (re) { if (re && re.detail) throw re; }
      throw e;
    }
  }
  return {
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    getSnapshot: snapshot, product, listenerCount: () => stops.length,
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
    dispose() { disposed = true; for (const s of stops.splice(0)) { try { s(); } catch { /* ignore */ } } subs.clear(); },
  };
}
