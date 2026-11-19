import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRoomInput, sortRooms, activeRooms, archivedRooms, summarizeRooms, nextSortOrder, computeMove,
  buildRoomCreate, buildRoomEdit, buildRoomArchive, buildRoomRestore, buildRoomOrder,
  iconFor, defaultIconForType, ROOM_TYPE_IDS, ROOM_ICONS, ROOM_TYPES, ROOM_LIMITS,
} from '../../src/modules/rooms/room-model.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';

const room = (id, extra = {}) => ({ id, name: id, type: 'other', icon: 'home', sortOrder: 1, active: true, ...extra });

test('room types: the 16 required machine ids, each with a known default icon', () => {
  assert.deepEqual(ROOM_TYPE_IDS, ['living_room', 'bedroom', 'master_bedroom', 'kids_room', 'kitchen', 'bathroom', 'dining_room',
    'office', 'balcony', 'laundry', 'storage', 'garage', 'garden', 'hallway', 'entrance', 'other']);
  for (const t of ROOM_TYPES) assert.ok(ROOM_ICONS[t.icon], t.id);
});

test('validation: trims/normalises, requires name, rejects bad type, length limits', () => {
  const ok = validateRoomInput({ name: '  Main   Kitchen ', type: 'kitchen', icon: '', floor: '  ', notes: ' hi ' });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value, { name: 'Main Kitchen', type: 'kitchen', icon: 'kitchen', floor: null, notes: 'hi' });
  assert.ok(validateRoomInput({ name: '   ', type: 'kitchen' }).errors.name);
  assert.ok(validateRoomInput({ name: 'x'.repeat(61), type: 'kitchen' }).errors.name);
  assert.ok(validateRoomInput({ name: 'A', type: 'Kitchen' }).errors.type, 'display strings are not types');
  assert.ok(validateRoomInput({ name: 'A', type: 'spaceship' }).errors.type);
  assert.ok(validateRoomInput({ name: 'A', type: 'other', icon: '<img>' }).errors.icon);
  assert.ok(validateRoomInput({ name: 'A', type: 'other', floor: 'f'.repeat(41) }).errors.floor);
  assert.ok(validateRoomInput({ name: 'A', type: 'other', notes: 'n'.repeat(501) }).errors.notes);
});

test('custom name is independent of type', () => {
  assert.deepEqual(validateRoomInput({ name: 'Main Kitchen', type: 'kitchen' }).value.name, 'Main Kitchen');
});

test('icon fallback: unknown icon -> type icon -> house', () => {
  assert.equal(iconFor({ icon: 'bed' }), ROOM_ICONS.bed);
  assert.equal(iconFor({ icon: 'future_icon', type: 'kitchen' }), ROOM_ICONS.kitchen);
  assert.equal(iconFor({ icon: undefined, type: 'nope' }), ROOM_ICONS.home);
  assert.equal(iconFor(null), ROOM_ICONS.home);
  assert.equal(defaultIconForType('unknown'), 'home');
});

test('deterministic ordering: sortOrder, then name, then id; invalid sortOrder last', () => {
  const rooms = [room('c', { sortOrder: 2 }), room('b', { sortOrder: 1, name: 'Zed' }), room('a', { sortOrder: 1, name: 'Alpha' }),
    room('x', { sortOrder: NaN }), room('d', { sortOrder: 1, name: 'Alpha' })];
  assert.deepEqual(sortRooms(rooms).map((r) => r.id), ['a', 'd', 'b', 'c', 'x']);
});

test('active/archived filtering and dashboard summary', () => {
  const rooms = [room('a'), room('b', { active: false }), room('c'), room('d', { active: false })];
  assert.deepEqual(activeRooms(rooms).map((r) => r.id), ['a', 'c']);
  assert.deepEqual(archivedRooms(rooms).map((r) => r.id), ['b', 'd']);
  assert.deepEqual({ ...summarizeRooms(rooms) }, { activeCount: 2, archivedCount: 2 });
  assert.deepEqual({ ...summarizeRooms([]) }, { activeCount: 0, archivedCount: 0 });
});

test('nextSortOrder counts archived rooms too and starts at 1', () => {
  assert.equal(nextSortOrder([]), 1);
  assert.equal(nextSortOrder([room('a', { sortOrder: 3 }), room('b', { sortOrder: 7, active: false })]), 8);
});

