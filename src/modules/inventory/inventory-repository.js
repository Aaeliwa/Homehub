/** Pantry (V6.5) Firestore access — the only file with pantry paths. */
import { paths } from '../../core/firebase/paths.js';
import { watchWhereLimitedMeta, readWhereLimited, readWhereOrderedLimited, readDocServer, atomicWrite, newDocId, serverTime, readDoc } from '../../core/data/firestore.js';
import { LIMITS } from './product-model.js';
import { HISTORY_LIMIT } from './stock-model.js';

export const PCOL = Object.freeze({ products: 'pantryProducts', movements: 'pantryMovements' });
export const inventoryRepository = Object.freeze({
  now: serverTime,
  newId: (h) => newDocId(paths.homeCollection(h, PCOL.products)),
  /**
   * Live, BOUNDED: active products only, capacity + 1 (so the store can tell "at capacity" from "truncated").
   * P02: with snapshot metadata (fromCache / hasPendingWrites) so the UI never presents cached or pending stock as confirmed.
   */
  watchProducts: (h, on, err) => watchWhereLimitedMeta(paths.homeCollection(h, PCOL.products), ['archived', '==', false], LIMITS.maxProducts + 1, on, err),
  /** One-shot, on demand (Archived view): archivedList + 1 (truncation flag). */
  readArchived: (h) => readWhereLimited(paths.homeCollection(h, PCOL.products), ['archived', '==', true], LIMITS.archivedList + 1),
  read: (h, id) => readDoc(paths.homeDoc(h, PCOL.products, id)),
  /** P02: recent history of ONE product, on demand: productId ==, stockRev DESC, limit 50 (composite index). */
  readHistory: (h, productId) => readWhereOrderedLimited(paths.homeCollection(h, PCOL.movements), ['productId', '==', productId], ['stockRev', 'desc'], HISTORY_LIMIT),
  /** P02: SERVER-confirmed reads (never from the local cache) for reconciling an ambiguous stock write. */
  readMovementServer: (h, id) => readDocServer(paths.homeDoc(h, PCOL.movements, id)),
  readProductServer: (h, id) => readDocServer(paths.homeDoc(h, PCOL.products, id)),
  /** Phase 01: set (create) / update (metadata or archive mask) only — never delete. */
  commit: (h, ops) => atomicWrite((w) => { for (const o of ops) w[o.mode](paths.homeDoc(h, PCOL.products, o.id), o.data); }),
  /** P02: ONE product per batch — the stock-mask update + the movement create at its deterministic id. Never delete. */
  commitStock: (h, productId, patch, movementId, movement) => atomicWrite((w) => {
    w.update(paths.homeDoc(h, PCOL.products, productId), patch);
    w.set(paths.homeDoc(h, PCOL.movements, movementId), movement);
  }),
});
