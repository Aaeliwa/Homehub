/** getChefStore(ctx): the scope-bound chef store for the CURRENT Home (disposed on Home switch / sign-out). */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { createChefStore } from './chef-store.js';
import { chefRepository } from './chef-repository.js';

export function getChefStore(ctx) {
  const scope = ctx && ctx.scope; const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  return scope.resource('chef', (s) => createChefStore({ homeId: s.homeId, uid: s.uid, repo: chefRepository, canViewRecipes: state.permissions.can('chef.view') }));
}
