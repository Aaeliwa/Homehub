/**
 * Family store — ONE per context scope (uid + homeId). PURE (repository injected).
 *
 * Provides the shared MEMBER DIRECTORY (uid → name/role/status) that Finance, Rooms,
 * Devices and later modules use to render "Added by …" without per-row reads, plus invite
 * management and member actions. Listeners: members (if members.view) + invites
 * (if members.invite). All stop on dispose.
 */
import { AppError, ErrorCode } from '../errors/app-error.js';
import { createDirectory, familySummary, normalizeMember } from './member-model.js';
import { buildInvite, generateCode } from './invite-model.js';

export function createFamilyStore({ homeId, uid, selfName, repo, randomBytes, nowMillis = () => Date.now() }) {
  if (!homeId || !uid) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  let members = []; let invites = [];
  let mStatus = 'idle'; let iStatus = 'idle';
  let stopM = null; let stopI = null;
  let disposed = false; let lastError = null;
  const listeners = new Set();
  let cache = null;

  const emit = () => { cache = null; for (const fn of [...listeners]) fn(snapshot()); };
  const guard = () => { if (disposed) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE); };

  function snapshot() {
    if (cache) return cache;
    const st = [mStatus, iStatus].filter((s) => s !== 'idle');
    cache = Object.freeze({
      status: !st.length ? 'idle' : st.includes('error') ? 'error' : st.every((s) => s === 'ready') ? 'ready' : 'loading',
      error: lastError,
      members: members.map(normalizeMember),
      invites,
      directory: createDirectory(members, { selfUid: uid, selfName }),
    });
    return cache;
  }

  const api = {
    homeId,
    /** Start the listeners the member's permissions allow. */
    ensure({ canViewMembers, canInvite }) {
      guard();
      if (canViewMembers && !stopM) { mStatus = 'loading'; stopM = repo.watchMembers(homeId, (d) => { members = d; mStatus = 'ready'; emit(); }, (e) => { mStatus = 'error'; lastError = e; emit(); }); }
      if (!canViewMembers && stopM) { stopM(); stopM = null; members = []; mStatus = 'idle'; emit(); }
      if (canInvite && !stopI) { iStatus = 'loading'; stopI = repo.watchInvites(homeId, (d) => { invites = d; iStatus = 'ready'; emit(); }, (e) => { iStatus = 'error'; lastError = e; emit(); }); }
      if (!canInvite && stopI) { stopI(); stopI = null; invites = []; iStatus = 'idle'; emit(); }
    },
    subscribe(fn) { guard(); listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
    getSnapshot: snapshot,
    directory: () => snapshot().directory,
    listenerCount: () => (stopM ? 1 : 0) + (stopI ? 1 : 0),
    summary: () => familySummary(members, invites, nowMillis()),
    pendingInvites: () => invites.filter((i) => i.status === 'pending' && i.expiresAtMillis > nowMillis())
      .sort((a, b) => b.expiresAtMillis - a.expiresAtMillis),

    async createInvite({ home, type, guardianUids, ttlDays }) {
      guard();
      const code = generateCode(randomBytes);
      const data = buildInvite({ home, uid, type, guardianUids, ttlDays, nowMillis: nowMillis(), now: repo.now() });
      await repo.commit([{ mode: 'set', path: ['invites', code], data }]);
      return code;
    },
    async cancelInvite(code) {
      guard();
      await repo.commit([{ mode: 'update', path: ['invites', code], data: { status: 'cancelled', cancelledBy: uid, cancelledAt: repo.now() } }]);
    },
    async changeRole(targetUid, roleId) {
      guard();
      if (targetUid === uid) throw new AppError(ErrorCode.PERMISSION_DENIED, { detail: 'self role change' });
      await repo.commit([{ mode: 'update', path: ['homes', homeId, 'members', targetUid], data: { roleId, updatedAt: repo.now() } }]);
    },
    /** status: 'active' | 'suspended' | 'removed'. Nothing is deleted; history keeps createdBy. */
    async setStatus(targetUid, status) {
      guard();
      if (targetUid === uid) throw new AppError(ErrorCode.PERMISSION_DENIED, { detail: 'self status change' });
      if (!['active', 'suspended', 'removed'].includes(status)) throw new AppError(ErrorCode.VALIDATION, { detail: 'status' });
      await repo.commit([{ mode: 'update', path: ['homes', homeId, 'members', targetUid], data: { status, updatedAt: repo.now() } }]);
    },
    async setGuardians(childUid, guardianUids) {
      guard();
      const g = [...new Set(guardianUids)].sort();
      if (g.length < 1 || g.length > 5) throw new AppError(ErrorCode.VALIDATION, { detail: 'family.validation.guardians' });
      await repo.commit([{ mode: 'update', path: ['homes', homeId, 'members', childUid], data: { guardianUids: g, updatedAt: repo.now() } }]);
    },
    /** A non-owner member leaves this home (their history stays; their private wallets stay private). */
    async leave() {
      guard();
      await repo.commit([{ mode: 'update', path: ['homes', homeId, 'members', uid], data: { status: 'left', updatedAt: repo.now() } }]);
    },

    dispose() {
      disposed = true;
      if (stopM) stopM(); if (stopI) stopI();
      stopM = null; stopI = null; listeners.clear(); members = []; invites = []; cache = null;
    },
  };
  return Object.freeze(api);
}
