/**
 * Legacy Home adoption — PURE (Phase 5.1). Unit-tested.
 *
 * A LEGACY HOME is a Home document created by an older HomeHub version, BEFORE the
 * membership/roles architecture:
 *   - homes/{homeId} exists and its STORED createdBy == the signed-in uid
 *   - users/{uid}.defaultHomeId == homeId
 *   - homes/{homeId}/members/{uid} does not exist
 *   - homes/{homeId}/roles/owner does not exist (under the current rules every Home that has
 *     ANY member also has roles/owner — bootstrap writes both atomically and invitations need
 *     roles — so "no owner role" proves the Home was never initialised)
 *
 * Adoption writes ONE atomic batch: the creator's own active Owner membership + ONLY the
 * MISSING system roles from defaultRoles() (current template). Existing roles — system or
 * custom — are never overwritten (the rules only allow CREATE). The Home document, the
 * profile and all business data are never written.
 */
import { AppError, ErrorCode } from '../errors/app-error.js';
import { paths } from '../firebase/paths.js';
import { OWNER_ROLE_ID } from '../permissions/roles.js';

export const LegacyState = Object.freeze({
  NOT_LEGACY: 'NOT_LEGACY',   // not ours / not readable / unrelated → normal authorization failure
  ELIGIBLE: 'ELIGIBLE',       // safe one-time adoption available
  BLOCKED: 'BLOCKED',         // ours, but cannot be PROVEN safe automatically (e.g. an Owner role exists)
});

/**
 * Classify a Home for adoption (inputs are what the creator can read under the 5.1 rules).
 * existingRoleIds: ids of role documents that exist (from per-id gets; never a list).
 */
export function classifyLegacyHome({ uid, profile, home, membershipExists, existingRoleIds = [] }) {
  if (!uid || !home || !profile) return { state: LegacyState.NOT_LEGACY, reason: 'unreadable' };
  if (home.createdBy !== uid) return { state: LegacyState.NOT_LEGACY, reason: 'notCreator' };
  if (profile.defaultHomeId !== home.id) return { state: LegacyState.NOT_LEGACY, reason: 'notDefaultHome' };
  if (membershipExists) return { state: LegacyState.NOT_LEGACY, reason: 'membershipExists' };
  if (existingRoleIds.includes(OWNER_ROLE_ID)) return { state: LegacyState.BLOCKED, reason: 'ownerRoleExists' };
  return { state: LegacyState.ELIGIBLE, reason: existingRoleIds.length ? 'partialRoles' : 'fresh' };
}

/**
 * The adoption write set. `roles` = defaultRoles() (single source of truth, current template).
 * Only roles whose id is NOT in existingRoleIds are created.
 */
export function buildAdoptionWrites({ identity, profile, homeId, existingRoleIds = [], roles, now }) {
  if (!identity || !identity.uid || !identity.email) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  if (!roles.some((r) => r.id === OWNER_ROLE_ID)) throw new AppError(ErrorCode.UNKNOWN, { detail: 'owner role template missing' });
  const name = String((profile && profile.displayName) || identity.displayName || identity.email.split('@')[0]).replace(/\s+/g, ' ').trim().slice(0, 60) || 'Owner';
  const writes = [{ mode: 'set', path: paths.member(homeId, identity.uid), data: {
    uid: identity.uid, email: identity.email, displayName: name, roleId: OWNER_ROLE_ID, status: 'active',
    addedBy: identity.uid, joinedAt: now, createdAt: now, updatedAt: now, legacyAdoption: true,
  } }];
  for (const role of roles) {
    if (existingRoleIds.includes(role.id)) continue; // never overwrite (system or custom)
    writes.push({ mode: 'set', path: paths.role(homeId, role.id), data: {
      name: role.name, rank: role.rank, permissions: role.permissions, system: role.system,
      templateVersion: role.templateVersion, createdAt: now, updatedAt: now,
    } });
  }
  return writes;
}

/**
 * Read-only defaults for Home documents written by older versions: fields the current UI
 * needs get safe IN-MEMORY defaults. The stored document is never modified.
 */
export function normalizeHome(home, defaults) {
  if (!home) return home;
  const missing = ['name', 'currency', 'timezone', 'language'].filter((k) => typeof home[k] !== 'string' || !home[k]);
  if (!missing.length) return home;
  return { ...home, name: home.name || defaults.homeName, currency: home.currency || defaults.currency,
    timezone: home.timezone || defaults.timezone, language: home.language || defaults.language, legacyMissingFields: missing };
}
