/**
 * Life Savings Firestore access (the only file with savings paths).
 * Privacy-provable listeners (rules are not filters):
 *   assets  household: where('visibility','==','household')   mine: where('readers','array-contains',uid)
 *   events  household: where('audience','==','household')     mine: where('readers','array-contains',uid)
 *   quotes  whole collection (household reference prices; any active member)
 *   zakat   mine only: where('readers','array-contains',uid)  — Zakat is per owner, never household
 */
import { paths } from '../../core/firebase/paths.js';
import { watchWhere, watchCollection, atomicWrite, newDocId, serverTime } from '../../core/data/firestore.js';
import { SCOL } from './collections.js';

export { SCOL };
const col = (homeId, name) => paths.homeCollection(homeId, name);

export const savingsRepository = Object.freeze({
  now: serverTime,
  newId: (homeId, name) => newDocId(col(homeId, name)),
  watch(homeId, name, kind, uid, onValue, onError) {
    if (name === SCOL.quotes) return watchCollection(col(homeId, name), onValue, onError);
    const c = kind === 'household' ? [name === SCOL.assets ? 'visibility' : 'audience', '==', 'household'] : ['readers', 'array-contains', uid];
    return watchWhere(col(homeId, name), c, onValue, onError);
  },
  /** ops: [{ mode, name, id, data }] — `name` may be any home collection (e.g. walletMovements, expenses). */
  commit: (homeId, ops) => atomicWrite((w) => { for (const o of ops) w[o.mode](paths.homeDoc(homeId, o.name, o.id), o.data); }),
});
