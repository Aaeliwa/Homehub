/**
 * getFinanceStore(ctx): the scope-bound finance store for the CURRENT Home, with listeners
 * matched to the member's current permissions. Fails safely without a Home context.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { createFinanceStore } from './finance-store.js';
import { financeRepository } from './finance-repository.js';

export function getFinanceStore(ctx) {
  const scope = ctx && ctx.scope;
  const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) {
    throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  }
  const store = scope.resource('finance', (s) => createFinanceStore({ homeId: s.homeId, uid: s.uid, repo: financeRepository, homeCurrency: state.home.currency }));
  store.ensure({ canViewHousehold: state.permissions.can('expenses.view') });
  return store;
}
