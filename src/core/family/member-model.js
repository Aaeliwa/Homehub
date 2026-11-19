/**
 * Membership helpers — PURE. The authoritative membership is homes/{h}/members/{uid}
 * (Phase 1). Phase 4A adds optional fields: relationship ('adult'|'child'),
 * guardianUids (children), inviteCode, and statuses 'removed' / 'left'.
 * Older documents without these fields are read with safe defaults.
 */
export const MEMBER_STATUSES = Object.freeze(['active', 'suspended', 'removed', 'left']);

export function normalizeMember(m) {
  if (!m) return null;
  return {
    ...m,
    uid: m.uid || m.id,
    displayName: (m.displayName || '').trim(),
    relationship: m.relationship === 'child' || m.roleId === 'child' ? 'child' : 'adult',
    guardianUids: Array.isArray(m.guardianUids) ? m.guardianUids : [],
    status: MEMBER_STATUSES.includes(m.status) ? m.status : 'active',
  };
}

export const isActive = (m) => !!m && m.status === 'active';

/**
 * Member directory: uid → member (all statuses, so history from people who left still
 * resolves). `nameOf` never returns undefined.
 */
export function createDirectory(members, { selfUid, selfName } = {}) {
  const map = new Map();
  for (const raw of members) { const m = normalizeMember(raw); if (m) map.set(m.uid, m); }
  return Object.freeze({
    get: (uid) => map.get(uid) || null,
    all: () => [...map.values()],
    active: () => [...map.values()].filter(isActive),
    nameOf(uid, fallbackKey) {
      if (!uid) return fallbackKey || '';
      const m = map.get(uid);
      if (m && m.displayName) return m.displayName;
      if (uid === selfUid && selfName) return selfName;
      return fallbackKey || '';
    },
    guardiansOf: (childUid) => (map.get(childUid) || { guardianUids: [] }).guardianUids,
    childrenOf: (guardianUid) => [...map.values()].filter((m) => m.relationship === 'child' && m.guardianUids.includes(guardianUid)),
  });
}

/** Summary for the Family card. */
export function familySummary(members, invites, nowMillis) {
  const ms = members.map(normalizeMember);
  return {
    active: ms.filter(isActive).length,
    children: ms.filter((m) => isActive(m) && m.relationship === 'child').length,
    pendingInvites: invites.filter((i) => i.status === 'pending' && i.expiresAtMillis > nowMillis).length,
  };
}

/**
 * Who may do what to `target` (mirrors firestore.rules; UI uses it to offer actions):
 *  - nobody acts on themselves except "leave" (non-owners);
 *  - the owner is never demoted, removed or suspended (single-owner protection);
 *  - managers act only on members ranked below them (owner: everyone but themselves).
 */
export function memberActions({ me, myRank, target, targetRank, can }) {
  const self = me.uid === target.uid;
  const owner = target.roleId === 'owner';
  const below = me.roleId === 'owner' || (Number.isInteger(myRank) && Number.isInteger(targetRank) && targetRank < myRank);
  const live = target.status === 'active' || target.status === 'suspended';
  return {
    leave: self && !owner && target.status === 'active',
    changeRole: !self && !owner && live && below && can('members.edit'),
    suspend: !self && !owner && target.status === 'active' && below && can('members.edit'),
    reactivate: !self && !owner && target.status === 'suspended' && below && can('members.edit'),
    remove: !self && !owner && live && below && can('members.remove'),
    guardians: !self && target.relationship === 'child' && live && can('members.manageChildren'),
  };
}

/** Roles a manager may assign (below own rank; owner: any except owner). */
export function assignableRoles(roles, { myRoleId, myRank }) {
  return roles.filter((r) => r.id !== 'owner' && (myRoleId === 'owner' || r.rank < myRank));
}
