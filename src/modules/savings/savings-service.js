/** getSavingsStore(ctx): scope-bound Life Savings store for the CURRENT Home. */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { createSavingsStore } from './savings-store.js';
import { savingsRepository } from './savings-repository.js';

export function getSavingsStore(ctx) {
  const scope = ctx && ctx.scope;
  const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  const store = scope.resource('savings', (s) => createSavingsStore({ homeId: s.homeId, uid: s.uid, repo: savingsRepository, homeCurrency: state.home.currency }));
  store.ensure({ canViewHousehold: state.permissions.can('savings.view') });
  return store;
}
