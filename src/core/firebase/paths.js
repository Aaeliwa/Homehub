/**
 * Authoritative Firestore paths. Every Firestore location used by HomeHub is built here so
 * the schema lives in one place (documented in FIRESTORE-SCHEMA.md).
 *
 * Paths are arrays of segments. Even length = document, odd length = collection.
 * Future modules add their collections under a home with `homeCollection(homeId, name)`
 * and `homeDoc(homeId, name, id)` — never at the database root.
 */
const SEGMENT = /^[^/\s][^/]*$/;

function seg(value, label) {
  if (typeof value !== 'string' || !SEGMENT.test(value) || value === '.' || value === '..') {
    throw new TypeError(`Invalid Firestore path segment for ${label}`);
  }
  return value;
}

export const COLLECTIONS = Object.freeze({
  users: 'users',
  homes: 'homes',
  members: 'members',
  roles: 'roles',
  settings: 'settings',
  invites: 'invites',
});

export const SETTINGS_DOCS = Object.freeze({ general: 'general' });

export const paths = Object.freeze({
  user: (uid) => [COLLECTIONS.users, seg(uid, 'uid')],
  homes: () => [COLLECTIONS.homes],
  home: (homeId) => [COLLECTIONS.homes, seg(homeId, 'homeId')],
  members: (homeId) => [...paths.home(homeId), COLLECTIONS.members],
  member: (homeId, uid) => [...paths.members(homeId), seg(uid, 'uid')],
  roles: (homeId) => [...paths.home(homeId), COLLECTIONS.roles],
  role: (homeId, roleId) => [...paths.roles(homeId), seg(roleId, 'roleId')],
  settings: (homeId) => [...paths.home(homeId), COLLECTIONS.settings],
  setting: (homeId, settingId) => [...paths.settings(homeId), seg(settingId, 'settingId')],
  /** Phase 4A: top-level invitations, keyed by their secret code. */
  invites: () => [COLLECTIONS.invites],
  invite: (code) => [COLLECTIONS.invites, seg(code, 'code')],
  /** For future modules: homes/{homeId}/{collection} */
  homeCollection: (homeId, name) => [...paths.home(homeId), seg(name, 'collection')],
  /** For future modules: homes/{homeId}/{collection}/{id} */
  homeDoc: (homeId, name, id) => [...paths.homeCollection(homeId, name), seg(id, 'id')],
});

export function pathToString(segments) { return segments.join('/'); }
