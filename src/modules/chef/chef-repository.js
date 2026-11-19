/** Chef (V6.1) Firestore access — the only file with recipe / timer paths. */
import { paths } from '../../core/firebase/paths.js';
import { watchCollection, watchWhere, atomicWrite, newDocId, serverTime, readDoc } from '../../core/data/firestore.js';

export const CCOL = Object.freeze({ recipes: 'recipes', timers: 'cookingTimers' });
export const chefRepository = Object.freeze({
  now: serverTime,
  newId: (h, name) => newDocId(paths.homeCollection(h, name)),
  watchRecipes: (h, on, err) => watchCollection(paths.homeCollection(h, CCOL.recipes), on, err),
  /** Owner-only timers (rules: resource.data.ownerUid == uid → the query must say so). */
  watchTimers: (h, uid, on, err) => watchWhere(paths.homeCollection(h, CCOL.timers), ['ownerUid', '==', uid], on, err),
  /** V6.3: server read — does this recipe id exist? (classifies a refused create during an import retry) */
  exists: async (h, name, id) => (await readDoc(paths.homeDoc(h, name, id))) !== null,
  commit: (h, ops) => atomicWrite((w) => { for (const o of ops) { if (o.mode === 'delete') w.delete(paths.homeDoc(h, o.name, o.id)); else w[o.mode](paths.homeDoc(h, o.name, o.id), o.data); } }),
});
