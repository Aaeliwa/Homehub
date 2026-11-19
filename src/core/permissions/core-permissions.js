/**
 * Permissions owned by the core (home, members, roles). Modules declare their own in
 * their module definition; the registry merges both into one catalog.
 *
 * `defaultRoles` lists which seeded roles receive the permission. The owner role is not
 * listed anywhere because it holds the "*" grant.
 */
export const CORE_PERMISSIONS = Object.freeze([
  { id: 'home.view', defaultRoles: ['admin', 'member', 'viewer', 'child'] },
  { id: 'home.edit', defaultRoles: ['admin'] },
  { id: 'members.view', defaultRoles: ['admin', 'member', 'viewer'] },
  { id: 'members.invite', defaultRoles: ['admin'] },
  { id: 'members.edit', defaultRoles: ['admin'] },
  { id: 'members.remove', defaultRoles: ['admin'] },
  // Phase 4A: configure a child's guardians (explicit relationship; scoped, not admin).
  { id: 'members.manageChildren', defaultRoles: ['admin'] },
  { id: 'roles.view', defaultRoles: ['admin', 'member', 'viewer'] },
  { id: 'roles.edit', defaultRoles: [] },
]);
