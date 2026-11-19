/**
 * Rooms live store — ONE per context scope (uid + homeId). PURE: the repository is
 * injected, so this is unit-tested in Node with a fake.
 *
 * - The Firestore listener starts on the first subscribe() and lives until the scope is
 *   disposed (sign-out, context error, Home change). Page and Dashboard widget share it.
 * - All writes go to homes/{this.homeId}/rooms/… — the homeId is fixed at creation and
 *   never taken from a caller. After dispose(), every action fails with CONTEXT_UNAVAILABLE.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import {
  sortRooms, activeRooms, archivedRooms, summarizeRooms, nextSortOrder, computeMove,
  buildRoomCreate, buildRoomEdit, buildRoomArchive, buildRoomRestore, buildRoomOrder,
} from './room-model.js';

const EMPTY = Object.freeze({ status: 'idle', rooms: Object.freeze([]), error: null });

export function createRoomsStore({ homeId, uid, repo }) {
  if (!homeId || !uid) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  let snapshot = EMPTY;
  let stop = null;
  let disposed = false;
  const listeners = new Set();

  function emit() {
    for (const fn of [...listeners]) fn(snapshot);
  }

  function start() {
    if (stop || disposed) return;
    snapshot = Object.freeze({ ...snapshot, status: 'loading' });
    stop = repo.watchRooms(homeId,
      (rooms) => { snapshot = Object.freeze({ status: 'ready', rooms: Object.freeze(sortRooms(rooms)), error: null }); emit(); },
      (error) => { snapshot = Object.freeze({ ...snapshot, status: 'error', error }); emit(); });
  }

  function guard() {
    if (disposed) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  }

  function find(roomId) {
    const room = snapshot.rooms.find((r) => r.id === roomId);
    if (!room) throw new AppError(ErrorCode.VALIDATION, { detail: 'unknown room' });
    return room;
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
    active: () => activeRooms(snapshot.rooms),
    archived: () => archivedRooms(snapshot.rooms),
    /** Dashboard contract: { activeCount, archivedCount }. */
    summary: () => summarizeRooms(snapshot.rooms),
    get: (roomId) => snapshot.rooms.find((r) => r.id === roomId) || null,

    async create(input) {
      guard();
      const data = buildRoomCreate({ input, uid, sortOrder: nextSortOrder(snapshot.rooms), now: repo.now() });
      return repo.create(homeId, data);
    },

    /**
     * Writes only the fields the user changed compared with `base` — the room as it was
     * when the form opened. Someone else's concurrent change to another field survives.
     * Returns false when nothing changed (no write).
     */
    async update(roomId, input, base) {
      guard();
      const current = find(roomId);
      if (current.active !== true) throw new AppError(ErrorCode.VALIDATION, { detail: 'archived rooms are read-only' });
      const patch = buildRoomEdit({ original: base || current, input, uid, now: repo.now() });
      if (!patch) return false;
      await repo.patch(homeId, roomId, patch);
      return true;
    },

    async archive(roomId) {
      guard();
      if (find(roomId).active !== true) return;
      await repo.patch(homeId, roomId, buildRoomArchive({ uid, now: repo.now() }));
    },

    async restore(roomId) {
      guard();
      if (find(roomId).active !== false) return;
      await repo.patch(homeId, roomId, buildRoomRestore({ uid, now: repo.now(), sortOrder: nextSortOrder(snapshot.rooms) }));
    },

    /** Move up/down. All affected rooms are renumbered in ONE atomic batch. */
    async move(roomId, direction) {
      guard();
      const changes = computeMove(snapshot.rooms, roomId, direction);
      if (!changes.length) return false;
      const now = repo.now();
      await repo.patchMany(homeId, changes.map((c) => ({ id: c.id, patch: buildRoomOrder({ uid, now, sortOrder: c.sortOrder }) })));
      return true;
    },

    dispose() {
      disposed = true;
      if (stop) stop();
      stop = null;
      listeners.clear();
      snapshot = EMPTY;
    },
  });
}
