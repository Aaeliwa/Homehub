/**
 * Rooms Firestore access. The ONLY file that knows where rooms live:
 *
 *   homes/{homeId}/rooms/{roomId}
 *
 * Built with the shared paths + data layer (never a root "rooms" collection, never under
 * users/). Reads the whole collection with no query constraints → no composite index.
 */
import { paths } from '../../core/firebase/paths.js';
import { watchCollection, createDoc, patchDoc, atomicWrite, serverTime } from '../../core/data/firestore.js';

export const ROOMS_COLLECTION = 'rooms';

const roomsPath = (homeId) => paths.homeCollection(homeId, ROOMS_COLLECTION);
const roomPath = (homeId, roomId) => paths.homeDoc(homeId, ROOMS_COLLECTION, roomId);

export const roomRepository = Object.freeze({
  now: serverTime,
  watchRooms: (homeId, onValue, onError) => watchCollection(roomsPath(homeId), onValue, onError),
  create: (homeId, data) => createDoc(roomsPath(homeId), data),
  patch: (homeId, roomId, data) => patchDoc(roomPath(homeId, roomId), data),
  patchMany: (homeId, items) => atomicWrite((w) => {
    for (const { id, patch } of items) w.update(roomPath(homeId, id), patch);
  }),
});
