/**
 * Invitations — PURE (no Firebase, no DOM). Unit-tested.
 *
 *   invites/{code}   (top-level: the invitee is not a member yet, so it cannot live under the home)
 *
 * The code IS the secret: 24 symbols from a 30-symbol alphabet without look-alikes
 * (≈117 bits, crypto.getRandomValues). Reading needs the exact code (no listing for
 * outsiders). Acceptance is single-use, expiring, bound to request.auth.uid, and copies
 * role / relationship / guardians FROM the invite — the invitee chooses nothing.
 */
import { AppError, ErrorCode } from '../errors/app-error.js';

export const INVITE_SCHEMA_VERSION = 1;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const CODE_LENGTH = 24;
export const DEFAULT_TTL_DAYS = 7;
export const MAX_TTL_DAYS = 14;
const DAY = 86400000;

/** Member types offered in the UI → role + relationship. */
export const MEMBER_TYPES = Object.freeze({
  adult: { roleId: 'member', relationship: 'adult' },
  admin: { roleId: 'admin', relationship: 'adult' },
  viewer: { roleId: 'viewer', relationship: 'adult' },
  child: { roleId: 'child', relationship: 'child' },
});
export const INVITABLE_ROLES = Object.freeze(['admin', 'member', 'viewer', 'child']);
export const INVITE_STATUSES = Object.freeze(['pending', 'accepted', 'cancelled']);

export function generateCode(randomBytes) {
  // Rejection sampling: only bytes < 240 (= 8 × 30) are used, so every symbol is equally likely.
  let out = '';
  let rounds = 0;
  while (out.length < CODE_LENGTH) {
    if (++rounds > 32) throw new Error('random source unusable'); // never loop forever
    for (const b of randomBytes(CODE_LENGTH)) {
      if (b < 240) out += CODE_ALPHABET[b % 30];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** Browser/Node secure random source (never Math.random). */
export const secureRandomBytes = (n) => {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
};

export const isCode = (v) => typeof v === 'string' && new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(v);
/** Accepts pasted codes with dashes/spaces/lower case. */
export const normalizeCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (c) => (c.match(/.{1,4}/g) || []).join('-');

/**
 * State of an invite as seen by someone who wants to accept it.
 * 'ok' | 'invalid' | 'expired' | 'used' | 'cancelled' | 'alreadyMember'
 */
export function inviteState(invite, { nowMillis, isMemberOfHome = false }) {
  if (!invite) return 'invalid';
  if (invite.status === 'accepted') return 'used';
  if (invite.status === 'cancelled') return 'cancelled';
  if (invite.status !== 'pending') return 'invalid';
  if (!(Number.isInteger(invite.expiresAtMillis) && nowMillis < invite.expiresAtMillis)) return 'expired';
  if (isMemberOfHome) return 'alreadyMember';
  return 'ok';
}

/** Ranks gate who may invite which role (mirrors the rules): owner → any non-owner; others → below own rank. */
export function canInviteRole({ myRoleId, myRank, targetRank, targetRoleId }) {
  if (!INVITABLE_ROLES.includes(targetRoleId)) return false;
  if (myRoleId === 'owner') return true;
  return Number.isInteger(myRank) && Number.isInteger(targetRank) && targetRank < myRank;
}

export function buildInvite({ home, uid, type, guardianUids = [], nowMillis, ttlDays = DEFAULT_TTL_DAYS, now }) {
  const t = MEMBER_TYPES[type];
  if (!t) throw new AppError(ErrorCode.VALIDATION, { detail: 'family.validation.type' });
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_TTL_DAYS) throw new AppError(ErrorCode.VALIDATION, { detail: 'family.validation.ttl' });
  const guardians = t.relationship === 'child' ? [...new Set(guardianUids.filter(Boolean))].sort() : [];
  if (t.relationship === 'child' && (guardians.length < 1 || guardians.length > 5)) throw new AppError(ErrorCode.VALIDATION, { detail: 'family.validation.guardians' });
  return {
    homeId: home.id, homeName: home.name, roleId: t.roleId, relationship: t.relationship, guardianUids: guardians,
    status: 'pending', createdBy: uid, createdAt: now, expiresAtMillis: nowMillis + ttlDays * DAY,
    acceptedBy: null, acceptedAt: null, cancelledBy: null, cancelledAt: null, schemaVersion: INVITE_SCHEMA_VERSION,
  };
}

/**
 * Writes for accepting an invite, as ONE batch:
 *   invites/{code}                 pending → accepted (acceptedBy = me)
 *   homes/{h}/members/{me}         created (or re-activated after removed/left) FROM the invite
 *   users/{me}                     created for brand-new accounts; defaultHomeId only when
 *                                  the user has none or explicitly chooses to switch.
 */
export function buildAcceptWrites({ code, invite, identity, displayName, existingMember, profile, makeDefault, now, schemaVersion = 1, language = 'ar', theme = 'system' }) {
  const name = String(displayName || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 60) throw new AppError(ErrorCode.VALIDATION, { detail: 'validation.displayNameRequired' });
  const memberFields = {
    roleId: invite.roleId, status: 'active', relationship: invite.relationship, guardianUids: invite.guardianUids || [],
    inviteCode: code, joinedAt: now, updatedAt: now, displayName: name,
  };
  const writes = [{ mode: 'update', path: ['invites', code], data: { status: 'accepted', acceptedBy: identity.uid, acceptedAt: now } }];
  if (existingMember) {
    writes.push({ mode: 'update', path: ['homes', invite.homeId, 'members', identity.uid], data: memberFields });
  } else {
    writes.push({ mode: 'set', path: ['homes', invite.homeId, 'members', identity.uid], data: {
      uid: identity.uid, email: identity.email, addedBy: invite.createdBy, createdAt: now, ...memberFields } });
  }
  if (!profile) {
    writes.push({ mode: 'set', path: ['users', identity.uid], data: {
      email: identity.email, displayName: name, defaultHomeId: invite.homeId, language, theme, schemaVersion, createdAt: now, updatedAt: now } });
  } else if (makeDefault || !profile.defaultHomeId) {
    writes.push({ mode: 'update', path: ['users', identity.uid], data: { defaultHomeId: invite.homeId, updatedAt: now } });
  }
  return writes;
}
