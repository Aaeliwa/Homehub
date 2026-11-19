/**
 * Permission ids are exactly two segments: "<namespace>.<action>", e.g. "expenses.create".
 * Grants may also be "<namespace>.*" (every action in a namespace) or "*" (everything).
 * Firestore rules evaluate the same three forms, so this format must not change casually.
 */
export const PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;
export const GRANT_PATTERN = /^(\*|[a-z][a-zA-Z0-9]*\.(\*|[a-z][a-zA-Z0-9]*))$/;

export function isPermissionId(value) {
  return typeof value === 'string' && PERMISSION_PATTERN.test(value);
}

export function isGrant(value) {
  return typeof value === 'string' && GRANT_PATTERN.test(value);
}

export function namespaceOf(permission) {
  return permission.slice(0, permission.indexOf('.'));
}
