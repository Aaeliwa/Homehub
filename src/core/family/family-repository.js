/**
 * Family data access (members + invites). Uses the shared data layer only.
 *   homes/{homeId}/members      listener (requires members.view)
 *   invites where homeId == h   listener (requires members.invite)
 *   invites/{code}              single get by code (any signed-in user who knows it)
 */
import { paths } from '../firebase/paths.js';
import { watchCollection, watchWhere, readDoc, atomicWrite, serverTime } from '../data/firestore.js';

export const familyRepository = Object.freeze({
  now: serverTime,
  watchMembers: (homeId, onValue, onError) => watchCollection(paths.members(homeId), onValue, onError),
  watchInvites: (homeId, onValue, onError) => watchWhere(paths.invites(), ['homeId', '==', homeId], onValue, onError),
  readInvite: (code) => readDoc(paths.invite(code)),
  readMember: (homeId, uid) => readDoc(paths.member(homeId, uid)),
  /** ops: [{ mode, path (segments), data }] committed atomically. */
  commit: (ops) => atomicWrite((w) => { for (const o of ops) w[o.mode](o.path, o.data); }),
});
