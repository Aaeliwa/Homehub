/**
 * getFamilyStore(ctx): the scope-bound family store for the CURRENT Home (shared by the
 * Family page, Settings, Dashboard and Finance's member directory).
 */
import { AppError, ErrorCode } from '../errors/app-error.js';
import { createFamilyStore } from './family-store.js';
import { familyRepository } from './family-repository.js';
import { secureRandomBytes } from './invite-model.js';

export function getFamilyStore(ctx) {
  const scope = ctx && ctx.scope;
  const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  const store = scope.resource('family', (s) => createFamilyStore({
    homeId: s.homeId, uid: s.uid, selfName: state.profile && state.profile.displayName, repo: familyRepository, randomBytes: secureRandomBytes,
  }));
  store.ensure({ canViewMembers: state.permissions.can('members.view'), canInvite: state.permissions.can('members.invite') });
  return store;
}
