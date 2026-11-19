/**
 * Phase 5.1 — performs the one-time legacy Home adoption. Re-detects FRESH state right before
 * writing (never trusts a stale screen), then commits ONE atomic batch. The rules re-prove every
 * condition server-side; a lost race (e.g. roles appeared meanwhile) fails safely.
 *
 * PURE orchestration: repository, atomic writer and timestamp are injected (main.js wires the
 * Firestore implementations lazily), so this is unit-testable and keeps the SDK off main.js's
 * static import graph.
 */
import { AppError, ErrorCode } from '../errors/app-error.js';
import { detectLegacyHome } from './context-resolver.js';
import { buildAdoptionWrites, LegacyState } from './legacy-adoption.js';
import { defaultRoles } from '../../modules/index.js';

export async function adoptLegacyHome({ identity, profile, repo, write, now }) {
  if (!repo || !write || !now) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  const homeId = profile && profile.defaultHomeId;
  if (!identity || !homeId) throw new AppError(ErrorCode.DEFAULT_HOME_MISSING);
  // Idempotency: an existing membership means adoption already happened (or is not applicable).
  const membership = await repo.readMembership(homeId, identity.uid);
  if (membership) return { adopted: false, reason: 'alreadyMember' };
  const legacy = await detectLegacyHome(identity.uid, profile, homeId, repo);
  if (legacy.state === LegacyState.BLOCKED) throw new AppError(ErrorCode.LEGACY_HOME_ADOPTION_BLOCKED, { detail: legacy.reason });
  if (legacy.state !== LegacyState.ELIGIBLE) throw new AppError(ErrorCode.MEMBERSHIP_MISSING, { detail: `not adoptable (${legacy.reason})` });
  const writes = buildAdoptionWrites({ identity, profile, homeId, existingRoleIds: legacy.existingRoleIds, roles: defaultRoles(), now: now() });
  try {
    await write((w) => { for (const op of writes) w[op.mode](op.path, op.data); });
  } catch (err) {
    // The rules re-prove eligibility; a rejection means it could not be proven safe (e.g. a
    // role or membership appeared meanwhile). Report the specific, recoverable state.
    if (err && (err.code === 'permission-denied' || err.code === ErrorCode.PERMISSION_DENIED)) {
      throw new AppError(ErrorCode.LEGACY_HOME_ADOPTION_BLOCKED, { detail: 'rulesRejected' });
    }
    throw err;
  }
  return { adopted: true, homeId, createdRoles: writes.length - 1 };
}
