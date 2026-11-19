/**
 * Resolves the full Home context for a signed-in user, step by step:
 *
 *   users/{uid} -> defaultHomeId -> members/{uid} -> homes/{homeId}
 *   -> roles/{roleId} -> permissions (+ settings/general)
 *
 * Membership is read BEFORE the home document on purpose: rules let a user read their own
 * membership document unconditionally, but reading a home requires an ACTIVE membership.
 * Reading membership first lets us report "membership missing/inactive" precisely instead
 * of a generic permission error.
 *
 * defaultHomeId is only a pointer — authorization comes from the membership document.
 *
 * Pure orchestration: the repository is injected so this is unit-testable.
 */
import { AppError, ErrorCode, toAppError } from '../errors/app-error.js';
import { resolvePermissions } from '../permissions/resolver.js';
import { log } from '../utils/logger.js';
import { SYSTEM_ROLE_IDS } from '../permissions/roles.js';
import { DEFAULTS } from '../../config/app-config.js';
import { classifyLegacyHome, normalizeHome, LegacyState } from './legacy-adoption.js';

/**
 * Phase 5.1 — legacy detection, run ONLY when the caller has no membership in their default
 * Home. Uses narrow per-document gets that the rules allow only to the Home's stored creator
 * (no list, no broad reads). Any read that fails means "not provably ours" → NOT_LEGACY, and
 * the caller gets the normal MEMBERSHIP_MISSING failure exactly as before.
 */
export async function detectLegacyHome(uid, profile, homeId, repo) {
  let home = null;
  try { home = await repo.readHome(homeId); } catch { return { state: LegacyState.NOT_LEGACY, reason: 'unreadable' }; }
  if (!home) return { state: LegacyState.NOT_LEGACY, reason: 'missing' };
  if (home.createdBy !== uid) return { state: LegacyState.NOT_LEGACY, reason: 'notCreator' };
  const existingRoleIds = [];
  for (const id of SYSTEM_ROLE_IDS) {
    let role;
    try { role = await repo.readRole(homeId, id); } catch { return { state: LegacyState.BLOCKED, reason: 'rolesUnreadable', home }; }
    if (role) existingRoleIds.push(id);
  }
  const c = classifyLegacyHome({ uid, profile, home: { ...home, id: homeId }, membershipExists: false, existingRoleIds });
  return { ...c, home, existingRoleIds };
}

/** Throws the specific legacy error, or MEMBERSHIP_MISSING when the Home is not provably ours. */
async function missingMembership(uid, profile, homeId, repo) {
  const legacy = await detectLegacyHome(uid, profile, homeId, repo);
  if (legacy.state === LegacyState.ELIGIBLE) {
    const e = new AppError(ErrorCode.LEGACY_HOME_ADOPTION_REQUIRED, { detail: `legacy home (${legacy.reason})` });
    e.adoption = { homeId, homeName: legacy.home.name || null, existingRoleIds: legacy.existingRoleIds };
    return e;
  }
  if (legacy.state === LegacyState.BLOCKED) return new AppError(ErrorCode.LEGACY_HOME_ADOPTION_BLOCKED, { detail: legacy.reason });
  return new AppError(ErrorCode.MEMBERSHIP_MISSING, { detail: 'no membership in default home' });
}
const HOME_DEFAULTS = { homeName: 'HomeHub', currency: DEFAULTS.currency, timezone: DEFAULTS.timezone, language: DEFAULTS.language };

export const ContextResult = Object.freeze({ SETUP: 'SETUP', READY: 'READY' });

async function step(detail, fn) {
  try {
    return await fn();
  } catch (err) {
    const e = toAppError(err);
    if (!e.detail) e.detail = detail;
    throw e;
  }
}

export async function resolveHomeContext(identity, repo) {
  const { uid } = identity;

  const profile = await step('read profile', () => repo.readProfile(uid));
  if (!profile) {
    log.info('No profile yet — first-time setup required');
    return { kind: ContextResult.SETUP, profile: null };
  }
  log.info('Profile resolved');

  try {
    return await resolveFromProfile(uid, profile, repo);
  } catch (err) {
    // Keep the profile with the error: recovery ("create a new home") must UPDATE the
    // existing users/{uid} document rather than try to create it again.
    const e = toAppError(err);
    e.profile = profile;
    throw e;
  }
}

async function resolveFromProfile(uid, profile, repo) {
  const homeId = profile.defaultHomeId;
  if (typeof homeId !== 'string' || !homeId) {
    throw new AppError(ErrorCode.DEFAULT_HOME_MISSING, { detail: 'profile has no defaultHomeId' });
  }

  const membership = await step('read membership', () => repo.readMembership(homeId, uid));
  if (!membership) throw await missingMembership(uid, profile, homeId, repo);
  if (membership.status !== 'active') {
    throw new AppError(ErrorCode.MEMBERSHIP_INACTIVE, { detail: `membership status ${membership.status}` });
  }

  // Older Home documents may lack fields the current UI needs: in-memory defaults only.
  const home = normalizeHome(await step('read home', () => repo.readHome(homeId)), HOME_DEFAULTS);
  if (!home) throw new AppError(ErrorCode.HOME_NOT_FOUND);
  log.info('Home resolved');
  log.info('Membership verified');

  if (typeof membership.roleId !== 'string' || !membership.roleId) {
    throw new AppError(ErrorCode.ROLE_MISSING, { detail: 'membership has no roleId' });
  }
  const role = await step('read role', () => repo.readRole(homeId, membership.roleId));
  if (!role) throw new AppError(ErrorCode.ROLE_MISSING, { detail: `role ${membership.roleId} not found` });
  log.info('Role resolved', `(${role.id})`);

  const permissions = resolvePermissions({ membership, role });
  if (permissions.isEmpty) throw new AppError(ErrorCode.PERMISSION_DENIED, { detail: 'role grants nothing' });

  const homeSettings = await step('read settings', () => repo.readGeneralSettings(homeId));

  return { kind: ContextResult.READY, profile, home, membership, role, permissions, homeSettings };
}
