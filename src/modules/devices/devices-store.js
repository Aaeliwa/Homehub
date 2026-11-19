/**
 * Devices live store — ONE per context scope (uid + homeId). PURE: repository and the
 * rooms interface are injected, so it is unit-tested in Node with fakes.
 *
 * - One Firestore listener for homes/{homeId}/devices, shared by the Devices page, the
 *   Dashboard widget and Room detail. Started on first subscribe, stopped on dispose.
 * - Rooms are NOT read here: the store consumes the shared Phase 2 rooms store
 *   (`rooms.get(id)`, `rooms.active()`), so there is no second rooms listener.
 * - Writes always target this store's homeId; after dispose every action fails with
 *   CONTEXT_UNAVAILABLE.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import {
  activeDevices, archivedDevices, devicesByRoom, devicesByCategory, devicesByStatus,
  filterDevices, sortDevices, summarizeDevices, validateDeviceInput, checkRoomAssignment,
  buildDeviceCreate, buildDeviceEdit, buildDeviceArchive, buildDeviceRestore,
} from './device-model.js';

const EMPTY = Object.freeze({ status: 'idle', devices: Object.freeze([]), error: null });

export function createDevicesStore({ homeId, uid, repo, rooms }) {
  if (!homeId || !uid) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  let snapshot = EMPTY;
  let stop = null;
  let stopRooms = null;
  let disposed = false;
  const listeners = new Set();
  /** Non-persistent UI hint (e.g. Room detail → "show this room's devices"). */
  let pendingFilter = null;

  const emit = () => { for (const fn of [...listeners]) fn(snapshot); };

  function start() {
    if (stop || disposed) return;
    // Keep the shared rooms store loaded (labels + assignment checks). Shared listener.
    if (rooms && rooms.subscribe) stopRooms = rooms.subscribe(() => emit());
    snapshot = Object.freeze({ ...snapshot, status: 'loading' });
    stop = repo.watchDevices(homeId,
      (devices) => { snapshot = Object.freeze({ status: 'ready', devices: Object.freeze(devices), error: null }); emit(); },
      (error) => { snapshot = Object.freeze({ ...snapshot, status: 'error', error }); emit(); });
  }

  function guard() { if (disposed) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE); }
  function find(id) {
    const d = snapshot.devices.find((x) => x.id === id);
    if (!d) throw new AppError(ErrorCode.VALIDATION, { detail: 'device not found' });
    return d;
  }
  const getRoom = (id) => (rooms ? rooms.get(id) : null);

  function assertRoom(input, previousRoomId) {
    const { value } = validateDeviceInput(input);
    const err = checkRoomAssignment({ roomId: value.roomId, previousRoomId, getRoom });
    if (err) throw new AppError(ErrorCode.VALIDATION, { detail: err });
  }

  return Object.freeze({
    homeId,
    subscribe(fn) {
      guard();
      listeners.add(fn);
      start();
      fn(snapshot);
      return () => listeners.delete(fn);
    },
    getSnapshot: () => snapshot,
    all: () => snapshot.devices,
    get: (id) => snapshot.devices.find((d) => d.id === id) || null,
    active: () => activeDevices(snapshot.devices),
    archived: () => archivedDevices(snapshot.devices),
    byRoom: () => devicesByRoom(activeDevices(snapshot.devices)),
    byCategory: () => devicesByCategory(activeDevices(snapshot.devices)),
    byStatus: () => devicesByStatus(activeDevices(snapshot.devices)),
    needsAttention: () => activeDevices(snapshot.devices).filter((d) => d.status === 'needs_attention'),
    /** Devices currently pointing at a room (active devices only). */
    inRoom: (roomId) => activeDevices(snapshot.devices).filter((d) => d.roomId === roomId),
    query: (filter, sort, opts) => sortDevices(filterDevices(snapshot.devices, filter), sort, opts),
    /** Dashboard contract: { activeCount, needsAttentionCount, outOfServiceCount, archivedCount }. */
    summary: () => summarizeDevices(snapshot.devices),

    setPendingFilter(f) { pendingFilter = f; },
    takePendingFilter() { const f = pendingFilter; pendingFilter = null; return f; },

    async create(input) {
      guard();
      assertRoom(input, undefined);
      return repo.create(homeId, buildDeviceCreate({ input, uid, now: repo.now() }));
    },

    /** Field-level patch against `base` (what the form showed). Archived devices are read-only. */
    async update(id, input, base) {
      guard();
      const current = find(id);
      if (current.active !== true) throw new AppError(ErrorCode.VALIDATION, { detail: 'archived devices are read-only' });
      assertRoom(input, current.roomId ?? null);
      const patch = buildDeviceEdit({ original: base || current, input, uid, now: repo.now() });
      if (!patch) return false;
      await repo.patch(homeId, id, patch);
      return true;
    },

    async archive(id) {
      guard();
      if (find(id).active !== true) return;
      await repo.patch(homeId, id, buildDeviceArchive({ uid, now: repo.now() }));
    },

    async restore(id) {
      guard();
      if (find(id).active !== false) return;
      await repo.patch(homeId, id, buildDeviceRestore({ uid, now: repo.now() }));
    },

    dispose() {
      disposed = true;
      if (stop) stop();
      if (stopRooms) stopRooms();
      stop = null; stopRooms = null;
      listeners.clear();
      snapshot = EMPTY;
    },
  });
}
