/** getInventoryStore(ctx): the scope-bound Pantry store for the CURRENT Home (disposed on Home switch / sign-out). */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { createInventoryStore } from './inventory-store.js';
import { inventoryRepository } from './inventory-repository.js';

export function getInventoryStore(ctx) {
  const scope = ctx && ctx.scope; const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  return scope.resource('inventory', (s) => createInventoryStore({ homeId: s.homeId, uid: s.uid, repo: inventoryRepository, canView: state.permissions.can('inventory.view') }));
}
