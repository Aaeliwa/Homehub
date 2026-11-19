/**
 * Read access to the core HomeHub documents. All reads used to resolve the session
 * context live here; UI never reads these paths directly.
 */
import { paths, SETTINGS_DOCS } from '../firebase/paths.js';
import { readDoc, readCollection } from '../data/firestore.js';

export const homeRepository = Object.freeze({
  readProfile: (uid) => readDoc(paths.user(uid)),
  readMembership: (homeId, uid) => readDoc(paths.member(homeId, uid)),
  readHome: (homeId) => readDoc(paths.home(homeId)),
  readRole: (homeId, roleId) => readDoc(paths.role(homeId, roleId)),
  readGeneralSettings: (homeId) => readDoc(paths.setting(homeId, SETTINGS_DOCS.general)),
  /** Requires members.view (enforced by rules). */
  listMembers: (homeId) => readCollection(paths.members(homeId)),
  /** Requires roles.view (enforced by rules). */
  listRoles: (homeId) => readCollection(paths.roles(homeId)),
});
