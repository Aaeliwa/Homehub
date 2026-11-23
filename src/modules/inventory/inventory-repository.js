/** Pantry (V6.5 Phase 01) Firestore access — the only file with pantry paths. */
import { paths } from '../../core/firebase/paths.js';
import { watchWhereLimited, readWhereLimited, atomicWrite, newDocId, serverTime, readDoc } from '../../core/data/firestore.js';
import { LIMITS } from './product-model.js';

export const PCOL = Object.freeze({ products: 'pantryProducts' });
export const inventoryRepository = Object.freeze({
  now: serverTime,
  newId: (h) => newDocId(paths.homeCollection(h, PCOL.products)),
  /** Live, BOUNDED: active products only, capacity + 1 (so the store can tell "at capacity" from "truncated"). */
  watchProducts: (h, on, err) => watchWhereLimited(paths.homeCollection(h, PCOL.products), ['archived', '==', false], LIMITS.maxProducts + 1, on, err),
  /** One-shot, on demand (Archived view): archivedList + 1 (truncation flag). */
  readArchived: (h) => readWhereLimited(paths.homeCollection(h, PCOL.products), ['archived', '==', true], LIMITS.archivedList + 1),
  read: (h, id) => readDoc(paths.homeDoc(h, PCOL.products, id)),
  /** Phase 01: set (create) / update (metadata or archive mask) only — never delete. */
  commit: (h, ops) => atomicWrite((w) => { for (const o of ops) w[o.mode](paths.homeDoc(h, PCOL.products, o.id), o.data); }),
});
