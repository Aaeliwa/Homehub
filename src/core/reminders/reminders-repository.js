/**
 * Reminder presentation state (Phase 5.6) — the only file with reminder paths. Owner-only:
 *   homes/{h}/reminderStates/{uid}_{fnv64(key)}   queried with ownerUid == uid (single-field)
 *   homes/{h}/reminderPrefs/{uid}
 */
import { paths } from '../firebase/paths.js';
import { watchWhere, watchDoc, atomicWrite, serverTime } from '../data/firestore.js';

export const RCOL = Object.freeze({ states: 'reminderStates', prefs: 'reminderPrefs' });
export const remindersRepository = Object.freeze({
  now: serverTime,
  watchStates: (h, uid, onValue, onError) => watchWhere(paths.homeCollection(h, RCOL.states), ['ownerUid', '==', uid], onValue, onError),
  watchPrefs: (h, uid, onValue, onError) => watchDoc(paths.homeDoc(h, RCOL.prefs, uid), onValue, onError),
  commit: (h, ops) => atomicWrite((w) => { for (const o of ops) { if (o.mode === 'delete') w.delete(paths.homeDoc(h, o.name, o.id)); else w[o.mode](paths.homeDoc(h, o.name, o.id), o.data); } }),
});
