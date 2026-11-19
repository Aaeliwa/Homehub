import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevicesStore } from '../../src/modules/devices/devices-store.js';
import { createRoomsStore } from '../../src/modules/rooms/rooms-store.js';
import { createContextScope } from '../../src/core/lifecycle/context-scope.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';

/** Generic in-memory per-home collection repo (Firestore-like) with call log. */
function fakeRepo(kind) {
  const homes = new Map(); const watchers = new Map(); const calls = []; let n = 0;
  const col = (h) => { if (!homes.has(h)) homes.set(h, new Map()); return homes.get(h); };
  const emit = (h) => { for (const cb of watchers.get(h) || []) cb([...col(h).entries()].map(([id, d]) => ({ id, ...d }))); };
  const watch = (h, onValue) => {
    calls.push(['watch', h]);
    if (!watchers.has(h)) watchers.set(h, new Set());
    watchers.get(h).add(onValue);
    queueMicrotask(() => emit(h));
    return () => { calls.push(['unwatch', h]); watchers.get(h).delete(onValue); };
  };
  return {
    calls, homes, emit,
    now: () => 'NOW',
    [kind === 'rooms' ? 'watchRooms' : 'watchDevices']: watch,
    async create(h, data) { calls.push(['create', h]); const id = `${kind[0].toUpperCase()}${++n}`; col(h).set(id, { ...data }); emit(h); return id; },
    async patch(h, id, data) { calls.push(['patch', h, id, Object.keys(data)]); col(h).set(id, { ...col(h).get(id), ...data }); emit(h); },
    async patchMany(h, items) { for (const { id, patch } of items) col(h).set(id, { ...col(h).get(id), ...patch }); emit(h); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup(homeId = 'H1') {
  const roomsRepo = fakeRepo('rooms');
  const devicesRepo = fakeRepo('devices');
  const rooms = createRoomsStore({ homeId, uid: 'U1', repo: roomsRepo });
  const devices = createDevicesStore({ homeId, uid: 'U1', repo: devicesRepo, rooms });
  const off = devices.subscribe(() => {});
  await tick();
  const kitchen = await rooms.create({ name: 'Kitchen', type: 'kitchen' });
  const living = await rooms.create({ name: 'Living', type: 'living_room' });
  await tick();
  return { rooms, devices, roomsRepo, devicesRepo, kitchen, living, off };
}
const AC = (extra = {}) => ({ name: 'AC', category: 'air_conditioning', subtype: 'split_ac', ...extra });

test('create assigned + unassigned; ids from the repository; createdBy = uid', async () => {
  const { devices, kitchen } = await setup();
  const a = await devices.create(AC({ roomId: kitchen }));
  const b = await devices.create({ name: 'Router', category: 'networking', subtype: 'router' });
  assert.equal(devices.get(a).roomId, kitchen);
  assert.equal(devices.get(b).roomId, null);
  assert.equal(devices.get(a).createdBy, 'U1');
  assert.equal(devices.active().length, 2);
});

test('invalid input rejected before writing', async () => {
  const { devices, devicesRepo } = await setup();
  await assert.rejects(devices.create({ name: '', category: 'other' }), (e) => e.code === ErrorCode.VALIDATION);
  await assert.rejects(devices.create(AC({ status: 'broken' })), (e) => e.code === ErrorCode.VALIDATION);
  await assert.rejects(devices.create(AC({ purchasePrice: '-5', currency: 'EGP' })), (e) => e.code === ErrorCode.VALIDATION);
  assert.equal(devicesRepo.calls.filter((c) => c[0] === 'create').length, 0);
});

test('move Room A → Room B → Unassigned: only roomId changes, id stays', async () => {
  const { devices, devicesRepo, kitchen, living } = await setup();
  const id = await devices.create(AC({ roomId: kitchen }));
  await devices.update(id, { ...devices.get(id), roomId: living });
  assert.equal(devices.get(id).roomId, living);
  assert.deepEqual(devicesRepo.calls.at(-1), ['patch', 'H1', id, ['roomId', 'updatedBy', 'updatedAt']]);
  await devices.update(id, { ...devices.get(id), roomId: null });
  assert.equal(devices.get(id).roomId, null);
  assert.ok(devices.get(id), 'same id');
});

test('archived room: device keeps roomId; metadata still editable; cannot (re)assign into it', async () => {
  const { rooms, devices, kitchen, living } = await setup();
  const id = await devices.create(AC({ roomId: kitchen }));
  await rooms.archive(kitchen);
  await tick();
  assert.equal(devices.get(id).roomId, kitchen, 'archiving a room does not touch devices');
  assert.equal(devices.get(id).active, true);
  assert.equal(await devices.update(id, { ...devices.get(id), brand: 'LG', model: 'X1' }), true, 'unrelated edit allowed');
  assert.equal(devices.get(id).roomId, kitchen);
  await assert.rejects(devices.create(AC({ roomId: kitchen })), (e) => e.detail === 'devices.validation.roomArchived');
  const other = await devices.create(AC({ roomId: living }));
  await assert.rejects(devices.update(other, { ...devices.get(other), roomId: kitchen }), (e) => e.detail === 'devices.validation.roomArchived');
  await assert.rejects(devices.create(AC({ roomId: 'NOPE' })), (e) => e.detail === 'devices.validation.roomNotFound');
});

test('archive / restore: soft, keeps document + roomId; archived read-only', async () => {
  const { devices, devicesRepo, kitchen } = await setup();
  const id = await devices.create(AC({ roomId: kitchen }));
  await devices.archive(id);
  assert.equal(devices.active().length, 0);
  assert.equal(devices.archived().length, 1);
  assert.ok(devicesRepo.homes.get('H1').has(id));
  assert.equal(devices.get(id).archivedBy, 'U1');
  await assert.rejects(devices.update(id, { ...devices.get(id), name: 'X' }), (e) => e.code === ErrorCode.VALIDATION);
  await devices.restore(id);
  assert.equal(devices.get(id).active, true);
  assert.equal(devices.get(id).roomId, kitchen);
});

test('field-level edit: a concurrent change to another field survives', async () => {
  const { devices, devicesRepo } = await setup();
  const id = await devices.create(AC());
  const base = { ...devices.get(id) };
  await devicesRepo.patch('H1', id, { notes: 'serviced', updatedBy: 'U2', updatedAt: 'NOW' });
  await devices.update(id, { ...base, status: 'needs_attention' }, base);
  assert.equal(devices.get(id).status, 'needs_attention');
  assert.equal(devices.get(id).notes, 'serviced');
});

test('selectors: grouping, needsAttention, inRoom, query, summary', async () => {
  const { devices, kitchen } = await setup();
  await devices.create(AC({ roomId: kitchen, status: 'needs_attention', brand: 'Carrier' }));
  await devices.create({ name: 'Fridge', category: 'refrigeration', roomId: kitchen });
  await devices.create({ name: 'Router', category: 'networking', model: 'AX3000' });
  assert.equal(devices.byRoom().get(kitchen).length, 2);
  assert.equal(devices.byRoom().get(null).length, 1);
  assert.equal(devices.byCategory().get('networking').length, 1);
  assert.equal(devices.byStatus().get('needs_attention').length, 1);
  assert.equal(devices.needsAttention().length, 1);
  assert.equal(devices.inRoom(kitchen).length, 2);
  assert.deepEqual(devices.query({ query: 'ax3' }).map((d) => d.name), ['Router']);
  assert.deepEqual(devices.query({ room: kitchen }, 'status').map((d) => d.name), ['AC', 'Fridge']);
  assert.deepEqual({ ...devices.summary() }, { activeCount: 3, needsAttentionCount: 1, outOfServiceCount: 0, archivedCount: 0 });
});

test('one devices listener + the SHARED rooms listener (no second rooms listener)', async () => {
  const { devices, rooms, devicesRepo, roomsRepo } = await setup();
  devices.subscribe(() => {}); devices.subscribe(() => {}); rooms.subscribe(() => {});
  await tick();
  assert.equal(devicesRepo.calls.filter((c) => c[0] === 'watch').length, 1);
  assert.equal(roomsRepo.calls.filter((c) => c[0] === 'watch').length, 1);
});

test('home isolation and scope disposal (listeners stopped, actions fail safely)', async () => {
  const roomsRepo = fakeRepo('rooms'); const devicesRepo = fakeRepo('devices');
  const scope = createContextScope({ uid: 'U1', homeId: 'H1' });
  const rooms = scope.resource('rooms', (s) => createRoomsStore({ homeId: s.homeId, uid: s.uid, repo: roomsRepo }));
  const devices = scope.resource('devices', (s) => createDevicesStore({ homeId: s.homeId, uid: s.uid, repo: devicesRepo, rooms }));
  const other = createDevicesStore({ homeId: 'H2', uid: 'U1', repo: devicesRepo, rooms: null });
  devices.subscribe(() => {}); other.subscribe(() => {});
  await tick();
  await devices.create({ name: 'Only H1', category: 'other' });
  await tick();
  assert.equal(other.active().length, 0);
  assert.ok(devicesRepo.calls.filter((c) => c[0] === 'create').every((c) => c[1] === 'H1'));
  scope.dispose();
  assert.ok(devicesRepo.calls.some((c) => c[0] === 'unwatch' && c[1] === 'H1'));
  assert.ok(roomsRepo.calls.some((c) => c[0] === 'unwatch'));
  await assert.rejects(devices.create({ name: 'X', category: 'other' }), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE);
  assert.equal(devices.all().length, 0, 'no previous-home data remains visible');
});

test('pending filter hand-off (Room detail → Devices page) is one-shot', async () => {
  const { devices } = await setup();
  devices.setPendingFilter({ room: 'R1' });
  assert.deepEqual(devices.takePendingFilter(), { room: 'R1' });
  assert.equal(devices.takePendingFilter(), null);
});
