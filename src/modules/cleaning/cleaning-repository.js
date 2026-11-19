/**
 * Cleaning Firestore access (the only file with cleaning paths). Phase 5.3.
 *   homes/{h}/cleaningTasks        whole collection (household data, cleaning.view)
 *   homes/{h}/cleaningOccurrences  where dueDate >= windowStart (single-field range → no composite index)
 *   homes/{h}/cleaningLog          read on demand: where occurrenceId == id (single-field)
 */
import { paths } from '../../core/firebase/paths.js';
import { watchCollection, watchWhere, watchDoc, atomicWrite, newDocId, serverTime, readDoc } from '../../core/data/firestore.js';

export const CCOL = Object.freeze({ tasks: 'cleaningTasks', occurrences: 'cleaningOccurrences', log: 'cleaningLog',
  routines: 'cleaningRoutines', settings: 'cleaningSettings',   // Phase 5.4a (Advanced)
  deviceEvents: 'cleaningDeviceEvents', deviceState: 'cleaningDeviceState', deviceSeasons: 'cleaningDeviceSeasons',   // Phase 5.4b
  templates: 'cleaningCustomTemplates' });   // Phase 5.4c
const col = (h, n) => paths.homeCollection(h, n);

export const cleaningRepository = Object.freeze({
  now: serverTime,
  newId: (h) => newDocId(col(h, CCOL.tasks)),
  watchTasks: (h, onValue, onError) => watchCollection(col(h, CCOL.tasks), onValue, onError),
  watchOccurrences: (h, fromDate, onValue, onError) => watchWhere(col(h, CCOL.occurrences), ['dueDate', '>=', fromDate], onValue, onError),
  /** One-shot read of an occurrence's audit log. */
  readLog: (h, occurrenceId) => new Promise((resolve, reject) => {
    let off = () => {};
    off = watchWhere(col(h, CCOL.log), ['occurrenceId', '==', occurrenceId], (docs) => { resolve(docs); setTimeout(() => off(), 0); }, (e) => { reject(e); setTimeout(() => off(), 0); });
  }),
  /** Server read (online): does this task document exist? Used to classify a rejected create. */
  taskExists: async (h, id) => (await readDoc(paths.homeDoc(h, CCOL.tasks, id))) !== null,
  // ---- Phase 5.4a (Advanced) ----
  watchRoutine: (h, day, onValue, onError) => watchDoc(paths.homeDoc(h, CCOL.routines, day), onValue, onError),
  routineExists: async (h, day) => (await readDoc(paths.homeDoc(h, CCOL.routines, day))) !== null,
  watchSettings: (h, onValue, onError) => watchDoc(paths.homeDoc(h, CCOL.settings, 'general'), onValue, onError),
  /** One-shot, bounded read of audit entries since `sinceDate` (single-field range on `at`). */
  readLogSince: (h, sinceDate) => new Promise((resolve, reject) => {
    let off = () => {};
    off = watchWhere(col(h, CCOL.log), ['at', '>=', sinceDate], (docs) => { resolve(docs); setTimeout(() => off(), 0); }, (e) => { reject(e); setTimeout(() => off(), 0); });
  }),
  // ---- Phase 5.4b (devices) ----
  newEventId: (h) => newDocId(col(h, CCOL.deviceEvents)),
  watchDeviceEvents: (h, sinceDate, onValue, onError) => watchWhere(col(h, CCOL.deviceEvents), ['at', '>=', sinceDate], onValue, onError),
  watchDeviceStates: (h, onValue, onError) => watchCollection(col(h, CCOL.deviceState), onValue, onError),
  readSeasonLog: (h, deviceId) => new Promise((resolve, reject) => {
    let off = () => {};
    off = watchWhere(col(h, CCOL.deviceSeasons), ['deviceId', '==', deviceId], (docs) => { resolve(docs); setTimeout(() => off(), 0); }, (e) => { reject(e); setTimeout(() => off(), 0); });
  }),
  eventExists: async (h, id) => (await readDoc(paths.homeDoc(h, CCOL.deviceEvents, id))) !== null,
  // ---- Phase 5.4c (custom templates) ----
  newTemplateId: (h) => newDocId(col(h, CCOL.templates)),
  watchTemplates: (h, onValue, onError) => watchCollection(col(h, CCOL.templates), onValue, onError),
  docExists: async (h, name, id) => (await readDoc(paths.homeDoc(h, name, id))) !== null,
  commit: (h, ops) => atomicWrite((w) => { for (const o of ops) w[o.mode](paths.homeDoc(h, o.name, o.id), o.data); }),
});
