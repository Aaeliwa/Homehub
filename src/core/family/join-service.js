/**
 * Joining a home by invitation — orchestration, PURE (repository injected).
 * Reads the invite by code, classifies it, and commits the single acceptance batch.
 */
import { AppError, ErrorCode } from '../errors/app-error.js';
import { inviteState, isCode, normalizeCode, buildAcceptWrites } from './invite-model.js';

export async function loadInvite(repo, rawCode, { uid, nowMillis }) {
  const code = normalizeCode(rawCode);
  if (!isCode(code)) return { code, invite: null, state: 'invalid', member: null };
  let invite = null;
  try { invite = await repo.readInvite(code); } catch { invite = null; }
  if (!invite) return { code, invite: null, state: 'invalid', member: null };
  let member = null;
  try { member = await repo.readMember(invite.homeId, uid); } catch { member = null; }
  const isMemberOfHome = !!member && (member.status === 'active' || member.status === 'suspended');
  return { code, invite, member, state: inviteState(invite, { nowMillis, isMemberOfHome }) };
}

export async function acceptInvite(repo, { code: rawCode, identity, displayName, profile, makeDefault, nowMillis, language, theme }) {
  const loaded = await loadInvite(repo, rawCode, { uid: identity.uid, nowMillis });
  if (loaded.state !== 'ok') throw new AppError(ErrorCode.VALIDATION, { detail: `family.invite.state.${loaded.state}` });
  const writes = buildAcceptWrites({
    code: loaded.code, invite: loaded.invite, identity, displayName, existingMember: loaded.member,
    profile, makeDefault, now: repo.now(), language, theme,
  });
  await repo.commit(writes);
  return { homeId: loaded.invite.homeId, homeName: loaded.invite.homeName, switched: !profile || makeDefault || !profile.defaultHomeId };
}
