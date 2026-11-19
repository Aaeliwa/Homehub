/**
 * Maintenance Firestore access (Phase 5.5) — the only file with maintenance paths.
 *   homes/{h}/maintenancePlans        preventive plans
 *   homes/{h}/maintenanceFaults       corrective issues
 *   homes/{h}/maintenanceRecords      service history (append-only)
 *   homes/{h}/maintenanceFaultEvents  fault status history (append-only; read on demand)
 * Whole-collection listeners / single-field queries only → no composite indexes.
 */
import { paths } from '../../core/firebase/paths.js';
import { watchCollection, watchWhere, atomicWrite, newDocId, serverTime, readDoc } from '../../core/data/firestore.js';

import { MCOL } from './maintenance-collections.js';
export { MCOL };
const col = (h, n) => paths.homeCollection(h, n);

export const maintenanceRepository = Object.freeze({
  now: serverTime,
  newId: (h, name) => newDocId(col(h, name)),
  watchPlans: (h, onValue, onError) => watchCollection(col(h, MCOL.plans), onValue, onError),
  watchFaults: (h, onValue, onError) => watchCollection(col(h, MCOL.faults), onValue, onError),
  watchRecords: (h, onValue, onError) => watchCollection(col(h, MCOL.records), onValue, onError),
  readFaultEvents: (h, faultId) => new Promise((resolve, reject) => {
    let off = () => {};
    off = watchWhere(col(h, MCOL.events), ['faultId', '==', faultId], (docs) => { resolve(docs); setTimeout(() => off(), 0); }, (e) => { reject(e); setTimeout(() => off(), 0); });
  }),
  readRecord: (h, id) => readDoc(paths.homeDoc(h, MCOL.records, id)),
  commit: (h, ops) => atomicWrite((w) => { for (const o of ops) w[o.mode](paths.homeDoc(h, o.name, o.id), o.data); }),
});
