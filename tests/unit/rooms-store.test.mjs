import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomsStore } from '../../src/modules/rooms/rooms-store.js';
import { createContextScope } from '../../src/core/lifecycle/context-scope.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';

/** In-memory repository that behaves like Firestore for one or more homes. */
function fakeRepo() {
  const homes = new Map(); // homeId -> Map(id -> doc)
  const watchers = new Map(); // homeId -> Set(cb)
  const calls = [];
  let n = 0;
  const col = (h) => { if (!homes.has(h)) homes.set(h, new Map()); return homes.get(h); };
  const emit = (h) => { for (const cb of watchers.get(h) || []) cb([...col(h).entries()].map(([id, d]) => ({ id, ...d }))); };
  return {
    calls, homes,
    now: () => 'NOW',
    watchRooms(h, onValue) {
      calls.push(['watch', h]);
      if (!watchers.has(h)) watchers.set(h, new Set());
      watchers.get(h).add(onValue);
      queueMicrotask(() => emit(h));
      return () => { calls.push(['unwatch', h]); watchers.get(h).delete(onValue); };
    },
    async create(h, data) { calls.push(['create', h]); const id = `R${++n}`; col(h).set(id, { ...data }); emit(h); return id; },
    async patch(h, id, data) { calls.push(['patch', h, id]); if (!col(h).has(id)) throw Object.assign(new Error('nf'), { code: 'not-found' }); col(h).set(id, { ...col(h).get(id), ...data }); emit(h); },
    async patchMany(h, items) { calls.push(['batch', h, items.length]); for (const { id, patch } of items) col(h).set(id, { ...col(h).get(id), ...patch }); emit(h); },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function ready(store) {
  const seen = [];
  const off = store.subscribe((s) => seen.push(s.status));
  await tick();
  return { off, seen };
}

test('create room: written under the store home, appended in order, appears live', async () => {
  const repo = fakeRepo();
  const store = createRoomsStore({ homeId: 'H1', uid: 'U1', repo });
  await ready(store);
  await store.create({ name: 'Living room', type: 'living_room' });
  await store.create({ name: 'Kitchen', type: 'kitchen' });
  await store.create({ name: 'Bedroom', type: 'bedroom' });
  assert.deepEqual(store.active().map((r) => [r.name, r.sortOrder]), [['Living room', 1], ['Kitchen', 2], ['Bedroom', 3]]);
  assert.ok(repo.calls.filter((c) => c[0] === 'create').every((c) => c[1] === 'H1'));
  assert.equal(store.active()[0].createdBy, 'U1');
});

test('invalid room rejected before any write', async () => {
  const repo = fakeRepo();
  const store = createRoomsStore({ homeId: 'H1', uid: 'U1', repo });
  await ready(store);
  await assert.rejects(store.create({ name: '  ', type: 'kitchen' }), (e) => e.code === ErrorCode.VALIDATION);
  await assert.rejects(store.create({ name: 'X', type: 'Kitchen' }), (e) => e.code === ErrorCode.VALIDATION);
  assert.equal(repo.calls.filter((c) => c[0] === 'create').length, 0);
});

test('update writes only changed fields; concurrent change to another field survives', async () => {
  const repo = fakeRepo();
  const store = createRoomsStore({ homeId: 'H1', uid: 'U1', repo });
  await ready(store);
  const id = await store.create({ name: 'Bedroom', type: 'bedroom' });
  const formBase = { ...store.get(id) };                       // user A opens the form
  await repo.patch('H1', id, { notes: 'Painted 2026', updatedBy: 'U2', updatedAt: 'NOW' }); // user B edits notes
  const changed = await store.update(id, { ...formBase, name: 'Guest bedroom' }, formBase);   // A renames
  assert.equal(changed, true);
  assert.equal(store.get(id).name, 'Guest bedroom');
  assert.equal(store.get(id).notes, 'Painted 2026', 'B’s concurrent notes edit not overwritten');
  assert.equal(await store.update(id, { ...store.get(id) }), false, 'no-op edit performs no write');
});

test('archive hides from active, keeps the document (soft delete); restore brings it back last', async () => {
  const repo = fakeRepo();
  const store = createRoomsStore({ homeId: 'H1', uid: 'U1', repo });
  await ready(store);
  const a = await store.create({ name: 'A', type: 'other' });
  await store.create({ name: 'B', type: 'other' });
  await store.archive(a);
  assert.deepEqual(store.active().map((r) => r.name), ['B']);
  assert.deepEqual(store.archived().map((r) => r.name), ['A']);
  assert.ok(repo.homes.get('H1').has(a), 'document still exists — ids stay resolvable');
  assert.equal(store.get(a).archivedBy, 'U1');
  assert.deepEqual({ ...store.summary() }, { activeCount: 1, archivedCount: 1 });
  await assert.rejects(store.update(a, { name: 'X', type: 'other' }), (e) => e.code === ErrorCode.VALIDATION, 'archived rooms are read-only');
  await store.restore(a);
  assert.deepEqual(store.active().map((r) => r.name), ['B', 'A']);
  assert.equal(store.get(a).archivedAt, null);
});

test('reorder uses ONE atomic batch and persists the new order', async () => {
  const repo = fakeRepo();
  const store = createRoomsStore({ homeId: 'H1', uid: 'U1', repo });
  await ready(store);
  for (const n of ['A', 'B', 'C']) await store.create({ name: n, type: 'other' });
  const c = store.active()[2].id;
  assert.equal(await store.move(c, 'up'), true);
  assert.deepEqual(store.active().map((r) => r.name), ['A', 'C', 'B']);
  assert.deepEqual(repo.calls.filter((x) => x[0] === 'batch'), [['batch', 'H1', 2]]);
  assert.equal(await store.move(store.active()[0].id, 'up'), false, 'top room cannot move up; no write');
});

test('one listener shared by every consumer (page + dashboard widget)', async () => {
  const repo = fakeRepo();
  const store = createRoomsStore({ homeId: 'H1', uid: 'U1', repo });
  const a = await ready(store);
  const b = await ready(store);
  assert.equal(repo.calls.filter((c) => c[0] === 'watch').length, 1);
  a.off(); b.off();
});

test('home isolation: a store only ever touches its own home', async () => {
  const repo = fakeRepo();
  const h1 = createRoomsStore({ homeId: 'H1', uid: 'U1', repo });
  const h2 = createRoomsStore({ homeId: 'H2', uid: 'U1', repo });
  await ready(h1); await ready(h2);
  await h1.create({ name: 'Only in H1', type: 'other' });
  await tick();
  assert.equal(h1.active().length, 1);
  assert.equal(h2.active().length, 0);
  assert.ok(repo.calls.filter((c) => c[0] !== 'watch' && c[0] !== 'unwatch').every((c) => c[1] === 'H1'));
});

test('scope disposal stops the listener and blocks every action (fails safely)', async () => {
  const repo = fakeRepo();
  const scope = createContextScope({ uid: 'U1', homeId: 'H1' });
  const store = scope.resource('rooms', (s) => createRoomsStore({ homeId: s.homeId, uid: s.uid, repo }));
  assert.equal(scope.resource('rooms', () => { throw new Error('factory must not run twice'); }), store);
  await ready(store);
  const id = await store.create({ name: 'A', type: 'other' });
  scope.dispose();
  assert.ok(repo.calls.some((c) => c[0] === 'unwatch'));
  for (const action of [() => store.create({ name: 'B', type: 'other' }), () => store.archive(id), () => store.move(id, 'up')]) {
    await assert.rejects(action(), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE);
  }
  assert.throws(() => store.subscribe(() => {}), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE);
  assert.throws(() => scope.resource('rooms', () => ({})), /disposed/);
});

test('store refuses to exist without a home context', () => {
  assert.throws(() => createRoomsStore({ homeId: '', uid: 'U', repo: fakeRepo() }), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE);
  assert.throws(() => createContextScope({ uid: 'U', homeId: null }));
});