test('computeMove renumbers minimally and repairs duplicates; edges are no-ops', () => {
  const rooms = [room('a', { sortOrder: 1 }), room('b', { sortOrder: 2 }), room('c', { sortOrder: 3 })];
  assert.deepEqual(computeMove(rooms, 'c', 'up').sort((x, y) => x.id.localeCompare(y.id)), [{ id: 'b', sortOrder: 3 }, { id: 'c', sortOrder: 2 }]);
  assert.deepEqual(computeMove(rooms, 'a', 'up'), []);
  assert.deepEqual(computeMove(rooms, 'c', 'down'), []);
  assert.deepEqual(computeMove(rooms, 'zz', 'up'), []);
  const dupes = [room('a', { sortOrder: 5 }), room('b', { sortOrder: 5 }), room('c', { sortOrder: 5 })];
  const changes = computeMove(dupes, 'c', 'up');
  const after = Object.fromEntries(dupes.map((r) => [r.id, r.sortOrder]));
  for (const c of changes) after[c.id] = c.sortOrder;
  assert.deepEqual(after, { a: 1, c: 2, b: 3 }, 'duplicates repaired to 1..n in new order');
  assert.deepEqual(computeMove([...rooms, room('z', { sortOrder: 0, active: false })], 'b', 'up').map((c) => c.id).sort(), ['a', 'b'], 'archived rooms untouched');
});

test('create shape = exactly the keys the rules require; createdBy = uid; no device arrays', () => {
  const d = buildRoomCreate({ input: { name: 'Kitchen', type: 'kitchen' }, uid: 'U1', sortOrder: 1, now: 'NOW' });
  assert.deepEqual(Object.keys(d).sort(), ['active', 'archivedAt', 'archivedBy', 'createdAt', 'createdBy', 'floor', 'icon', 'name',
    'notes', 'schemaVersion', 'sortOrder', 'type', 'updatedAt', 'updatedBy']);
  assert.equal(d.createdBy, 'U1');
  assert.equal(d.active, true);
  assert.equal(d.schemaVersion, 1);
  assert.ok(!('devices' in d) && !('homeId' in d));
  assert.throws(() => buildRoomCreate({ input: { name: '', type: 'kitchen' }, uid: 'U1', sortOrder: 1, now: 'N' }), (e) => e.code === ErrorCode.VALIDATION);
  assert.throws(() => buildRoomCreate({ input: { name: 'A', type: 'kitchen' }, uid: 'U1', sortOrder: 1.5, now: 'N' }));
  assert.throws(() => buildRoomCreate({ input: { name: 'A', type: 'kitchen' }, uid: 'U1', sortOrder: ROOM_LIMITS.maxSortOrder + 1, now: 'N' }));
});

test('edit patch contains only changed fields and never createdBy/createdAt/active', () => {
  const original = { name: 'Bedroom', type: 'bedroom', icon: 'bed', floor: null, notes: null };
  assert.equal(buildRoomEdit({ original, input: { ...original }, uid: 'U', now: 'N' }), null);
  const p = buildRoomEdit({ original, input: { ...original, name: 'Guest room', floor: 'First floor' }, uid: 'U', now: 'N' });
  assert.deepEqual(p, { name: 'Guest room', floor: 'First floor', updatedBy: 'U', updatedAt: 'N' });
});

test('archive / restore / order shapes match the rules update paths', () => {
  assert.deepEqual(Object.keys(buildRoomArchive({ uid: 'U', now: 'N' })).sort(), ['active', 'archivedAt', 'archivedBy', 'updatedAt', 'updatedBy']);
  assert.equal(buildRoomArchive({ uid: 'U', now: 'N' }).active, false);
  const r = buildRoomRestore({ uid: 'U', now: 'N', sortOrder: 4 });
  assert.deepEqual(r, { active: true, archivedAt: null, archivedBy: null, sortOrder: 4, updatedBy: 'U', updatedAt: 'N' });
  assert.deepEqual(Object.keys(buildRoomOrder({ uid: 'U', now: 'N', sortOrder: 2 })).sort(), ['sortOrder', 'updatedAt', 'updatedBy']);
});
