/**
 * Permission resolver: membership + role -> effective runtime permission set.
 *
 * Pure (no Firebase, no DOM) and mirrored by `grants()` in firestore.rules.
 * The UI uses it to show/hide actions; Firestore rules are what actually enforce access.
 */
import { isGrant, isPermissionId, namespaceOf } from './permission-format.js';

function grantMatches(grant, permission) {
  if (grant === '*') return true;
  if (grant === permission) return true;
  return grant.endsWith('.*') && grant.slice(0, -2) === namespaceOf(permission);
}

export function createPermissionSet(grants = []) {
  const list = Object.freeze([...new Set(grants.filter(isGrant))].sort());
  const can = (permission) => isPermissionId(permission) && list.some((g) => grantMatches(g, permission));
  return Object.freeze({
    grants: list,
    can,
    canAny: (perms) => Array.isArray(perms) && perms.some(can),
    canAll: (perms) => Array.isArray(perms) && perms.length > 0 && perms.every(can),
    isEmpty: list.length === 0,
  });
}

export const NO_PERMISSIONS = createPermissionSet([]);

/**
 * Effective permissions are the role's grants, but only while the membership is active
 * and points at that exact role. Anything inconsistent resolves to no permissions.
 */
export function resolvePermissions({ membership, role }) {
  if (!membership || membership.status !== 'active') return NO_PERMISSIONS;
  if (!role || role.id !== membership.roleId || !Array.isArray(role.permissions)) return NO_PERMISSIONS;
  return createPermissionSet(role.permissions);
}
