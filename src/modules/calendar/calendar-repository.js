/** Calendar (V6.2 / V6.2.1) Firestore access — the only file with calendarEvents / calendarImports paths. */
import { paths } from '../../core/firebase/paths.js';
import { watchWhere, atomicWrite, newDocId, serverTime } from '../../core/data/firestore.js';

export const EVENTS = 'calendarEvents';
export const IMPORTS = 'calendarImports';   // V6.2.1: one document per CSV import batch
export const MAX_OPS = 450;                 // Firestore allows 500 writes per batch; stay well below
export const calendarRepository = Object.freeze({
  now: serverTime,
  newId: (h, name = EVENTS) => newDocId(paths.homeCollection(h, name)),
  /** Rule-compatible queries: household docs + my own docs (incl. private) — two listeners per collection. */
  watchHousehold: (h, on, err) => watchWhere(paths.homeCollection(h, EVENTS), ['audience', '==', 'household'], on, err),
  watchMine: (h, uid, on, err) => watchWhere(paths.homeCollection(h, EVENTS), ['createdBy', '==', uid], on, err),
  watchImportsHousehold: (h, on, err) => watchWhere(paths.homeCollection(h, IMPORTS), ['audience', '==', 'household'], on, err),
  watchImportsMine: (h, uid, on, err) => watchWhere(paths.homeCollection(h, IMPORTS), ['createdBy', '==', uid], on, err),
  commit: (h, ops) => {
    if (ops.length > MAX_OPS) throw Object.assign(new Error('calendar.err.tooManyWrites'), { detail: 'calendar.err.tooManyWrites' });
    return atomicWrite((w) => { for (const o of ops) w[o.mode](paths.homeDoc(h, o.name || EVENTS, o.id), o.data); });
  },
});
