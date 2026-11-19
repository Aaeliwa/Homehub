/**
 * Devices Firestore access — the ONLY file that knows where devices live:
 *
 *   homes/{homeId}/devices/{deviceId}
 *
 * Never under rooms/, never a root collection. Whole-collection listener without query
 * constraints → no composite index.
 */
import { paths } from '../../core/firebase/paths.js';
import { watchCollection, createDoc, patchDoc, serverTime } from '../../core/data/firestore.js';

export const DEVICES_COLLECTION = 'devices';

const devicesPath = (homeId) => paths.homeCollection(homeId, DEVICES_COLLECTION);
const devicePath = (homeId, id) => paths.homeDoc(homeId, DEVICES_COLLECTION, id);

export const deviceRepository = Object.freeze({
  now: serverTime,
  watchDevices: (homeId, onValue, onError) => watchCollection(devicesPath(homeId), onValue, onError),
  create: (homeId, data) => createDoc(devicesPath(homeId), data),
  patch: (homeId, id, data) => patchDoc(devicePath(homeId, id), data),
});
