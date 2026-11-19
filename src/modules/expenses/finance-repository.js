/**
 * Finance Firestore access — the ONLY finance file that knows paths.
 *   homes/{homeId}/expenses | walletMovements | wallets | spendingCycles | commitments
 * Every listener uses ONE rules-provable constraint:
 *   household : where('audience' | 'visibility', '==', 'household')
 *   mine      : where('readers', 'array-contains', uid)
 */
import { paths } from '../../core/firebase/paths.js';
import { watchWhere, readDoc, atomicWrite, newDocId, serverTime } from '../../core/data/firestore.js';

import { COL } from './collections.js';

export { COL };

const col = (homeId, name) => paths.homeCollection(homeId, name);
const docPath = (homeId, name, id) => paths.homeDoc(homeId, name, id);

export const financeRepository = Object.freeze({
  now: serverTime,
  newId: (homeId, name) => newDocId(col(homeId, name)),
  /** kind: 'household' | 'mine' */
  watch(homeId, name, kind, uid, onValue, onError) {
    const constraint = kind === 'household'
      ? [name === COL.wallets ? 'visibility' : 'audience', '==', 'household']
      : ['readers', 'array-contains', uid];
    return watchWhere(col(homeId, name), constraint, onValue, onError);
  },
  /** V6: refund ledgers are readable per document only (their rule checks the parent expense). */
  read: (homeId, name, id) => readDoc(docPath(homeId, name, id)),
  /** ops: [{ mode: 'set'|'update', name, id, data }] committed atomically. */
  commit(homeId, ops) {
    return atomicWrite((w) => { for (const o of ops) w[o.mode](docPath(homeId, o.name, o.id), o.data); });
  },
});
