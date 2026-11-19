/**
 * getDevicesStore(ctx): the scope-bound Devices store for the CURRENT Home.
 * Reuses the shared Rooms store (one rooms listener per Home for every consumer).
 * Fails safely with CONTEXT_UNAVAILABLE when there is no matching Home context.
 *
 * Future modules (Cleaning, Maintenance) resolve devices by id with
 * getDevicesStore(ctx).get(deviceId) — archived devices included.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { createDevicesStore } from './devices-store.js';
import { deviceRepository } from './device-repository.js';
import { getRoomsStore } from '../rooms/rooms-service.js';

export function getDevicesStore(ctx) {
  const scope = ctx && ctx.scope;
  const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) {
    throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  }
  return scope.resource('devices', (s) => createDevicesStore({
    homeId: s.homeId, uid: s.uid, repo: deviceRepository, rooms: getRoomsStore(ctx),
  }));
}
