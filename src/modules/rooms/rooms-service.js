/**
 * Entry point other code uses to reach Rooms: returns the scope-bound store for the
 * CURRENT Home. Fails safely (CONTEXT_UNAVAILABLE) when no Home context exists.
 *
 * Future modules (Devices, Cleaning, Maintenance) resolve room ids through this, e.g.
 * getRoomsStore(ctx).get(roomId) — archived rooms stay resolvable.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { createRoomsStore } from './rooms-store.js';
import { roomRepository } from './room-repository.js';

export function getRoomsStore(ctx) {
  const scope = ctx && ctx.scope;
  const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) {
    throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  }
  return scope.resource('rooms', (s) => createRoomsStore({ homeId: s.homeId, uid: s.uid, repo: roomRepository }));
}
