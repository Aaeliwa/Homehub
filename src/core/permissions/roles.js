/**
 * Seeded (system) roles and the pure builder that turns the permission catalog into role
 * documents. Used by first-time setup and by "Update default roles".
 *
 * rank: higher = more authority. Firestore rules use rank so that a member can only
 * manage members/roles ranked strictly below their own. Owner is always 100.
 */
import { isPermissionId } from './permission-format.js';

/**
 * Bump when the default permission sets change (e.g. a new module declares permissions).
 * Homes whose system roles carry an older templateVersion are offered an update by the
 * owner in Settings. No silent rewrites.
 */
export const ROLE_TEMPLATE_VERSION = 9;   // v9 (V6.4 B): + contacts.import / export / manageCategories (additive)
// v8   // v8 (V6.2): + calendar.* (additive)
// v7   // v7 (V6 batch 3): expenses.manageBudgets → owner / admin only

/**
 * Template history — which permission NAMESPACES each version re-defined:
 *   1 — Phase 1: provisional standard permissions for every planned module.
 *   2 — Phase 2: rooms finalised (view for everyone; create/edit/delete/restore: admin).
 *   3 — Phase 3: devices finalised (same shape as rooms).
 *   4 — Phase 4: expenses (finance) finalised: wallets, transfers, budgets, commitments, import.
 *   5 — Phase 4A: members (family) — adds members.manageChildren (admin).
 *   6 — Phase 5: savings (Life Savings + Zakat).
 *
 * "Update default roles" (owner action) is NON-DESTRUCTIVE: for a role at version k it
 * replaces only grants in namespaces changed by versions > k, and keeps every other
 * grant — including any customised by hand. See upgradeRolePermissions().
 */
export const TEMPLATE_CHANGES = Object.freeze({ 2: Object.freeze(['rooms']), 3: Object.freeze(['devices']), 4: Object.freeze(['expenses']), 5: Object.freeze(['members']), 6: Object.freeze(['savings']), 7: Object.freeze(['expenses']) , 8: Object.freeze(['calendar']), 9: Object.freeze(['contacts']) });

/**
 * Versions whose namespace change is purely ADDITIVE (new default grants only). For these the
 * upgrade unions the new defaults into the role and never removes anything — so custom grants
 * inside that namespace survive too. v5 (Phase 4A) only adds members.manageChildren.
 */
export const ADDITIVE_VERSIONS = Object.freeze([5, 7, 8, 9]);
/**
 * v7 (V6 batch 3): precise REVOCATIONS — removed only from roles whose current template no longer
 * grants them (members lose manageBudgets; admins keep it). Everything else, custom grants included, is kept.
 */
export const REVOKED_GRANTS = Object.freeze({ 7: Object.freeze(['expenses.manageBudgets']) });

export const OWNER_ROLE_ID = 'owner';

export const SYSTEM_ROLES = Object.freeze([
  { id: 'owner', name: 'Owner', rank: 100 },
  { id: 'admin', name: 'Admin', rank: 80 },
  { id: 'member', name: 'Member', rank: 50 },
  { id: 'viewer', name: 'Viewer', rank: 20 },
  { id: 'child', name: 'Child', rank: 10 },
]);

export const SYSTEM_ROLE_IDS = Object.freeze(SYSTEM_ROLES.map((r) => r.id));

/**
 * @param {Array<{id:string, defaultRoles:string[]}>} catalog all known permissions
 * @returns {Array<{id, name, rank, permissions, system, templateVersion}>}
 */
export function buildSystemRoles(catalog) {
  for (const p of catalog) {
    if (!isPermissionId(p.id)) throw new TypeError(`Invalid permission id: ${p.id}`);
    for (const r of p.defaultRoles) {
      if (r === OWNER_ROLE_ID) throw new TypeError(`${p.id}: owner gets "*", do not list it`);
      if (!SYSTEM_ROLE_IDS.includes(r)) throw new TypeError(`${p.id}: unknown role ${r}`);
    }
  }
  return SYSTEM_ROLES.map((role) => ({
    id: role.id,
    name: role.name,
    rank: role.rank,
    permissions: role.id === OWNER_ROLE_ID
      ? ['*']
      : catalog.filter((p) => p.defaultRoles.includes(role.id)).map((p) => p.id).sort(),
    system: true,
    templateVersion: ROLE_TEMPLATE_VERSION,
  }));
}

/** Namespaces re-defined after `fromVersion` (inclusive of every later version). */
export function namespacesChangedSince(fromVersion) {
  const from = Number.isInteger(fromVersion) ? fromVersion : 0;
  return [...new Set(Object.entries(TEMPLATE_CHANGES)
    .filter(([v]) => Number(v) > from)
    .flatMap(([, ns]) => ns))].sort();
}

/**
 * Non-destructive role upgrade (pure).
 *   current   — the role's stored permissions
 *   template  — this role's permissions in the current template
 *   from      — the role's stored templateVersion
 * Grants outside the changed namespaces are kept verbatim; inside them the template wins.
 * '*' (owner) is kept as is.
 */
export function upgradeRolePermissions({ current, template, from }) {
  if (Array.isArray(current) && current.includes('*')) return ['*'];
  const fromV = Number.isInteger(from) ? from : 0;
  const later = Object.entries(TEMPLATE_CHANGES).filter(([v]) => Number(v) > fromV);
  const replaced = new Set(later.filter(([v]) => !ADDITIVE_VERSIONS.includes(Number(v))).flatMap(([, ns]) => ns));
  const added = new Set(later.filter(([v]) => ADDITIVE_VERSIONS.includes(Number(v))).flatMap(([, ns]) => ns));
  const nsOf = (g) => g.slice(0, g.indexOf('.'));
  const cur = (Array.isArray(current) ? current : []).filter((g) => typeof g === 'string');
  const kept = cur.filter((g) => g === '*' || !replaced.has(nsOf(g)));
  const fromTemplate = template.filter((g) => replaced.has(nsOf(g)) || added.has(nsOf(g)));
  const revoked = new Set(Object.entries(REVOKED_GRANTS).filter(([v]) => Number(v) > fromV).flatMap(([, gs]) => gs).filter((g) => !template.includes(g)));
  return [...new Set([...kept, ...fromTemplate])].filter((g) => !revoked.has(g)).sort();
}
