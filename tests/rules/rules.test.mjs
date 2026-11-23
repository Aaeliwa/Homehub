/**
 * Firestore security rules tests — run against the REAL rules engine (Firestore emulator).
 *
 *   cd tests/rules && npm install
 *   npx firebase emulators:exec --only firestore --project demo-homehub "npm test"
 *
 * Uses the same document shapes the app writes (see src/core/home/setup-plan.js).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Phase 5.2: a denial must come from the INTENDED rule, not from the 1000-expression evaluation
// limit (which also denies, but could mask a rule that would wrongly allow).
async function assertDenied(p, why = '') {
  const e = await _assertFails(p);
  if (/maximum of 1000 expressions/i.test(String(e && (e.message || e)))) throw new Error(`denied only because the 1000-expression limit was reached${why ? ` (${why})` : ''}: ${e.message}`);
  return e;
}
// STRICT_DENIALS=1 applies that check to EVERY denial assertion in the suite (audit mode).
const assertFails = process.env.STRICT_DENIALS ? assertDenied : _assertFails;
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails as _assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, getDocs, collection, writeBatch, serverTimestamp, query, where } from 'firebase/firestore';
import { buildSetupWrites } from '../../src/core/home/setup-plan.js';
import { defaultRoles } from '../../src/modules/index.js';

let env;
const ALICE = { uid: 'alice', email: 'alice@example.com' };
const BOB = { uid: 'bob', email: 'bob@example.com' };
const MALLORY = { uid: 'mallory', email: 'mallory@example.com' };

// ONE Firestore instance per account: every authenticatedContext().firestore() call creates a NEW
// instance, and a write batch rejects references from another instance ("Provided document
// reference is from a different Firestore instance"). Helpers like svRef() call db() again, so
// db() must return the same instance for the same account.
const _instances = new Map();
// B0 fix: fixture-convention guards. A helper that builds author fields must receive the right kind of
// value — a uid STRING, or a test USER object with .uid — or fail loudly (a TypeError), never silently
// produce a forged-author document that the rules then (correctly) deny.
const asUid = (uid, fn) => { if (typeof uid !== 'string' || uid.length === 0) throw new TypeError(`${fn}: expected a uid string, got ${uid === null ? 'null' : typeof uid}`); return uid; };
const asUser = (u, fn) => { if (!u || typeof u !== 'object' || typeof u.uid !== 'string' || u.uid.length === 0) throw new TypeError(`${fn}: expected a test user object with a string .uid`); return u; };
const db = (u) => {
  const key = `${u.uid}|${u.email}`;
  if (!_instances.has(key)) _instances.set(key, env.authenticatedContext(u.uid, { email: u.email }).firestore());
  return _instances.get(key);
};
const anon = () => env.unauthenticatedContext().firestore();
const ref = (f, path) => doc(f, ...path);

function setupBatch(f, user, homeId, { existingProfile = null, mutate } = {}) {
  let writes = buildSetupWrites({
    identity: user, existingProfile, displayName: user.uid, homeName: `${user.uid} home`,
    language: 'ar', theme: 'system', homeId, roles: defaultRoles(), now: serverTimestamp(),
  });
  if (mutate) writes = mutate(writes);
  const b = writeBatch(f);
  for (const w of writes) b[w.mode](ref(f, w.path), w.data);
  return b;
}
const bootstrap = (user, homeId) => assertSucceeds(setupBatch(db(user), user, homeId).commit());

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-homehub',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

// Seed a member directly (bypassing rules) — invitations are not part of Phase 1.
async function seedMember(homeId, user, roleId, status = 'active') {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'homes', homeId, 'members', user.uid), {
      uid: user.uid, email: user.email, displayName: user.uid, roleId, status, addedBy: 'alice',
      joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });
  });
}

// ------------------------------------------------------------------ bootstrap
test('bootstrap: a signed-in user can create their own home in one batch', async () => {
  await bootstrap(ALICE, 'h1');
  await assertSucceeds(getDoc(doc(db(ALICE), 'homes', 'h1')));
});

test('bootstrap: signed-out users cannot create anything', async () => {
  await assertFails(setupBatch(anon(), ALICE, 'h1').commit());
});

test('bootstrap: home alone (without owner membership) is rejected', async () => {
  await assertFails(setupBatch(db(ALICE), ALICE, 'h1', { mutate: (w) => w.filter((x) => x.path.length === 2) }).commit());
});

test('bootstrap: cannot create a home "created by" another uid', async () => {
  await assertFails(setupBatch(db(MALLORY), MALLORY, 'h1', {
    mutate: (w) => w.map((x) => (x.path.join('/') === 'homes/h1' ? { ...x, data: { ...x.data, createdBy: 'alice' } } : x)),
  }).commit());
});

test('bootstrap: cannot create the owner membership for another uid', async () => {
  await assertFails(setupBatch(db(MALLORY), MALLORY, 'h1', {
    mutate: (w) => w.map((x) => (x.path[2] === 'members'
      ? { ...x, path: ['homes', 'h1', 'members', 'alice'], data: { ...x.data, uid: 'alice' } } : x)),
  }).commit());
});

test('bootstrap: cannot write users/{uid} for someone else', async () => {
  await assertFails(setupBatch(db(MALLORY), MALLORY, 'h1', {
    mutate: (w) => w.map((x) => (x.path[0] === 'users' ? { ...x, path: ['users', 'alice'] } : x)),
  }).commit());
});

test('bootstrap: owner role must be exactly ["*"] at rank 100', async () => {
  await assertFails(setupBatch(db(ALICE), ALICE, 'h1', {
    mutate: (w) => w.map((x) => (x.path.join('/') === 'homes/h1/roles/owner' ? { ...x, data: { ...x.data, rank: 99 } } : x)),
  }).commit());
});

test('bootstrap cannot be replayed into an EXISTING home (takeover attempt)', async () => {
  await bootstrap(ALICE, 'h1');
  await assertFails(setupBatch(db(MALLORY), MALLORY, 'h1').commit());
  await assertFails(setDoc(doc(db(MALLORY), 'homes', 'h1', 'members', 'mallory'), {
    uid: 'mallory', email: MALLORY.email, displayName: 'm', roleId: 'owner', status: 'active', addedBy: 'mallory',
    joinedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
});

test('bootstrap: extra/unknown fields are rejected', async () => {
  await assertFails(setupBatch(db(ALICE), ALICE, 'h1', {
    mutate: (w) => w.map((x) => (x.path.join('/') === 'homes/h1' ? { ...x, data: { ...x.data, isAdmin: true } } : x)),
  }).commit());
});

test('defaultHomeId may only point at a home where the user is an active member', async () => {
  await bootstrap(ALICE, 'h1');
  await bootstrap(MALLORY, 'hm');
  await assertFails(updateDoc(doc(db(MALLORY), 'users', 'mallory'), { defaultHomeId: 'h1', updatedAt: serverTimestamp() }));
});

test('existing profile + new home: setup UPDATES users/{uid} and succeeds', async () => {
  await bootstrap(ALICE, 'h1');
  await assertSucceeds(setupBatch(db(ALICE), ALICE, 'h2', { existingProfile: { displayName: 'alice' } }).commit());
});

// ------------------------------------------------------------------ reads
test('non-members cannot read a home, its members, roles or settings', async () => {
  await bootstrap(ALICE, 'h1');
  const m = db(MALLORY);
  await assertFails(getDoc(doc(m, 'homes', 'h1')));
  await assertFails(getDocs(collection(m, 'homes', 'h1', 'members')));
  await assertFails(getDoc(doc(m, 'homes', 'h1', 'members', 'alice')));
  await assertFails(getDoc(doc(m, 'homes', 'h1', 'roles', 'owner')));
  await assertFails(getDoc(doc(m, 'homes', 'h1', 'settings', 'general')));
  await assertFails(getDoc(doc(m, 'users', 'alice')));
});

test('users/{uid} is private to its owner; homes cannot be listed', async () => {
  await bootstrap(ALICE, 'h1');
  await assertSucceeds(getDoc(doc(db(ALICE), 'users', 'alice')));
  await assertFails(getDocs(collection(db(ALICE), 'users')));
  await assertFails(getDocs(collection(db(ALICE), 'homes')));
});

test('suspended member loses home access but can still read own membership', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'member', 'suspended');
  await assertFails(getDoc(doc(db(BOB), 'homes', 'h1')));
  await assertSucceeds(getDoc(doc(db(BOB), 'homes', 'h1', 'members', 'bob')));
});

test('child cannot list members (no members.view)', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'child');
  await assertSucceeds(getDoc(doc(db(BOB), 'homes', 'h1')));
  await assertFails(getDocs(collection(db(BOB), 'homes', 'h1', 'members')));
  await assertSucceeds(getDoc(doc(db(BOB), 'homes', 'h1', 'roles', 'child')), 'own role readable');
  await assertFails(getDoc(doc(db(BOB), 'homes', 'h1', 'roles', 'owner')));
});

// ------------------------------------------------------------------ escalation
test('a member cannot change their own role or status', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'member');
  await assertFails(updateDoc(doc(db(BOB), 'homes', 'h1', 'members', 'bob'), { roleId: 'admin', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db(BOB), 'homes', 'h1', 'members', 'bob'), { displayName: 'Bobby', updatedAt: serverTimestamp() }));
});

test('admin cannot promote to admin/owner, nor touch the owner', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'admin');
  await seedMember('h1', MALLORY, 'member');
  const b = db(BOB);
  await assertFails(updateDoc(doc(b, 'homes', 'h1', 'members', 'mallory'), { roleId: 'admin', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'homes', 'h1', 'members', 'mallory'), { roleId: 'owner', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(b, 'homes', 'h1', 'members', 'alice'), { status: 'suspended', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(b, 'homes', 'h1', 'members', 'mallory'), { roleId: 'viewer', updatedAt: serverTimestamp() }));
});

test('owner can change another member role, but cannot create a second owner', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'member');
  await assertSucceeds(updateDoc(doc(db(ALICE), 'homes', 'h1', 'members', 'bob'), { roleId: 'admin', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db(ALICE), 'homes', 'h1', 'members', 'bob'), { roleId: 'owner', updatedAt: serverTimestamp() }));
});

test('role documents: only roles.edit holders; owner role stays ["*"]; non-owner cannot grant "*"', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'admin');
  await assertFails(updateDoc(doc(db(BOB), 'homes', 'h1', 'roles', 'member'), { permissions: ['*'], updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db(ALICE), 'homes', 'h1', 'roles', 'owner'), { permissions: ['home.view'], updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db(ALICE), 'homes', 'h1', 'roles', 'member'), { rank: 99, updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db(ALICE), 'homes', 'h1', 'roles', 'viewer'), { permissions: ['home.view'], updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(db(ALICE), 'homes', 'h1', 'roles', 'viewer')));
});

test('members cannot create memberships or roles after bootstrap (Phase 1)', async () => {
  await bootstrap(ALICE, 'h1');
  await assertFails(setDoc(doc(db(ALICE), 'homes', 'h1', 'members', 'bob'), {
    uid: 'bob', email: 'alice@example.com', displayName: 'b', roleId: 'member', status: 'active', addedBy: 'alice',
    joinedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(db(ALICE), 'homes', 'h1', 'roles', 'custom'), {
    name: 'Custom', rank: 5, permissions: [], system: false, templateVersion: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  }));
});

// ------------------------------------------------------------------ home settings
test('home.edit: owner/admin can rename; member/viewer cannot; createdBy immutable', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'member');
  const rename = (f, uid) => updateDoc(doc(f, 'homes', 'h1'), { name: 'New', updatedBy: uid, updatedAt: serverTimestamp() });
  await assertSucceeds(rename(db(ALICE), 'alice'));
  await assertFails(rename(db(BOB), 'bob'));
  await assertFails(updateDoc(doc(db(ALICE), 'homes', 'h1'), { createdBy: 'bob', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db(ALICE), 'homes', 'h1'), { name: 'X', updatedBy: 'bob', updatedAt: serverTimestamp() }), 'updatedBy spoof');
});

test('settings/general: home.edit only, validated', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'viewer');
  const set = (f, uid, d) => updateDoc(doc(f, 'homes', 'h1', 'settings', 'general'), { weekStartsOn: d, updatedBy: uid, updatedAt: serverTimestamp() });
  await assertSucceeds(set(db(ALICE), 'alice', 0));
  await assertFails(set(db(ALICE), 'alice', 9));
  await assertFails(set(db(BOB), 'bob', 1));
});

test('client timestamps are rejected (serverTimestamp required)', async () => {
  await bootstrap(ALICE, 'h1');
  await assertFails(updateDoc(doc(db(ALICE), 'users', 'alice'), { theme: 'dark', updatedAt: new Date(2000, 0, 1) }));
  await assertSucceeds(updateDoc(doc(db(ALICE), 'users', 'alice'), { theme: 'dark', updatedAt: serverTimestamp() }));
});

test('unknown collections are denied (future modules need their own rules)', async () => {
  await bootstrap(ALICE, 'h1');
  await assertFails(setDoc(doc(db(ALICE), 'homes', 'h1', 'expenses', 'e1'), { amount: 1 }));
  await assertFails(setDoc(doc(db(ALICE), 'anything', 'x'), { a: 1 }));
});

// =================================================================== PHASE 2 — ROOMS
const roomDoc = (f, h, id) => doc(f, 'homes', h, 'rooms', id);
const roomData = (uid, extra = {}) => (asUid(uid, 'roomData'), {
  name: 'Kitchen', type: 'kitchen', icon: 'kitchen', floor: null, notes: null, sortOrder: 1, active: true,
  archivedAt: null, archivedBy: null, createdBy: uid, createdAt: serverTimestamp(), updatedBy: uid,
  updatedAt: serverTimestamp(), schemaVersion: 1, ...extra,
});
async function seedRoom(h, id, extra = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'homes', h, 'rooms', id), {
      ...roomData('alice'), createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
  });
}
const edit = (uid, data) => (asUid(uid, 'edit'), { ...data, updatedBy: uid, updatedAt: serverTimestamp() });

test('rooms: owner creates a valid room; createdBy must be the caller', async () => {
  await bootstrap(ALICE, 'h1');
  await assertSucceeds(setDoc(roomDoc(db(ALICE), 'h1', 'r1'), roomData('alice')));
  await assertFails(setDoc(roomDoc(db(ALICE), 'h1', 'r2'), roomData('bob')));
});

test('rooms: malformed creates are rejected', async () => {
  await bootstrap(ALICE, 'h1');
  const bad = [
    { type: 'Kitchen' }, { type: 'spaceship' }, { name: '' }, { name: '   ' }, { name: 'x'.repeat(61) },
    { icon: '<svg>' }, { floor: 'f'.repeat(41) }, { notes: 'n'.repeat(501) }, { floor: '  ' },
    { sortOrder: 1.5 }, { sortOrder: -1 }, { active: false }, { schemaVersion: 2 },
    { createdAt: new Date() }, { devices: ['d1'] }, { homeId: 'h1' },
  ];
  for (const extra of bad) await assertFails(setDoc(roomDoc(db(ALICE), 'h1', 'bad'), roomData('alice', extra)));
});

test('rooms: read requires membership + rooms.view (all seeded roles have it)', async () => {
  await bootstrap(ALICE, 'h1');
  await seedRoom('h1', 'r1');
  for (const [u, role] of [[BOB, 'child']]) await seedMember('h1', u, role);
  await assertSucceeds(getDoc(roomDoc(db(BOB), 'h1', 'r1')));
  await assertSucceeds(getDocs(collection(db(BOB), 'homes', 'h1', 'rooms')));
  await assertFails(getDoc(roomDoc(db(MALLORY), 'h1', 'r1')));
  await assertFails(getDocs(collection(db(MALLORY), 'homes', 'h1', 'rooms')));
});

test('rooms: member / viewer / child cannot create, edit, archive or restore', async () => {
  await bootstrap(ALICE, 'h1');
  await seedRoom('h1', 'r1');
  await seedRoom('h1', 'r2', { active: false, archivedAt: new Date(), archivedBy: 'alice' });
  for (const role of ['member', 'viewer', 'child']) {
    await seedMember('h1', BOB, role);
    const b = db(BOB);
    await assertFails(setDoc(roomDoc(b, 'h1', 'x'), roomData('bob')));
    await assertFails(updateDoc(roomDoc(b, 'h1', 'r1'), edit('bob', { name: 'Hacked' })));
    await assertFails(updateDoc(roomDoc(b, 'h1', 'r1'), edit('bob', { active: false, archivedAt: serverTimestamp(), archivedBy: 'bob' })));
    await assertFails(updateDoc(roomDoc(b, 'h1', 'r2'), edit('bob', { active: true, archivedAt: null, archivedBy: null, sortOrder: 9 })));
  }
});

test('rooms: admin edits, reorders (batch), archives and restores', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'admin');
  await seedRoom('h1', 'r1', { sortOrder: 1 });
  await seedRoom('h1', 'r2', { sortOrder: 2, name: 'Bedroom', type: 'bedroom', icon: 'bed' });
  const b = db(BOB);
  await assertSucceeds(updateDoc(roomDoc(b, 'h1', 'r1'), edit('bob', { name: 'Main Kitchen', floor: 'Ground floor' })));
  const batch = writeBatch(b);
  batch.update(roomDoc(b, 'h1', 'r1'), edit('bob', { sortOrder: 2 }));
  batch.update(roomDoc(b, 'h1', 'r2'), edit('bob', { sortOrder: 1 }));
  await assertSucceeds(batch.commit());
  await assertSucceeds(updateDoc(roomDoc(b, 'h1', 'r1'), edit('bob', { active: false, archivedAt: serverTimestamp(), archivedBy: 'bob' })));
  await assertSucceeds(updateDoc(roomDoc(b, 'h1', 'r1'), edit('bob', { active: true, archivedAt: null, archivedBy: null, sortOrder: 3 })));
});

test('rooms: audit fields are protected (createdBy, createdAt, schemaVersion, updatedBy, archivedBy)', async () => {
  await bootstrap(ALICE, 'h1');
  await seedRoom('h1', 'r1');
  const a = db(ALICE);
  await assertFails(updateDoc(roomDoc(a, 'h1', 'r1'), edit('alice', { createdBy: 'bob' })));
  await assertFails(updateDoc(roomDoc(a, 'h1', 'r1'), edit('alice', { createdAt: serverTimestamp() })));
  await assertFails(updateDoc(roomDoc(a, 'h1', 'r1'), edit('alice', { schemaVersion: 2 })));
  await assertFails(updateDoc(roomDoc(a, 'h1', 'r1'), { name: 'X', updatedBy: 'bob', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(roomDoc(a, 'h1', 'r1'), { name: 'X', updatedBy: 'alice', updatedAt: new Date() }));
  await assertFails(updateDoc(roomDoc(a, 'h1', 'r1'), edit('alice', { active: false, archivedAt: serverTimestamp(), archivedBy: 'bob' })));
  await assertFails(updateDoc(roomDoc(a, 'h1', 'r1'), edit('alice', { active: false, name: 'Mixed' })), 'archive and edit cannot be mixed');
});

test('rooms: archived rooms are read-only until restored; no hard delete for anyone', async () => {
  await bootstrap(ALICE, 'h1');
  await seedRoom('h1', 'r1', { active: false, archivedAt: new Date(), archivedBy: 'alice' });
  await assertFails(updateDoc(roomDoc(db(ALICE), 'h1', 'r1'), edit('alice', { name: 'Renamed' })));
  await assertFails(deleteDoc(roomDoc(db(ALICE), 'h1', 'r1')));
});

test('rooms: tenant isolation — no access to another home\'s rooms, no root rooms collection', async () => {
  await bootstrap(ALICE, 'h1');
  await bootstrap(MALLORY, 'hm');
  await seedRoom('h1', 'r1');
  const m = db(MALLORY);
  await assertFails(getDoc(roomDoc(m, 'h1', 'r1')));
  await assertFails(updateDoc(roomDoc(m, 'h1', 'r1'), edit('mallory', { name: 'Mine' })));
  await assertFails(setDoc(roomDoc(m, 'h1', 'r9'), roomData('mallory')));
  await assertSucceeds(setDoc(roomDoc(m, 'hm', 'r9'), roomData('mallory')));
  await assertFails(setDoc(doc(m, 'rooms', 'x'), roomData('mallory')));
  await assertFails(setDoc(doc(m, 'users', 'mallory', 'rooms', 'x'), roomData('mallory')));
});

test('rooms: suspended member loses room access', async () => {
  await bootstrap(ALICE, 'h1');
  await seedRoom('h1', 'r1');
  await seedMember('h1', BOB, 'admin', 'suspended');
  await assertFails(getDoc(roomDoc(db(BOB), 'h1', 'r1')));
  await assertFails(updateDoc(roomDoc(db(BOB), 'h1', 'r1'), edit('bob', { name: 'X' })));
});

test('role refresh ("Update default roles") is accepted by the rules for the owner', async () => {
  await bootstrap(ALICE, 'h1');
  await assertSucceeds(updateDoc(doc(db(ALICE), 'homes', 'h1', 'roles', 'member'), {
    permissions: defaultRoles().find((r) => r.id === 'member').permissions, templateVersion: 2, updatedAt: serverTimestamp(),
  }));
});

// =================================================================== PHASE 3 — DEVICES
const devRef = (f, h, id) => doc(f, 'homes', h, 'devices', id);
const deviceData = (uid, extra = {}) => (asUid(uid, 'deviceData'), {
  name: 'Split AC', category: 'air_conditioning', subtype: 'split_ac', roomId: null, status: 'operational', icon: 'snowflake',
  brand: null, model: null, serialNumber: null, purchaseDate: null, installationDate: null, purchasePrice: null, currency: null,
  warrantyExpiry: null, notes: null, active: true, archivedAt: null, archivedBy: null,
  createdBy: uid, createdAt: serverTimestamp(), updatedBy: uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra,
});
async function seedDevice(h, id, extra = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'homes', h, 'devices', id), { ...deviceData('alice'), createdAt: new Date(), updatedAt: new Date(), ...extra });
  });
}

test('devices: unauthenticated and non-members cannot read', async () => {
  await bootstrap(ALICE, 'h1');
  await seedDevice('h1', 'd1');
  await assertFails(getDoc(devRef(anon(), 'h1', 'd1')));
  await assertFails(getDoc(devRef(db(MALLORY), 'h1', 'd1')));
  await assertFails(getDocs(collection(db(MALLORY), 'homes', 'h1', 'devices')));
});

test('devices: every seeded role can read (devices.view); only owner/admin can create', async () => {
  await bootstrap(ALICE, 'h1');
  await seedDevice('h1', 'd1');
  for (const role of ['member', 'viewer', 'child']) {
    await seedMember('h1', BOB, role);
    await assertSucceeds(getDoc(devRef(db(BOB), 'h1', 'd1')));
    await assertFails(setDoc(devRef(db(BOB), 'h1', 'x'), deviceData('bob')), `${role} create`);
  }
  await seedMember('h1', BOB, 'admin');
  await assertSucceeds(setDoc(devRef(db(BOB), 'h1', 'x'), deviceData('bob')));
  await assertSucceeds(setDoc(devRef(db(ALICE), 'h1', 'y'), deviceData('alice')));
});

test('devices: spoofed createdBy and malformed content rejected', async () => {
  await bootstrap(ALICE, 'h1');
  const a = db(ALICE);
  await assertFails(setDoc(devRef(a, 'h1', 'x'), deviceData('bob')));
  const bad = [
    { category: 'Air Conditioning' }, { category: 'spaceship' }, { subtype: 'refrigerator' }, { subtype: 'nope' },
    { category: 'other', subtype: 'other' }, { status: 'broken' }, { name: '' }, { name: 'x'.repeat(81) },
    { icon: '<svg>' }, { roomId: 'a/b' }, { purchasePrice: -1, currency: 'EGP' }, { purchasePrice: 10, currency: null },
    { purchasePrice: null, currency: 'EGP' }, { purchasePrice: 10, currency: 'egp' }, { purchaseDate: '2024-1-1' },
    { warrantyExpiry: '2024-13-01' }, { installationDate: '1899-12-31' }, { active: false }, { schemaVersion: 2 },
    { createdAt: new Date() }, { maintenanceHistory: [] }, { sortOrder: 1 }, { notes: 'n'.repeat(1001) },
  ];
  for (const extra of bad) await assertFails(setDoc(devRef(a, 'h1', 'bad'), deviceData('alice', extra)), JSON.stringify(extra));
  await assertSucceeds(setDoc(devRef(a, 'h1', 'ok'), deviceData('alice', {
    purchasePrice: 0, currency: 'EGP', purchaseDate: '2024-02-29', warrantyExpiry: '2027-06-30', brand: 'Carrier',
  })), 'price 0 is valid');
});

test('devices: room reference — same home, existing, active on create', async () => {
  await bootstrap(ALICE, 'h1');
  await bootstrap(MALLORY, 'hm');
  await seedRoom('h1', 'r1');
  await seedRoom('h1', 'rArch', { active: false, archivedAt: new Date(), archivedBy: 'alice' });
  await seedRoom('hm', 'foreign');
  const a = db(ALICE);
  await assertSucceeds(setDoc(devRef(a, 'h1', 'd1'), deviceData('alice', { roomId: 'r1' })));
  await assertSucceeds(setDoc(devRef(a, 'h1', 'd2'), deviceData('alice', { roomId: null })), 'unassigned');
  await assertFails(setDoc(devRef(a, 'h1', 'd3'), deviceData('alice', { roomId: 'rArch' })), 'archived room');
  await assertFails(setDoc(devRef(a, 'h1', 'd4'), deviceData('alice', { roomId: 'missing' })), 'missing room');
  await assertFails(setDoc(devRef(a, 'h1', 'd5'), deviceData('alice', { roomId: 'foreign' })), 'room of another home');
});

test('devices: moving between rooms; moving INTO an archived room denied', async () => {
  await bootstrap(ALICE, 'h1');
  await seedRoom('h1', 'r1'); await seedRoom('h1', 'r2');
  await seedRoom('h1', 'rArch', { active: false, archivedAt: new Date(), archivedBy: 'alice' });
  await seedDevice('h1', 'd1', { roomId: 'r1' });
  const a = db(ALICE);
  await assertSucceeds(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', { roomId: 'r2' })));
  await assertSucceeds(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', { roomId: null })));
  await assertFails(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', { roomId: 'rArch' })));
});

test('devices: device whose room was archived LATER keeps working (edit metadata, archive, restore)', async () => {
  await bootstrap(ALICE, 'h1');
  await seedRoom('h1', 'r1');
  await seedDevice('h1', 'd1', { roomId: 'r1' });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), 'homes', 'h1', 'rooms', 'r1'), { active: false, archivedAt: new Date(), archivedBy: 'alice' });
  });
  const a = db(ALICE);
  await assertSucceeds(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', { brand: 'LG', model: 'X1', status: 'needs_attention' })));
  await assertSucceeds(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', { active: false, archivedAt: serverTimestamp(), archivedBy: 'alice' })));
  await assertSucceeds(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', { active: true, archivedAt: null, archivedBy: null })));
});

test('devices: edit / archive / restore each need their own permission', async () => {
  await bootstrap(ALICE, 'h1');
  await seedDevice('h1', 'd1');
  await seedDevice('h1', 'd2', { active: false, archivedAt: new Date(), archivedBy: 'alice' });
  for (const role of ['member', 'viewer', 'child']) {
    await seedMember('h1', BOB, role);
    const b = db(BOB);
    await assertFails(updateDoc(devRef(b, 'h1', 'd1'), edit('bob', { brand: 'X' })));
    await assertFails(updateDoc(devRef(b, 'h1', 'd1'), edit('bob', { active: false, archivedAt: serverTimestamp(), archivedBy: 'bob' })));
    await assertFails(updateDoc(devRef(b, 'h1', 'd2'), edit('bob', { active: true, archivedAt: null, archivedBy: null })));
  }
  await seedMember('h1', BOB, 'admin');
  const b = db(BOB);
  await assertSucceeds(updateDoc(devRef(b, 'h1', 'd1'), edit('bob', { brand: 'X' })));
  await assertSucceeds(updateDoc(devRef(b, 'h1', 'd1'), edit('bob', { active: false, archivedAt: serverTimestamp(), archivedBy: 'bob' })));
  await assertSucceeds(updateDoc(devRef(b, 'h1', 'd2'), edit('bob', { active: true, archivedAt: null, archivedBy: null })));
});

test('devices: audit fields immutable; archived devices read-only; no hard delete', async () => {
  await bootstrap(ALICE, 'h1');
  await seedDevice('h1', 'd1');
  await seedDevice('h1', 'd2', { active: false, archivedAt: new Date(), archivedBy: 'alice' });
  const a = db(ALICE);
  for (const f of [{ createdBy: 'bob' }, { createdAt: serverTimestamp() }, { schemaVersion: 2 }]) {
    await assertFails(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', f)), JSON.stringify(Object.keys(f)));
  }
  await assertFails(updateDoc(devRef(a, 'h1', 'd1'), { brand: 'X', updatedBy: 'bob', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', { active: false, archivedAt: serverTimestamp(), archivedBy: 'bob' })));
  await assertFails(updateDoc(devRef(a, 'h1', 'd1'), edit('alice', { active: false, brand: 'mixed' })));
  await assertFails(updateDoc(devRef(a, 'h1', 'd2'), edit('alice', { brand: 'X' })), 'archived is read-only');
  await assertFails(deleteDoc(devRef(a, 'h1', 'd1')));
  await assertFails(setDoc(doc(a, 'devices', 'x'), deviceData('alice')), 'no root collection');
  await assertFails(setDoc(doc(a, 'homes', 'h1', 'rooms', 'r1', 'devices', 'x'), deviceData('alice')), 'not under rooms');
});

test('devices: tenant isolation', async () => {
  await bootstrap(ALICE, 'h1');
  await bootstrap(MALLORY, 'hm');
  await seedDevice('h1', 'd1');
  const m = db(MALLORY);
  await assertFails(getDoc(devRef(m, 'h1', 'd1')));
  await assertFails(updateDoc(devRef(m, 'h1', 'd1'), edit('mallory', { brand: 'Mine' })));
  await assertSucceeds(setDoc(devRef(m, 'hm', 'd9'), deviceData('mallory')));
});

test('role template v3 refresh payload is accepted for the owner', async () => {
  await bootstrap(ALICE, 'h1');
  await assertSucceeds(updateDoc(doc(db(ALICE), 'homes', 'h1', 'roles', 'admin'), {
    permissions: defaultRoles().find((r) => r.id === 'admin').permissions, templateVersion: 3, updatedAt: serverTimestamp(),
  }));
});

// =================================================================== PHASE 4 — FINANCE
const T = () => serverTimestamp();
const wPath = (f, h, id) => doc(f, 'homes', h, 'wallets', id);
const ePath = (f, h, id) => doc(f, 'homes', h, 'expenses', id);
const mPath = (f, h, id) => doc(f, 'homes', h, 'walletMovements', id);
const cPath = (f, h, id) => doc(f, 'homes', h, 'spendingCycles', id);
const kPath = (f, h, id) => doc(f, 'homes', h, 'commitments', id);
const audit = (uid) => (asUid(uid, 'audit'), { createdBy: uid, createdAt: T(), updatedBy: uid, updatedAt: T(), schemaVersion: 1 });
const householdWallet = (uid, extra = {}) => (asUid(uid, 'householdWallet'), { name: 'Household cash', type: 'cash', scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [],
  currency: 'EGP', active: true, archivedAt: null, archivedBy: null, ...audit(uid), ...extra });
const personalWallet = (uid, owner, shared = [], extra = {}) => (asUid(uid, 'personalWallet'), { name: 'Personal', type: 'cash', scope: 'personal', ownerUid: owner, visibility: shared.length ? 'shared' : 'private',
  sharedWith: shared, readers: [owner, ...shared].sort(), currency: 'EGP', active: true, archivedAt: null, archivedBy: null, ...audit(uid), ...extra });
const expense = (uid, extra = {}) => (asUid(uid, 'expense'), { amountMinor: 45000, currency: 'EGP', date: '2026-10-05', category: 'groceries', note: null, merchant: null, paymentMethod: 'cash',
  walletId: null, budgetCycleId: null, paidBy: null, commitmentId: null, commitmentDueDate: null, audience: 'household', readers: [], status: 'active',
  voidedAt: null, voidedBy: null, voidReason: null, source: 'app', ...audit(uid), ...extra });
async function seed(path, data) { await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), ...path), { ...data, createdAt: new Date(), updatedAt: new Date() }); }); }
const ADMIN_H1 = { uid: 'adminh1', email: 'adminh1@example.com' };   // V6 batch 3: household budgets → owner / admin only
async function financeHome() {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'member');
  await seed(['homes', 'h1', 'wallets', 'cash'], householdWallet('alice'));
  await seed(['homes', 'h1', 'wallets', 'bank'], householdWallet('alice', { name: 'Bank', type: 'bank' }));
  await seed(['homes', 'h1', 'wallets', 'alicePriv'], personalWallet('alice', 'alice'));
}

test('finance: owner/member read household wallets; non-member and unauthenticated denied', async () => {
  await financeHome();
  await assertSucceeds(getDoc(wPath(db(ALICE), 'h1', 'cash')));
  await assertSucceeds(getDoc(wPath(db(BOB), 'h1', 'cash')));
  await assertSucceeds(getDocs(query(collection(db(BOB), 'homes', 'h1', 'wallets'), where('visibility', '==', 'household'))));
  await assertFails(getDoc(wPath(db(MALLORY), 'h1', 'cash')));
  await assertFails(getDoc(wPath(anon(), 'h1', 'cash')));
});

test('finance: PRIVATE wallet — owner only; another adult and even the Home owner are denied', async () => {
  await financeHome();
  await seed(['homes', 'h1', 'wallets', 'bobPriv'], personalWallet('bob', 'bob'));
  await seed(['homes', 'h1', 'expenses', 'bobSecret'], expense('bob', { walletId: 'bobPriv', audience: 'restricted', readers: ['bob'] }));
  await assertSucceeds(getDoc(wPath(db(BOB), 'h1', 'bobPriv')));
  await assertSucceeds(getDoc(ePath(db(BOB), 'h1', 'bobSecret')));
  await assertFails(getDoc(wPath(db(ALICE), 'h1', 'bobPriv')), 'owner has no implicit access');
  await assertFails(getDoc(ePath(db(ALICE), 'h1', 'bobSecret')));
  // Unconstrained list is denied (rules are not filters); constrained "mine" query works.
  await assertFails(getDocs(collection(db(ALICE), 'homes', 'h1', 'expenses')));
  await assertSucceeds(getDocs(query(collection(db(BOB), 'homes', 'h1', 'expenses'), where('readers', 'array-contains', 'bob'))));
  await assertFails(getDocs(query(collection(db(ALICE), 'homes', 'h1', 'expenses'), where('readers', 'array-contains', 'bob'))));
});

test('finance: SHARED wallet — selected member reads; child allowance visible to guardians', async () => {
  await financeHome();
  await seedMember('h1', MALLORY, 'child');
  await seed(['homes', 'h1', 'wallets', 'kid'], personalWallet('alice', 'mallory', ['alice']));
  await assertSucceeds(getDoc(wPath(db(MALLORY), 'h1', 'kid')), 'child reads own allowance');
  await assertSucceeds(getDoc(wPath(db(ALICE), 'h1', 'kid')), 'guardian reads it');
  await assertFails(getDoc(wPath(db(BOB), 'h1', 'kid')), 'not shared with Bob');
  await assertFails(getDoc(wPath(db(MALLORY), 'h1', 'cash')), 'child has no household finance');
  await assertFails(getDocs(query(collection(db(MALLORY), 'homes', 'h1', 'expenses'), where('audience', '==', 'household'))));
  await assertSucceeds(setDoc(ePath(db(MALLORY), 'h1', 'snack'), expense('mallory', { amountMinor: 4000, walletId: 'kid', audience: 'restricted', readers: ['alice', 'mallory'] })), 'child spends own allowance');
});

test('finance: wallet creation — household needs manageWallets; personal for self; no spoofed owner/readers', async () => {
  await financeHome();
  await assertSucceeds(setDoc(wPath(db(ALICE), 'h1', 'w1'), householdWallet('alice')));
  await assertFails(setDoc(wPath(db(BOB), 'h1', 'w2'), householdWallet('bob')), 'member lacks manageWallets');
  await assertSucceeds(setDoc(wPath(db(BOB), 'h1', 'w3'), personalWallet('bob', 'bob')));
  await assertFails(setDoc(wPath(db(BOB), 'h1', 'w4'), personalWallet('bob', 'alice')), 'member cannot create a wallet owned by someone else');
  await assertFails(setDoc(wPath(db(BOB), 'h1', 'w5'), { ...personalWallet('bob', 'bob'), readers: ['alice', 'bob'] }), 'readers must equal owner + sharedWith');
  await assertFails(setDoc(wPath(db(BOB), 'h1', 'w6'), personalWallet('bob', 'bob', ['stranger'])), 'shared with a non-member');
  await assertFails(setDoc(wPath(db(BOB), 'h1', 'w7'), personalWallet('alice', 'bob')), 'createdBy spoof');
});

test('finance: viewer is read-only', async () => {
  await financeHome();
  await seedMember('h1', BOB, 'viewer');
  await assertSucceeds(getDoc(wPath(db(BOB), 'h1', 'cash')));
  await assertFails(setDoc(ePath(db(BOB), 'h1', 'x'), expense('bob', { walletId: 'cash' })));
  await assertFails(setDoc(wPath(db(BOB), 'h1', 'pv'), personalWallet('bob', 'bob')), 'viewer has no expenses.personal');
});

test('finance: expense create / edit / void permissions; audit fields; labels must match wallet', async () => {
  await financeHome();
  const b = db(BOB);
  await assertSucceeds(setDoc(ePath(b, 'h1', 'e1'), expense('bob', { walletId: 'cash' })));
  await assertFails(setDoc(ePath(b, 'h1', 'e2'), expense('alice', { walletId: 'cash' })), 'createdBy spoof');
  await assertFails(setDoc(ePath(b, 'h1', 'e3'), expense('bob', { walletId: 'cash', audience: 'restricted', readers: ['bob'] })), 'wrong label for household wallet');
  await assertFails(setDoc(ePath(b, 'h1', 'e4'), expense('bob', { walletId: 'alicePriv', audience: 'restricted', readers: ['alice'] })), "cannot spend from someone else's private wallet");
  await assertFails(setDoc(ePath(b, 'h1', 'e5'), expense('bob', { walletId: 'nope' })), 'invalid wallet reference');
  await assertFails(setDoc(ePath(b, 'h1', 'e6'), expense('bob', { amountMinor: 0 })));
  await assertFails(setDoc(ePath(b, 'h1', 'e7'), expense('bob', { amountMinor: 450.5 })), 'money must be integer minor units');
  await assertFails(setDoc(ePath(b, 'h1', 'e8'), expense('bob', { paymentMethod: 'visa' })), "'visa' only for imported history");
  await assertSucceeds(updateDoc(ePath(b, 'h1', 'e1'), { amountMinor: 46000, updatedBy: 'bob', updatedAt: T() }));
  await assertFails(updateDoc(ePath(b, 'h1', 'e1'), { createdBy: 'alice', updatedBy: 'bob', updatedAt: T() }));
  await assertFails(updateDoc(ePath(b, 'h1', 'e1'), { source: 'import', updatedBy: 'bob', updatedAt: T() }));
  await assertFails(updateDoc(ePath(b, 'h1', 'e1'), { status: 'void', voidedAt: T(), voidedBy: 'bob', voidReason: null, updatedBy: 'bob', updatedAt: T() }), 'member lacks expenses.delete');
  await assertSucceeds(updateDoc(ePath(db(ALICE), 'h1', 'e1'), { status: 'void', voidedAt: T(), voidedBy: 'alice', voidReason: 'dup', updatedBy: 'alice', updatedAt: T() }));
  await assertFails(deleteDoc(ePath(db(ALICE), 'h1', 'e1')), 'no hard delete');
});

test('finance: transfers need transfer permission on both wallets; same currency; never cross-home', async () => {
  await financeHome();
  await bootstrap(MALLORY, 'hm');
  await seed(['homes', 'hm', 'wallets', 'foreign'], householdWallet('mallory'));
  await seed(['homes', 'h1', 'wallets', 'usd'], householdWallet('alice', { name: 'USD', currency: 'USD' }));
  const mv = (uid, extra) => ({ type: 'transfer', amountMinor: 600000, currency: 'EGP', date: '2026-10-05', fromWalletId: 'bank', toWalletId: 'cash', cycleId: null, note: null,
    audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, ...audit(uid), ...extra });
  await assertSucceeds(setDoc(mPath(db(BOB), 'h1', 'm1'), mv('bob')));
  await assertFails(setDoc(mPath(db(BOB), 'h1', 'm2'), mv('bob', { toWalletId: 'usd' })), 'no silent currency conversion');
  await assertFails(setDoc(mPath(db(BOB), 'h1', 'm3'), mv('bob', { toWalletId: 'foreign' })), 'cross-home wallet reference');
  await assertFails(setDoc(mPath(db(BOB), 'h1', 'm4'), mv('bob', { toWalletId: 'alicePriv', readers: ['alice'] })), "cannot move money into another adult's private wallet");
  await seedMember('h1', BOB, 'viewer');
  await assertFails(setDoc(mPath(db(BOB), 'h1', 'm5'), mv('bob')), 'viewer cannot transfer');
  await assertFails(deleteDoc(mPath(db(ALICE), 'h1', 'm1')));
});

test('finance: spending cycles need manageBudgets on the wallet; close must record the outcome', async () => {
  await financeHome();
  const cyc = (uid, extra) => ({ walletId: 'cash', currency: 'EGP', startDate: '2026-10-05', endDate: '2026-10-14', days: 10, budgetMinor: 600000, carryInMinor: 0,
    previousCycleId: null, status: 'active', closedAt: null, closedBy: null, closeOutcome: null, closingRemainingMinor: null, nextCycleId: null,
    audience: 'household', readers: [], ...audit(uid), ...extra });
  await seedMember('h1', ADMIN_H1, 'admin');
  await assertFails(setDoc(cPath(db(BOB), 'h1', 'c0'), cyc('bob')));   // V6 batch 3: a member can't manage household budgets
  const MGR = ADMIN_H1; const A = MGR.uid;   // the authorized household budget manager is now the admin
  await assertSucceeds(setDoc(cPath(db(MGR), 'h1', 'c1'), cyc(A)));
  await assertFails(setDoc(cPath(db(MGR), 'h1', 'c2'), cyc(A, { days: 40 })));
  await assertFails(setDoc(cPath(db(MGR), 'h1', 'c3'), cyc(A, { walletId: 'alicePriv', audience: 'restricted', readers: ['alice'] })));
  await assertSucceeds(updateDoc(cPath(db(MGR), 'h1', 'c1'), { status: 'closed', closedAt: T(), closedBy: A, closeOutcome: 'keep', closingRemainingMinor: 1200, nextCycleId: null, updatedBy: A, updatedAt: T() }));
  await seedMember('h1', ADMIN_H1, 'viewer');
  await assertFails(setDoc(cPath(db(MGR), 'h1', 'c4'), cyc(A)));
  await assertFails(deleteDoc(cPath(db(ALICE), 'h1', 'c1')));
});

test('finance: commitments need manageCommitments; mark-paid pairs ONE deterministic expense with the advance', async () => {
  await financeHome();
  const cm = (uid, extra) => ({ name: 'Microsoft 365', amountMinor: 299900, currency: 'EGP', category: 'subscriptions', recurrence: { unit: 'year', interval: 1 }, anchorDay: 15,
    nextDueDate: '2027-03-15', paymentMethod: null, walletId: null, notes: null, lastPaidDate: null, audience: 'household', readers: [],
    active: true, archivedAt: null, archivedBy: null, ...audit(uid), ...extra });
  await assertFails(setDoc(kPath(db(BOB), 'h1', 'k1'), cm('bob')), 'member lacks manageCommitments');
  await assertSucceeds(setDoc(kPath(db(ALICE), 'h1', 'k1'), cm('alice')));
  const pay = (f, uid, id) => { const bt = writeBatch(f);
    bt.set(ePath(f, 'h1', id), expense(uid, { amountMinor: 299900, category: 'subscriptions', commitmentId: 'k1', commitmentDueDate: '2027-03-15', date: '2027-03-15' }));
    bt.update(kPath(f, 'h1', 'k1'), { nextDueDate: '2028-03-15', lastPaidDate: '2027-03-15', updatedBy: uid, updatedAt: T() });
    return bt.commit(); };
  await assertFails(pay(db(ALICE), 'alice', 'random-id'), 'payment id must be deterministic');
  await assertSucceeds(pay(db(ALICE), 'alice', 'cm_k1_20270315'));
  await assertFails(setDoc(ePath(db(ALICE), 'h1', 'cm_k1_20270315'), expense('alice', { commitmentId: 'k1', commitmentDueDate: '2027-03-15' })), 'second payment for the same due date');
  await assertFails(updateDoc(kPath(db(ALICE), 'h1', 'k1'), { nextDueDate: '2029-03-15', lastPaidDate: '2028-03-15', updatedBy: 'alice', updatedAt: T() }), 'cannot advance without the payment expense');
  await assertFails(deleteDoc(kPath(db(ALICE), 'h1', 'k1')));
});

test('finance: import is owner-only (expenses.import), household history only', async () => {
  await financeHome();
  const imp = (uid, extra) => ({ ...expense(uid), source: 'import', paymentMethod: 'visa', importedCategory: 'Bakery', importBatchId: 'b1', originalRow: { amount: '150' }, ...extra });
  await assertSucceeds(setDoc(ePath(db(ALICE), 'h1', 'hist001'), imp('alice')));
  await assertFails(setDoc(ePath(db(BOB), 'h1', 'hist002'), imp('bob')), 'member cannot import');
  await assertFails(setDoc(ePath(db(ALICE), 'h1', 'hist003'), imp('alice', { walletId: 'cash' })), 'imported history has no wallet');
  await assertFails(updateDoc(ePath(db(ALICE), 'h1', 'hist001'), { originalRow: { amount: '1' }, updatedBy: 'alice', updatedAt: T() }), 'original row immutable');
});

test('finance: cross-home isolation for every finance collection', async () => {
  await financeHome();
  await bootstrap(MALLORY, 'hm');
  await seed(['homes', 'h1', 'expenses', 'e1'], expense('alice', { walletId: 'cash' }));
  const m = db(MALLORY);
  await assertFails(getDoc(ePath(m, 'h1', 'e1')));
  await assertFails(getDoc(wPath(m, 'h1', 'cash')));
  await assertFails(setDoc(ePath(m, 'h1', 'x'), expense('mallory')));
  await assertFails(setDoc(doc(m, 'expenses', 'x'), expense('mallory')), 'no root collection');
});

// =================================================================== PHASE 4A — FAMILY & MEMBERS
// Distinct identities (each its own Firebase Auth uid/email) — security proven at rules level.
const OWNER_A = { uid: 'ownerA', email: 'owner@a.test' };
const ADMIN_A = { uid: 'adminA', email: 'admin@a.test' };
const MEMBER_WIFE = { uid: 'wife', email: 'wife@a.test' };
const CHILD_A = { uid: 'childA', email: 'child@a.test' };
const VIEWER_A = { uid: 'viewerA', email: 'viewer@a.test' };
const MEMBER_OTHER = { uid: 'otherA', email: 'other@a.test' };
const OWNER_HOME_B = { uid: 'ownerB', email: 'owner@b.test' };
import { buildInvite, buildAcceptWrites, generateCode } from '../../src/core/family/invite-model.js';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
const rnd = (n) => [...nodeRandomBytes(n)];

async function family() {
  await bootstrap(OWNER_A, 'hA');
  await bootstrap(OWNER_HOME_B, 'hB');
  await seedMember('hA', ADMIN_A, 'admin');
  await seedMember('hA', VIEWER_A, 'viewer');
  await seedMember('hA', MEMBER_OTHER, 'member');
}
async function invite(by, { type = 'adult', guardianUids = [], ttlMs, mutate } = {}) {
  const code = generateCode(rnd);
  let data = buildInvite({ home: { id: 'hA', name: '' }, uid: by.uid, type, guardianUids, nowMillis: Date.now(), now: serverTimestamp() });
  // withSecurityRulesDisabled() resolves to undefined — capture the value inside the callback.
  let homeName;
  await env.withSecurityRulesDisabled(async (c) => { homeName = (await getDoc(doc(c.firestore(), 'homes', 'hA'))).data().name; });
  data.homeName = homeName;
  if (ttlMs !== undefined) data.expiresAtMillis = Date.now() + ttlMs;
  if (mutate) data = mutate(data);
  return { code, data, write: () => setDoc(doc(db(by), 'invites', code), data) };
}
function acceptBatch(user, code, inv, { profile = null, mutate } = {}) {
  let writes = buildAcceptWrites({ code, invite: inv, identity: user, displayName: user.uid, existingMember: null, profile, now: serverTimestamp() });
  if (mutate) writes = mutate(writes);
  const f = db(user); const b = writeBatch(f);
  for (const w of writes) b[w.mode](doc(f, ...w.path), w.data);
  return b;
}

test('4A invites: owner/admin create; member/viewer/child/other-home cannot', async () => {
  await family();
  await assertSucceeds((await invite(OWNER_A)).write());
  await assertSucceeds((await invite(ADMIN_A, { type: 'viewer' })).write());
  await assertFails((await invite(MEMBER_OTHER)).write());
  await assertFails((await invite(VIEWER_A)).write());
  await assertFails((await invite(OWNER_HOME_B)).write(), 'cross-home');
});

test('4A invites: role escalation — admin cannot invite admin/owner; nobody invites owner; bad shapes', async () => {
  await family();
  await assertFails((await invite(ADMIN_A, { type: 'admin' })).write());
  await assertFails((await invite(OWNER_A, { mutate: (d) => ({ ...d, roleId: 'owner' }) })).write());
  await assertFails((await invite(OWNER_A, { mutate: (d) => ({ ...d, createdBy: ADMIN_A.uid }) })).write(), 'spoofed inviter');
  await assertFails((await invite(OWNER_A, { ttlMs: 30 * 86400000 })).write(), 'expiry > 14 days');
  await assertFails((await invite(OWNER_A, { mutate: (d) => ({ ...d, homeName: 'Fake' }) })).write());
  await assertFails((await invite(OWNER_A, { type: 'child', guardianUids: ['ownerA'], mutate: (d) => ({ ...d, guardianUids: [] }) })).write(), 'child invite needs guardians');
  await assertFails((await invite(OWNER_A, { mutate: (d) => ({ ...d, guardianUids: ['wife'] }) })).write(), 'adults have no guardians');
  await assertSucceeds((await invite(OWNER_A, { type: 'child', guardianUids: ['ownerA'] })).write());
});

test('4A accept: valid invite creates membership + profile atomically, bound to the caller', async () => {
  await family();
  const i = await invite(OWNER_A); await i.write();
  await assertSucceeds(acceptBatch(MEMBER_WIFE, i.code, i.data).commit());
  let m;   // withSecurityRulesDisabled() resolves to undefined — capture inside the callback
  await env.withSecurityRulesDisabled(async (c) => { m = (await getDoc(doc(c.firestore(), 'homes', 'hA', 'members', 'wife'))).data(); });
  if (m.roleId !== 'member' || m.status !== 'active') throw new Error('membership not created as invited');
  await assertSucceeds(getDoc(doc(db(MEMBER_WIFE), 'homes', 'hA')));
});

test('4A accept: used / cancelled / expired / mutated role / other home / half-batch all denied', async () => {
  await family();
  const i = await invite(OWNER_A); await i.write();
  await assertSucceeds(acceptBatch(MEMBER_WIFE, i.code, i.data).commit());
  await assertFails(acceptBatch(CHILD_A, i.code, i.data).commit(), 'single use');
  // Expired: create a VALID invite (the rules rightly refuse creating one that is already expired),
  // then let it expire by moving expiresAtMillis into the past with rules disabled (= time passing).
  const exp = await invite(OWNER_A); await assertSucceeds(exp.write());
  await env.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), 'invites', exp.code), { expiresAtMillis: Date.now() - 60000 }); });
  await assertFails(acceptBatch(CHILD_A, exp.code, { ...exp.data, expiresAtMillis: Date.now() - 60000 }).commit(), 'expired');
  const j = await invite(OWNER_A); await assertSucceeds(j.write());
  await assertFails(acceptBatch(CHILD_A, j.code, j.data, { mutate: (w) => w.map((x) => (x.path[2] === 'members' ? { ...x, data: { ...x.data, roleId: 'admin' } } : x)) }).commit(), 'role escalation');
  await assertFails(acceptBatch(CHILD_A, j.code, j.data, { mutate: (w) => w.filter((x) => x.path[0] !== 'invites') }).commit(), 'membership without accepting');
  await assertFails(acceptBatch(CHILD_A, j.code, j.data, { mutate: (w) => w.filter((x) => x.path[0] === 'invites') }).commit(), 'accept without membership');
  await assertFails(acceptBatch(CHILD_A, j.code, j.data, { mutate: (w) => w.map((x) => (x.path[0] === 'invites' ? { ...x, data: { ...x.data, acceptedBy: 'someoneElse' } } : x)) }).commit());
  await assertFails(acceptBatch(CHILD_A, j.code, { ...j.data, homeId: 'hB' }).commit(), 'cross-home substitution');
  await assertFails(updateDoc(doc(db(MEMBER_OTHER), 'invites', j.code), { status: 'cancelled', cancelledBy: 'otherA', cancelledAt: serverTimestamp() }), 'member cannot cancel');
  await assertSucceeds(updateDoc(doc(db(ADMIN_A), 'invites', j.code), { status: 'cancelled', cancelledBy: 'adminA', cancelledAt: serverTimestamp() }));
  await assertFails(acceptBatch(CHILD_A, j.code, j.data).commit(), 'cancelled');
  await assertFails(deleteDoc(doc(db(OWNER_A), 'invites', j.code)));
  await assertFails(getDocs(query(collection(db(MEMBER_OTHER), 'invites'), where('homeId', '==', 'hA'))), 'no listing without members.invite');
});

test('4A roles: self-promotion denied; member→owner denied; admin limits; owner protected', async () => {
  await family();
  await seedMember('hA', MEMBER_WIFE, 'member');
  const up = (who, target, data) => updateDoc(doc(db(who), 'homes', 'hA', 'members', target.uid), { ...data, updatedAt: serverTimestamp() });
  await assertFails(up(MEMBER_WIFE, MEMBER_WIFE, { roleId: 'admin' }));
  await assertFails(up(MEMBER_WIFE, MEMBER_WIFE, { roleId: 'owner' }));
  await assertFails(up(MEMBER_WIFE, MEMBER_OTHER, { roleId: 'viewer' }), 'member cannot manage roles');
  await assertFails(up(VIEWER_A, MEMBER_OTHER, { status: 'removed' }));
  await assertFails(up(ADMIN_A, OWNER_A, { status: 'removed' }), 'owner cannot be removed');
  await assertFails(up(OWNER_A, OWNER_A, { status: 'left' }), 'last owner cannot leave');
  await assertFails(up(ADMIN_A, MEMBER_WIFE, { roleId: 'admin' }), 'admin cannot create peers');
  await assertSucceeds(up(OWNER_A, MEMBER_WIFE, { roleId: 'viewer' }));
  await assertFails(updateDoc(doc(db(MEMBER_WIFE), 'homes', 'hA', 'roles', 'member'), { permissions: ['*'], updatedAt: serverTimestamp() }), 'no role doc edits');
});

test('4A guardians: explicit, managed with members.manageChildren only; child cannot self-assign', async () => {
  await family();
  await seedMember('hA', MEMBER_WIFE, 'member');
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'homes', 'hA', 'members', 'childA'),
    { uid: 'childA', email: CHILD_A.email, displayName: 'kid', roleId: 'child', status: 'active', addedBy: 'ownerA', relationship: 'child', guardianUids: ['ownerA'], joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() }));
  const g = (who, list) => updateDoc(doc(db(who), 'homes', 'hA', 'members', 'childA'), { guardianUids: list, updatedAt: serverTimestamp() });
  await assertSucceeds(g(OWNER_A, ['ownerA', 'wife']));
  await assertFails(g(MEMBER_WIFE, ['wife']), 'guardian is not admin');
  await assertFails(g(CHILD_A, ['childA']));
  await assertFails(g(OWNER_A, []), 'at least one guardian');
  await assertFails(g(OWNER_A, ['ownerB']), 'guardian must be an active member here');
});

test('4A removal: revoked member loses access; history stays; private wallet does not become owner-visible', async () => {
  await family();
  await seedMember('hA', MEMBER_WIFE, 'member');
  const w = db(MEMBER_WIFE);
  await assertSucceeds(setDoc(doc(w, 'homes', 'hA', 'wallets', 'wifeW'), { name: 'Wife', type: 'cash', scope: 'personal', ownerUid: 'wife', visibility: 'private', sharedWith: [], readers: ['wife'], currency: 'EGP', active: true, archivedAt: null, archivedBy: null, createdBy: 'wife', createdAt: serverTimestamp(), updatedBy: 'wife', updatedAt: serverTimestamp(), schemaVersion: 1 }));
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'homes', 'hA', 'expenses', 'hist'),
    { amountMinor: 75000, currency: 'EGP', date: '2026-10-05', category: 'groceries', note: null, merchant: null, paymentMethod: null, walletId: null, budgetCycleId: null, paidBy: 'wife', commitmentId: null, commitmentDueDate: null, audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, voidReason: null, source: 'app', createdBy: 'wife', createdAt: new Date(), updatedBy: 'wife', updatedAt: new Date(), schemaVersion: 1 }));
  await assertSucceeds(updateDoc(doc(db(OWNER_A), 'homes', 'hA', 'members', 'wife'), { status: 'removed', updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(w, 'homes', 'hA')), 'no home access');
  await assertFails(getDoc(doc(w, 'homes', 'hA', 'wallets', 'wifeW')), 'removed: no access even to own record here');
  await assertFails(getDoc(doc(db(OWNER_A), 'homes', 'hA', 'wallets', 'wifeW')), 'owner still cannot read it');
  await assertSucceeds(getDoc(doc(db(OWNER_A), 'homes', 'hA', 'expenses', 'hist')), 'history survives with createdBy=wife');
  await assertFails(deleteDoc(doc(db(OWNER_A), 'homes', 'hA', 'members', 'wife')));
});

test('4A finance privacy across real accounts: wife private wallet, sharing, child & guardian', async () => {
  await family();
  await seedMember('hA', MEMBER_WIFE, 'member');
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'homes', 'hA', 'members', 'childA'),
    { uid: 'childA', email: CHILD_A.email, displayName: 'kid', roleId: 'child', status: 'active', addedBy: 'ownerA', relationship: 'child', guardianUids: ['wife'], joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() }));
  const W = (owner, id, extra) => ({ name: id, type: 'cash', scope: 'personal', ownerUid: owner, visibility: 'private', sharedWith: [], readers: [owner], currency: 'EGP', active: true, archivedAt: null, archivedBy: null, createdBy: owner, createdAt: serverTimestamp(), updatedBy: owner, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
  await assertSucceeds(setDoc(doc(db(MEMBER_WIFE), 'homes', 'hA', 'wallets', 'wifeW'), W('wife', 'wifeW')));
  await assertSucceeds(getDoc(doc(db(MEMBER_WIFE), 'homes', 'hA', 'wallets', 'wifeW')), 'wife reads');
  await assertFails(getDoc(doc(db(OWNER_A), 'homes', 'hA', 'wallets', 'wifeW')), 'owner denied');
  await assertFails(getDoc(doc(db(MEMBER_OTHER), 'homes', 'hA', 'wallets', 'wifeW')), 'other member denied');
  await assertFails(getDocs(query(collection(db(OWNER_A), 'homes', 'hA', 'expenses'), where('readers', 'array-contains', 'wife'))), 'owner cannot query her history');
  await assertSucceeds(updateDoc(doc(db(MEMBER_WIFE), 'homes', 'hA', 'wallets', 'wifeW'), { visibility: 'shared', sharedWith: ['ownerA'], readers: ['ownerA', 'wife'], updatedBy: 'wife', updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(db(OWNER_A), 'homes', 'hA', 'wallets', 'wifeW')), 'owner allowed after explicit share');
  // Creating a wallet OWNED BY someone else needs expenses.manageWallets (owner/admin), not guardianship.
  await assertFails(setDoc(doc(db(MEMBER_WIFE), 'homes', 'hA', 'wallets', 'kidW'), W('childA', 'kidW', { type: 'allowance', visibility: 'shared', sharedWith: ['wife'], readers: ['childA', 'wife'], createdBy: 'wife', updatedBy: 'wife' })));
  await assertSucceeds(setDoc(doc(db(OWNER_A), 'homes', 'hA', 'wallets', 'kidW'), W('childA', 'kidW', { type: 'allowance', visibility: 'shared', sharedWith: ['wife'], readers: ['childA', 'wife'], createdBy: 'ownerA', updatedBy: 'ownerA' })), 'owner creates allowance shared with the guardian');
  await assertSucceeds(getDoc(doc(db(MEMBER_WIFE), 'homes', 'hA', 'wallets', 'kidW')), 'guardian reads child wallet');
  await assertFails(getDoc(doc(db(MEMBER_OTHER), 'homes', 'hA', 'wallets', 'kidW')), 'unrelated member denied');
});

test('4A child: sees own allowance, not household finance; viewer cannot modify', async () => {
  await family();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'homes', 'hA', 'members', 'childA'), { uid: 'childA', email: CHILD_A.email, displayName: 'kid', roleId: 'child', status: 'active', addedBy: 'ownerA', relationship: 'child', guardianUids: ['ownerA'], joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
    await setDoc(doc(f, 'homes', 'hA', 'wallets', 'kidW'), { name: 'Omar', type: 'allowance', scope: 'personal', ownerUid: 'childA', visibility: 'shared', sharedWith: ['ownerA'], readers: ['childA', 'ownerA'], currency: 'EGP', active: true, archivedAt: null, archivedBy: null, createdBy: 'ownerA', createdAt: new Date(), updatedBy: 'ownerA', updatedAt: new Date(), schemaVersion: 1 });
    await setDoc(doc(f, 'homes', 'hA', 'wallets', 'bank'), { name: 'Bank', type: 'bank', scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [], currency: 'EGP', active: true, archivedAt: null, archivedBy: null, createdBy: 'ownerA', createdAt: new Date(), updatedBy: 'ownerA', updatedAt: new Date(), schemaVersion: 1 });
  });
  const kid = db(CHILD_A);
  await assertSucceeds(getDoc(doc(kid, 'homes', 'hA', 'wallets', 'kidW')));
  await assertSucceeds(getDoc(doc(db(OWNER_A), 'homes', 'hA', 'wallets', 'kidW')), 'guardian (shared) reads');
  await assertFails(getDoc(doc(db(MEMBER_OTHER), 'homes', 'hA', 'wallets', 'kidW')), 'unrelated member denied');
  await assertFails(getDoc(doc(kid, 'homes', 'hA', 'wallets', 'bank')), 'child denied household bank');
  await assertFails(getDocs(query(collection(kid, 'homes', 'hA', 'expenses'), where('audience', '==', 'household'))), 'child denied household expenses');
  await assertFails(getDocs(collection(kid, 'homes', 'hA', 'members')), 'child cannot list members');
  await assertFails(setDoc(doc(db(VIEWER_A), 'homes', 'hA', 'expenses', 'v1'), { amountMinor: 1 }), 'viewer cannot write');
  await assertFails(getDoc(doc(db(OWNER_HOME_B), 'homes', 'hA', 'wallets', 'bank')), 'cross-home denied');
});

// Phase 4A regression (found by browser test M18/M19): a child must not be able to un-share or
// archive an allowance wallet that a guardian created — guardian oversight cannot be removed.
test('4A: child cannot re-share or archive a guardian-created allowance wallet; guardian can', async () => {
  await bootstrap(ALICE, 'h1');
  await seedMember('h1', BOB, 'child');
  await env.withSecurityRulesDisabled(async (ctx) => {
    const __f = ctx.firestore();  // one instance per context (a 2nd firestore() call throws)
    await setDoc(doc(__f, 'homes', 'h1', 'members', 'bob'), { relationship: 'child', guardianUids: ['alice'] }, { merge: true });
    await setDoc(doc(__f, 'homes', 'h1', 'wallets', 'allow'), {
      name: 'Bob allowance', type: 'allowance', scope: 'personal', ownerUid: 'bob', visibility: 'shared', sharedWith: ['alice'],
      readers: ['alice', 'bob'], currency: 'EGP', active: true, archivedAt: null, archivedBy: null,
      createdBy: 'alice', createdAt: new Date(), updatedBy: 'alice', updatedAt: new Date(), schemaVersion: 1 });
  });
  const unshare = (f, uid) => updateDoc(doc(f, 'homes', 'h1', 'wallets', 'allow'), { visibility: 'private', sharedWith: [], readers: ['bob'], updatedBy: uid, updatedAt: serverTimestamp() });
  await assertFails(unshare(db(BOB), 'bob'), 'child cannot remove guardians');
  await assertFails(updateDoc(doc(db(BOB), 'homes', 'h1', 'wallets', 'allow'), { active: false, archivedAt: serverTimestamp(), archivedBy: 'bob', updatedBy: 'bob', updatedAt: serverTimestamp() }), 'child cannot archive');
  await assertSucceeds(getDoc(doc(db(BOB), 'homes', 'h1', 'wallets', 'allow')), 'child still reads own allowance');
  await assertSucceeds(updateDoc(doc(db(ALICE), 'homes', 'h1', 'wallets', 'allow'), { name: 'Bob pocket money', updatedBy: 'alice', updatedAt: serverTimestamp() }), 'guardian-creator manages it');
});

// =================================================================== PHASE 5 — LIFE SAVINGS & ZAKAT
// Identities: OWNER_A (owner), ADMIN_A, VIEWER_A, MEMBER_OTHER, MEMBER_WIFE (member), CHILD_A
// (child; explicit guardian = MEMBER_WIFE — the Owner is deliberately NOT a guardian), OWNER_HOME_B.
const svRef = (u, name, id, h = 'hA') => doc(db(u), 'homes', h, name, id);
const nowTs = () => serverTimestamp();
function assetDoc(by, extra = {}) {
  return { name: 'Savings', type: 'cash', scope: 'personal', ownerUid: by.uid, visibility: 'private', sharedWith: [], currency: 'EGP', purity: null,
    institution: null, notes: null, zakatTreatment: 'included', allocations: [], audience: 'restricted', readers: [by.uid], active: true,
    archivedAt: null, archivedBy: null, createdBy: by.uid, createdAt: nowTs(), updatedBy: by.uid, updatedAt: nowTs(), schemaVersion: 1, ...extra };
}
function eventDoc(by, assetId, asset, extra = {}) {
  return { assetId, type: 'contribution', qty: 1000, unit: 'minor', currency: 'EGP', date: '2026-10-06', note: null, transferId: null, walletId: null,
    costMinor: null, costCurrency: null, audience: asset.audience, readers: asset.readers, status: 'active', createdBy: by.uid, createdAt: nowTs(), schemaVersion: 1, ...extra };
}
async function savingsHome() {
  await family();
  await seedMember('hA', MEMBER_WIFE, 'member');
  await seedMember('hA', CHILD_A, 'child');
  await env.withSecurityRulesDisabled(async (c) => {
    const __f = c.firestore();  // one instance per context (a 2nd firestore() call throws)
    await setDoc(doc(__f, 'homes', 'hA', 'members', CHILD_A.uid), { relationship: 'child', guardianUids: [MEMBER_WIFE.uid] }, { merge: true });
    await setDoc(doc(__f, 'homes', 'hA', 'savingsAssets', 'wifePriv'), { ...assetDoc(MEMBER_WIFE), createdAt: new Date(), updatedAt: new Date() });
  });
}

test('5 CRITICAL: owner DENIED wife\'s private savings; wife reads her own; share → owner reads; un-share → denied again', async () => {
  await savingsHome();
  await assertSucceeds(getDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'wifePriv')), 'wife reads her own private savings');
  await assertDenied(getDoc(svRef(OWNER_A, 'savingsAssets', 'wifePriv')), 'Home owner denied');
  await assertDenied(getDocs(query(collection(db(OWNER_A), 'homes', 'hA', 'savingsAssets'), where('readers', 'array-contains', MEMBER_WIFE.uid))), 'owner cannot query her records');
  await assertDenied(getDoc(svRef(MEMBER_OTHER, 'savingsAssets', 'wifePriv')), 'other adult denied');
  await assertSucceeds(updateDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'wifePriv'), { visibility: 'shared', sharedWith: [OWNER_A.uid], readers: [MEMBER_WIFE.uid, OWNER_A.uid], updatedBy: MEMBER_WIFE.uid, updatedAt: nowTs() }));
  await assertSucceeds(getDoc(svRef(OWNER_A, 'savingsAssets', 'wifePriv')), 'after explicit share');
  await assertSucceeds(updateDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'wifePriv'), { visibility: 'private', sharedWith: [], readers: [MEMBER_WIFE.uid], updatedBy: MEMBER_WIFE.uid, updatedAt: nowTs() }));
  await assertDenied(getDoc(svRef(OWNER_A, 'savingsAssets', 'wifePriv')), 'share removed → denied again');
});

test('5 assets: createdBy forgery, ownerUid change, readers mismatch, owner creating for another adult, hard delete — all denied', async () => {
  await savingsHome();
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'x1'), assetDoc(MEMBER_WIFE, { createdBy: OWNER_A.uid })), 'forged createdBy');
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'x2'), assetDoc(MEMBER_WIFE, { readers: [MEMBER_WIFE.uid, OWNER_A.uid] })), 'readers must equal owner + sharedWith');
  await assertFails(setDoc(svRef(OWNER_A, 'savingsAssets', 'x3'), assetDoc(OWNER_A, { ownerUid: MEMBER_WIFE.uid, readers: [MEMBER_WIFE.uid] })), 'owner cannot create assets "owned" by another adult');
  await assertFails(updateDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'wifePriv'), { ownerUid: OWNER_A.uid, updatedBy: MEMBER_WIFE.uid, updatedAt: nowTs() }), 'ownerUid immutable');
  await assertFails(updateDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'wifePriv'), { type: 'gold', updatedBy: MEMBER_WIFE.uid, updatedAt: nowTs() }), 'type immutable');
  await assertFails(deleteDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'wifePriv')), 'no hard delete');
  await assertSucceeds(setDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'gold1'), assetDoc(MEMBER_WIFE, { type: 'gold', currency: null, purity: '21' })));
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'gold2'), assetDoc(MEMBER_WIFE, { type: 'gold', currency: null, purity: '20' })), 'bad karat');
});

test('5 household assets: manageHousehold to create; savings.view to read; child/viewer limits; allocations = 100%', async () => {
  await savingsHome();
  const hh = { scope: 'home', ownerUid: null, visibility: 'household', audience: 'household', readers: [], allocations: [{ uid: OWNER_A.uid, bps: 6000 }, { uid: MEMBER_WIFE.uid, bps: 4000 }] };
  await assertSucceeds(setDoc(svRef(OWNER_A, 'savingsAssets', 'fund'), assetDoc(OWNER_A, hh)));
  await assertFails(setDoc(svRef(OWNER_A, 'savingsAssets', 'fund2'), assetDoc(OWNER_A, { ...hh, allocations: [{ uid: OWNER_A.uid, bps: 5000 }] })), 'shares must total 100%');
  await assertFails(setDoc(svRef(MEMBER_OTHER, 'savingsAssets', 'fund3'), assetDoc(MEMBER_OTHER, hh)), 'member lacks manageHousehold');
  await assertSucceeds(getDoc(svRef(MEMBER_OTHER, 'savingsAssets', 'fund')), 'member has savings.view');
  await assertSucceeds(getDoc(svRef(VIEWER_A, 'savingsAssets', 'fund')), 'viewer can read');
  await assertFails(setDoc(svRef(VIEWER_A, 'savingsAssets', 'v'), assetDoc(VIEWER_A)), 'viewer cannot create');
  await assertFails(getDoc(svRef(CHILD_A, 'savingsAssets', 'fund')), 'child cannot see household savings');
  await assertFails(getDocs(query(collection(db(CHILD_A), 'homes', 'hA', 'savingsAssets'), where('visibility', '==', 'household'))), 'nor query household totals');
});

test('5 child savings: guardian (not the owner) creates; child + guardian read; child cannot un-share; owner denied', async () => {
  await savingsHome();
  const childAsset = { ownerUid: CHILD_A.uid, visibility: 'shared', sharedWith: [MEMBER_WIFE.uid], readers: [CHILD_A.uid, MEMBER_WIFE.uid] };
  await assertFails(setDoc(svRef(OWNER_A, 'savingsAssets', 'kidO'), assetDoc(OWNER_A, childAsset)), 'Home owner is not this child\'s guardian');
  await assertSucceeds(setDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'kid'), assetDoc(MEMBER_WIFE, childAsset)), 'explicit guardian');
  await assertSucceeds(getDoc(svRef(CHILD_A, 'savingsAssets', 'kid')));
  await assertSucceeds(getDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'kid')));
  await assertFails(getDoc(svRef(OWNER_A, 'savingsAssets', 'kid')));
  await assertFails(updateDoc(svRef(CHILD_A, 'savingsAssets', 'kid'), { visibility: 'private', sharedWith: [], readers: [CHILD_A.uid], updatedBy: CHILD_A.uid, updatedAt: nowTs() }), 'child cannot remove guardian');
  await assertSucceeds(updateDoc(svRef(MEMBER_WIFE, 'savingsAssets', 'kid'), { name: 'Omar savings', updatedBy: MEMBER_WIFE.uid, updatedAt: nowTs() }));
});

test('5 events: labels copied from asset; others cannot write; transfers need both legs; immutable; no delete', async () => {
  await savingsHome();
  const a = assetDoc(MEMBER_WIFE);
  // asset + opening event in ONE batch
  const b = writeBatch(db(MEMBER_WIFE));
  b.set(svRef(MEMBER_WIFE, 'savingsAssets', 'n1'), a);
  b.set(svRef(MEMBER_WIFE, 'savingsEvents', 'e1'), eventDoc(MEMBER_WIFE, 'n1', a, { type: 'opening' }));
  await assertSucceeds(b.commit());
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'savingsEvents', 'e2'), eventDoc(MEMBER_WIFE, 'n1', a, { readers: [MEMBER_WIFE.uid, OWNER_A.uid] })), 'labels must match the asset');
  await assertFails(setDoc(svRef(OWNER_A, 'savingsEvents', 'e3'), eventDoc(OWNER_A, 'n1', a)), 'owner cannot write into her asset');
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'savingsEvents', 'e4'), eventDoc(MEMBER_WIFE, 'n1', a, { type: 'withdrawal', qty: 500 })), 'withdrawal must be negative');
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'savingsEvents', 'e5'), eventDoc(MEMBER_WIFE, 'n1', a, { unit: 'mg' })), 'unit must match asset');
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'savingsEvents', 't1_out'), eventDoc(MEMBER_WIFE, 'n1', a, { type: 'transfer_out', qty: -100, transferId: 't1' })), 'single leg denied');
  const b2 = writeBatch(db(MEMBER_WIFE));
  b2.set(svRef(MEMBER_WIFE, 'savingsAssets', 'n2'), assetDoc(MEMBER_WIFE));
  b2.set(svRef(MEMBER_WIFE, 'savingsEvents', 't2_out'), eventDoc(MEMBER_WIFE, 'n1', a, { type: 'transfer_out', qty: -100, transferId: 't2' }));
  b2.set(svRef(MEMBER_WIFE, 'savingsEvents', 't2_in'), eventDoc(MEMBER_WIFE, 'n2', a, { type: 'transfer_in', qty: 100, transferId: 't2' }));
  await assertSucceeds(b2.commit(), 'both legs together');
  await assertFails(updateDoc(svRef(MEMBER_WIFE, 'savingsEvents', 'e1'), { qty: 999999 }), 'quantities immutable');
  await assertFails(deleteDoc(svRef(MEMBER_WIFE, 'savingsEvents', 'e1')));
  await assertFails(getDoc(svRef(OWNER_A, 'savingsEvents', 'e1')), 'owner cannot read her history');
});

test('5 wallet ↔ savings: movement and savings leg only together; never an expense', async () => {
  await savingsHome();
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'homes', 'hA', 'wallets', 'bank'), {
    name: 'Bank', type: 'bank', scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [], currency: 'EGP', active: true,
    archivedAt: null, archivedBy: null, createdBy: OWNER_A.uid, createdAt: new Date(), updatedBy: OWNER_A.uid, updatedAt: new Date(), schemaVersion: 1 }));
  const fund = assetDoc(OWNER_A, { scope: 'home', ownerUid: null, visibility: 'household', audience: 'household', readers: [] });
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'homes', 'hA', 'savingsAssets', 'fund'), { ...fund, createdAt: new Date(), updatedAt: new Date() }));
  const mv = { type: 'savings', amountMinor: 1000000, currency: 'EGP', date: '2026-10-06', fromWalletId: 'bank', toWalletId: null, cycleId: null, note: null,
    savingsTransferId: 'w1', audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null,
    createdBy: OWNER_A.uid, createdAt: nowTs(), updatedBy: OWNER_A.uid, updatedAt: nowTs(), schemaVersion: 1 };
  await assertFails(setDoc(svRef(OWNER_A, 'walletMovements', 'sv_w1'), mv), 'movement alone denied');
  const b = writeBatch(db(OWNER_A));
  b.set(svRef(OWNER_A, 'walletMovements', 'sv_w1'), mv);
  b.set(svRef(OWNER_A, 'savingsEvents', 'w1_in'), eventDoc(OWNER_A, 'fund', fund, { type: 'transfer_in', qty: 1000000, transferId: 'w1', walletId: 'bank' }));
  await assertSucceeds(b.commit());
});

test('5 prices: append-only, manual only from clients, recent timestamp; any active member reads', async () => {
  await savingsHome();
  const qd = (by, extra = {}) => ({ kind: 'metal', key: 'gold-21', priceMinor: 400000, currency: 'EGP', source: 'manual', observedAt: Date.now(), note: null, createdBy: by.uid, createdAt: nowTs(), schemaVersion: 1, ...extra });
  await assertSucceeds(setDoc(svRef(MEMBER_WIFE, 'priceQuotes', 'p1'), qd(MEMBER_WIFE)));
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'priceQuotes', 'p2'), qd(MEMBER_WIFE, { source: 'http' })), 'clients cannot claim a live source');
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'priceQuotes', 'p3'), qd(MEMBER_WIFE, { observedAt: Date.now() - 86400000 })), 'no back-dating');
  await assertFails(setDoc(svRef(VIEWER_A, 'priceQuotes', 'p4'), qd(VIEWER_A)), 'viewer lacks savings.prices');
  await assertFails(updateDoc(svRef(MEMBER_WIFE, 'priceQuotes', 'p1'), { priceMinor: 1 }), 'append-only');
  await assertSucceeds(getDoc(svRef(CHILD_A, 'priceQuotes', 'p1')));
  await assertFails(getDoc(svRef(OWNER_HOME_B, 'priceQuotes', 'p1')), 'cross-home');
});

test('5 zakat: private per owner; guardian for child; payment links exactly one expense; append-only', async () => {
  await savingsHome();
  const prof = (by, owner, v, extra = {}) => ({ kind: 'profile', ownerUid: owner.uid, version: v, settings: { nisabBasis: 'gold', goldMg: 85000, goldPurity: '21', silverMg: 595000, silverPurity: '999', manualNisabMinor: null, rateBps: 250, hawlCalendar: 'hijri', belowNisabPolicy: 'reset', methodologyNote: null },
    readers: [...new Set([owner.uid, by.uid])], createdBy: by.uid, createdAt: nowTs(), schemaVersion: 1, ...extra });
  await assertSucceeds(setDoc(svRef(MEMBER_WIFE, 'zakatRecords', 'wife_p1'), prof(MEMBER_WIFE, MEMBER_WIFE, 1)));
  await assertFails(getDoc(svRef(OWNER_A, 'zakatRecords', 'wife_p1')), 'owner cannot read wife\'s Zakat');
  await assertFails(setDoc(svRef(OWNER_A, 'zakatRecords', 'wife_p2'), prof(OWNER_A, MEMBER_WIFE, 2)), 'owner cannot write wife\'s Zakat');
  await assertSucceeds(setDoc(svRef(MEMBER_WIFE, 'zakatRecords', 'childA_p1'), prof(MEMBER_WIFE, CHILD_A, 1)), 'guardian for child');
  await assertFails(setDoc(svRef(OWNER_A, 'zakatRecords', 'childA_p2'), prof(OWNER_A, CHILD_A, 2)), 'owner is not the guardian');
  await assertFails(updateDoc(svRef(MEMBER_WIFE, 'zakatRecords', 'wife_p1'), { version: 9 }), 'history immutable');
  await assertFails(deleteDoc(svRef(MEMBER_WIFE, 'zakatRecords', 'wife_p1')));
  const pay = { kind: 'payment', ownerUid: MEMBER_WIFE.uid, date: '2026-10-06', amountMinor: 712500, currency: 'EGP', snapshotId: null, note: null,
    linkedExpenseId: 'zk_pay1', readers: [MEMBER_WIFE.uid], createdBy: MEMBER_WIFE.uid, createdAt: nowTs(), schemaVersion: 1 };
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'zakatRecords', 'pay1'), pay), 'linked expense must exist in the same batch');
  const exp = { amountMinor: 712500, currency: 'EGP', date: '2026-10-06', category: 'zakat', note: null, merchant: null, paymentMethod: null, walletId: null,
    budgetCycleId: null, paidBy: MEMBER_WIFE.uid, commitmentId: null, commitmentDueDate: null, audience: 'household', readers: [], status: 'active',
    voidedAt: null, voidedBy: null, voidReason: null, source: 'app', createdBy: MEMBER_WIFE.uid, createdAt: nowTs(), updatedBy: MEMBER_WIFE.uid, updatedAt: nowTs(), schemaVersion: 1 };
  const b = writeBatch(db(MEMBER_WIFE));
  b.set(svRef(MEMBER_WIFE, 'zakatRecords', 'pay1'), pay);
  b.set(svRef(MEMBER_WIFE, 'expenses', 'zk_pay1'), exp);
  await assertSucceeds(b.commit());
  await assertFails(setDoc(svRef(MEMBER_WIFE, 'expenses', 'zk_pay1'), exp), 'a second expense with the same id is refused');
  await assertFails(setDoc(svRef(CHILD_A, 'zakatRecords', 'childA_p9'), prof(CHILD_A, CHILD_A, 9)), 'child lacks savings.zakat');
});

test('5 cross-home: home B owner can neither read nor write home A savings', async () => {
  await savingsHome();
  await assertFails(getDoc(svRef(OWNER_HOME_B, 'savingsAssets', 'wifePriv')));
  await assertFails(setDoc(svRef(OWNER_HOME_B, 'savingsAssets', 'b1'), assetDoc(OWNER_HOME_B)));
  await assertSucceeds(setDoc(doc(db(OWNER_HOME_B), 'homes', 'hB', 'savingsAssets', 'b1'), assetDoc(OWNER_HOME_B)), 'own home works');
});

// =================================================================== PHASE 5.1 — LEGACY HOME ADOPTION (L1–L20)
// Fixture: homes/hL created by an older HomeHub (createdBy ownerA), users/ownerA.defaultHomeId = hL,
// NO members, NO roles, plus business data that adoption must never touch.
import { defaultRoles as _legacyDefaultRoles } from '../../src/modules/index.js';
async function legacyHome({ creator = OWNER_A, roles = [], extraMembers = [], profileFor = OWNER_A, defaultHomeId = 'hL' } = {}) {
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'homes', 'hL'), { name: 'Old Adel Home', createdBy: creator.uid, createdAt: new Date('2025-01-01') });
    await setDoc(doc(f, 'users', profileFor.uid), { email: profileFor.email, displayName: 'X', defaultHomeId, language: 'ar', theme: 'system', schemaVersion: 1, createdAt: new Date(), updatedAt: new Date() });
    await setDoc(doc(f, 'homes', 'hL', 'devices', 'd1'), { name: 'Fridge' });
    await setDoc(doc(f, 'homes', 'hL', 'expenses', 'e1'), { amountMinor: 45000 });
    for (const [id, data] of roles) await setDoc(doc(f, 'homes', 'hL', 'roles', id), data);
    for (const m of extraMembers) await setDoc(doc(f, 'homes', 'hL', 'members', m.uid), { uid: m.uid, roleId: m.roleId, status: 'active' });
  });
}
function adoptionBatch(u, { homeId = 'hL', skip = [], member = {}, role = {}, extra = null } = {}) {
  const f = db(u); const b = writeBatch(f);
  b.set(doc(f, 'homes', homeId, 'members', u.uid), { uid: u.uid, email: u.email, displayName: 'Abdo', roleId: 'owner', status: 'active', addedBy: u.uid,
    joinedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(), legacyAdoption: true, ...member });
  for (const r of _legacyDefaultRoles()) {
    if (skip.includes(r.id)) continue;
    b.set(doc(f, 'homes', homeId, 'roles', r.id), { name: r.name, rank: r.rank, permissions: r.permissions, system: r.system, templateVersion: r.templateVersion,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...(role[r.id] || {}) });
  }
  if (extra) extra(b, f);
  return b.commit();
}

test('L1 anonymous cannot adopt or even read the legacy home', async () => {
  await legacyHome();
  await assertFails(getDoc(doc(anon(), 'homes', 'hL')));
  const f = anon(); const b = writeBatch(f);
  b.set(doc(f, 'homes', 'hL', 'members', 'x'), { uid: 'x', roleId: 'owner', status: 'active' });
  await assertFails(b.commit());
});

test('L2/L4/L13 a different user cannot read or adopt someone else\'s legacy home (any home id)', async () => {
  await legacyHome();
  await assertFails(getDoc(doc(db(MALLORY), 'homes', 'hL')), 'no read of another person\'s home');
  await assertFails(adoptionBatch(MALLORY), 'mallory is not the stored creator');
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'users', MALLORY.uid), { email: MALLORY.email, defaultHomeId: 'hL' }));
  await assertFails(adoptionBatch(MALLORY), 'pointing defaultHomeId at it does not help');
  await assertFails(adoptionBatch(OWNER_A, { homeId: 'hA' }), 'creator of hL cannot adopt a different home');
});

test('L3/L16/L17/L18 the stored creator adopts: own owner membership + five current roles; owner = ["*"], v9', async () => {
  await legacyHome();
  await assertSucceeds(getDoc(doc(db(OWNER_A), 'homes', 'hL')), 'creator may read own legacy home (detection)');
  await assertSucceeds(getDoc(doc(db(OWNER_A), 'homes', 'hL', 'roles', 'owner')), 'per-id role check for detection');
  await assertFails(getDocs(collection(db(OWNER_A), 'homes', 'hL', 'roles')), 'but no list');
  await assertSucceeds(adoptionBatch(OWNER_A));
  const owner = await getDoc(doc(db(OWNER_A), 'homes', 'hL', 'roles', 'owner'));
  assert.deepEqual([owner.data().permissions, owner.data().rank, owner.data().templateVersion], [['*'], 100, 9]);   // current template (v9: V6.4 B contacts)
  for (const r of ['admin', 'member', 'viewer', 'child']) assert.ok((await getDoc(doc(db(OWNER_A), 'homes', 'hL', 'roles', r))).exists(), r);
  await assertSucceeds(getDoc(doc(db(OWNER_A), 'homes', 'hL', 'devices', 'd1')), 'now a normal owner (L20 path)');
});

test('L5 createdBy cannot be changed before adopting; the home must be unchanged in the batch', async () => {
  await legacyHome({ creator: OWNER_A });
  await assertFails(updateDoc(doc(db(MALLORY), 'homes', 'hL'), { createdBy: MALLORY.uid }), 'non-member cannot edit the home');
  await assertFails(adoptionBatch(OWNER_A, { extra: (b, f) => b.update(doc(f, 'homes', 'hL'), { name: 'Renamed' }) }), 'no home edits inside adoption');
});

test('L6/L7/L8/L9 membership only for self, role owner, status active, marked; no owner membership elsewhere', async () => {
  await legacyHome();
  await assertFails(adoptionBatch(OWNER_A, { member: { roleId: 'admin' } }), 'roleId must be owner');
  await assertFails(adoptionBatch(OWNER_A, { member: { status: 'suspended' } }), 'status must be active');
  await assertFails(adoptionBatch(OWNER_A, { member: { legacyAdoption: false } }), 'must be marked');
  await assertFails(adoptionBatch(OWNER_A, { member: { addedBy: MALLORY.uid } }), 'addedBy must be self');
  const f = db(OWNER_A); const b = writeBatch(f);
  b.set(doc(f, 'homes', 'hL', 'members', MALLORY.uid), { uid: MALLORY.uid, email: MALLORY.email, displayName: 'M', roleId: 'owner', status: 'active', addedBy: OWNER_A.uid,
    joinedAt: serverTimestamp(), createdAt: serverTimestamp(), updatedAt: serverTimestamp(), legacyAdoption: true });
  await assertFails(b.commit(), 'creator cannot create memberships for others');
  await bootstrap(ALICE, 'h1');
  await assertFails(adoptionBatch(MALLORY, { homeId: 'h1' }), 'attacker cannot create an owner membership in an initialised home');
});

test('L10/L11/L12 existing Owner protected; second adoption denied; retry after success is refused safely', async () => {
  await legacyHome({ roles: [['owner', { name: 'Owner', rank: 100, permissions: ['*'], system: true, templateVersion: 6, createdAt: new Date(), updatedAt: new Date() }]] });
  await assertFails(adoptionBatch(OWNER_A, { skip: ['owner'] }), 'an existing owner role means "initialised": no adoption');
  await env.clearFirestore();
  await legacyHome();
  await assertSucceeds(adoptionBatch(OWNER_A));
  await assertFails(adoptionBatch(OWNER_A), 'second adoption denied');
  await assertFails(adoptionBatch(OWNER_A, { skip: ['owner', 'admin', 'member', 'viewer', 'child'] }), 'membership already exists');
});

test('L14 partial state: missing roles may be created, existing (custom) roles can never be overwritten', async () => {
  const custom = { name: 'Admin', rank: 80, permissions: ['rooms.view', 'custom.grant'], system: true, templateVersion: 2, createdAt: new Date(), updatedAt: new Date() };
  await legacyHome({ roles: [['admin', custom]] });
  await assertFails(adoptionBatch(OWNER_A), 'writing admin again = overwrite → denied (whole batch)');
  await assertSucceeds(adoptionBatch(OWNER_A, { skip: ['admin'] }), 'only missing roles');
  const a = await getDoc(doc(db(OWNER_A), 'homes', 'hL', 'roles', 'admin'));
  assert.deepEqual(a.data().permissions, ['rooms.view', 'custom.grant']);
});

test('L15 adoption cannot carry other writes (business data, profile, other roles)', async () => {
  await legacyHome();
  await assertFails(adoptionBatch(OWNER_A, { extra: (b, f) => b.update(doc(f, 'homes', 'hL', 'devices', 'd1'), { name: 'X' }) }), 'devices');
  await assertFails(adoptionBatch(OWNER_A, { extra: (b, f) => b.set(doc(f, 'homes', 'hL', 'expenses', 'e2'), { amountMinor: 1 }) }), 'expenses');
  await assertFails(adoptionBatch(OWNER_A, { extra: (b, f) => b.set(doc(f, 'homes', 'hL', 'roles', 'custom'), { name: 'C', rank: 1, permissions: [], system: true, templateVersion: 6, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }) }), 'non-system role');
  await assertFails(adoptionBatch(OWNER_A, { role: { member: { permissions: ['*'] } } }), '"*" only for owner');
  await assertFails(adoptionBatch(OWNER_A, { role: { owner: { templateVersion: 5 } } }), 'current template only');
});

test('L19/L20 new-home bootstrap and normal member authorization unchanged', async () => {
  await bootstrap(ALICE, 'hNew');
  await assertSucceeds(getDoc(doc(db(ALICE), 'homes', 'hNew')));
  await assertFails(getDoc(doc(db(MALLORY), 'homes', 'hNew')));
  await legacyHome();
  await assertSucceeds(adoptionBatch(OWNER_A));
  await assertFails(getDoc(doc(db(OWNER_HOME_B), 'homes', 'hL')), 'cross-home isolation intact');
});

// =================================================================== PHASE 5.1.3 REGRESSIONS
test('5.1.3 expired-invite fixture control: the SAME invite is acceptable before it expires', async () => {
  await family();
  const ok = await invite(OWNER_A); await assertSucceeds(ok.write());
  await assertSucceeds(acceptBatch(CHILD_A, ok.code, ok.data).commit(), 'valid → accepted (so "expired" above fails ONLY because of expiry)');
  const late = await invite(OWNER_A, { ttlMs: -1000 });
  await assertFails(late.write(), 'creating an already-expired invite is refused');
});

test('5.1.3 "mine" queries work for every private collection the app reads; others denied', async () => {
  await savingsHome();
  const q = (u, col, f, op, v) => getDocs(query(collection(db(u), 'homes', 'hA', col), where(f, op, v)));
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'homes', 'hA', 'savingsEvents', 'ev1'), { assetId: 'wifePriv', type: 'opening', qty: 100, unit: 'minor', currency: 'EGP', date: '2026-10-06', note: null, transferId: null, walletId: null, costMinor: null, costCurrency: null, audience: 'restricted', readers: [MEMBER_WIFE.uid], status: 'active', createdBy: MEMBER_WIFE.uid, createdAt: new Date(), schemaVersion: 1 });
    await setDoc(doc(f, 'homes', 'hA', 'zakatRecords', 'wife_p1'), { kind: 'profile', ownerUid: MEMBER_WIFE.uid, version: 1, settings: {}, readers: [MEMBER_WIFE.uid], createdBy: MEMBER_WIFE.uid, createdAt: new Date(), schemaVersion: 1 });
    await setDoc(doc(f, 'homes', 'hA', 'walletMovements', 'mv1'), { type: 'funding', amountMinor: 100, currency: 'EGP', date: '2026-10-06', fromWalletId: null, toWalletId: 'w', cycleId: null, note: null, audience: 'restricted', readers: [MEMBER_WIFE.uid], status: 'active', createdBy: MEMBER_WIFE.uid, createdAt: new Date(), schemaVersion: 1 });
  });
  for (const col of ['savingsAssets', 'savingsEvents', 'zakatRecords', 'walletMovements', 'expenses', 'wallets', 'spendingCycles', 'commitments']) {
    await assertSucceeds(q(MEMBER_WIFE, col, 'readers', 'array-contains', MEMBER_WIFE.uid), `wife: own ${col}`);
    await assertDenied(q(OWNER_A, col, 'readers', 'array-contains', MEMBER_WIFE.uid), `owner: wife's ${col}`);
  }
  await assertSucceeds(q(OWNER_A, 'savingsAssets', 'visibility', '==', 'household'), 'household savings query');
  await assertSucceeds(q(OWNER_A, 'savingsEvents', 'audience', '==', 'household'));
  await assertDenied(q(CHILD_A, 'savingsAssets', 'visibility', '==', 'household'), 'child has no savings.view');
  await assertDenied(getDocs(collection(db(OWNER_A), 'homes', 'hA', 'savingsAssets')), 'unconstrained list denied');
});

// =================================================================== PHASE 5.2 — ZAKAT SHARING, REVOCATION, PAYMENT LINKAGE
const zRef = (u, id) => doc(db(u), 'homes', 'hA', 'zakatRecords', id);
function zProfile(by, owner, v, readers) {
  return { kind: 'profile', ownerUid: owner.uid, version: v, settings: { nisabBasis: 'gold', goldMg: 85000, goldPurity: '21', silverMg: 595000, silverPurity: '999', manualNisabMinor: null, rateBps: 250, hawlCalendar: 'hijri', belowNisabPolicy: 'reset', methodologyNote: null },
    readers, createdBy: by.uid, createdAt: serverTimestamp(), schemaVersion: 1 };
}
function zSnapshot(by, owner, readers, extra = {}) {
  return { kind: 'snapshot', ownerUid: owner.uid, date: '2026-10-06', hawlStart: '2025-10-17', hawlEnd: '2026-10-06', zakatableMinor: 40000000, nisabMinor: 34000000, nisabBasis: 'gold', rateBps: 250,
    estimateMinor: 1000000, currency: 'EGP', lines: [], profileVersion: 1, readers, createdBy: by.uid, createdAt: serverTimestamp(), schemaVersion: 1, ...extra };
}
function zPayment(by, owner, readers, snapshotId, extra = {}) {
  return { kind: 'payment', ownerUid: owner.uid, date: '2026-10-07', amountMinor: 400000, currency: 'EGP', snapshotId, note: null, linkedExpenseId: null,
    readers, createdBy: by.uid, createdAt: serverTimestamp(), schemaVersion: 1, ...extra };
}

test('Z1/Z2 private by default; explicit share → reader; revoke → denied again (get AND query)', async () => {
  await savingsHome();
  const W = MEMBER_WIFE.uid;
  await assertSucceeds(setDoc(zRef(MEMBER_WIFE, 'wife_p1'), zProfile(MEMBER_WIFE, MEMBER_WIFE, 1, [W])));
  const ownerQ = () => getDocs(query(collection(db(OWNER_A), 'homes', 'hA', 'zakatRecords'), where('readers', 'array-contains', OWNER_A.uid)));
  await assertDenied(getDoc(zRef(OWNER_A, 'wife_p1')), 'owner, private by default');
  await assertSucceeds(updateDoc(zRef(MEMBER_WIFE, 'wife_p1'), { readers: [W, OWNER_A.uid].sort() }), 'wife shares');
  await assertSucceeds(getDoc(zRef(OWNER_A, 'wife_p1')));
  await assertSucceeds(ownerQ(), 'owner can now query records shared with him');
  await assertSucceeds(updateDoc(zRef(MEMBER_WIFE, 'wife_p1'), { readers: [W] }), 'wife revokes');
  await assertDenied(getDoc(zRef(OWNER_A, 'wife_p1')), 'revoked');
  await assertDenied(getDocs(query(collection(db(OWNER_A), 'homes', 'hA', 'zakatRecords'), where('readers', 'array-contains', W))), 'owner cannot query her records');
});

test('Z3/Z4 only the owner (or a child\'s guardian) may re-label; content stays immutable', async () => {
  await savingsHome();
  const W = MEMBER_WIFE.uid;
  await assertSucceeds(setDoc(zRef(MEMBER_WIFE, 'wife_p1'), zProfile(MEMBER_WIFE, MEMBER_WIFE, 1, [W, OWNER_A.uid].sort())));
  await assertDenied(updateDoc(zRef(OWNER_A, 'wife_p1'), { readers: [W, OWNER_A.uid, ADMIN_A.uid].sort() }), 'a reader (even the Home owner) cannot re-share');
  await assertDenied(updateDoc(zRef(ADMIN_A, 'wife_p1'), { readers: [W, ADMIN_A.uid].sort() }), 'admin cannot grant himself access');
  await assertDenied(updateDoc(zRef(MEMBER_WIFE, 'wife_p1'), { readers: [OWNER_A.uid] }), 'owner of the record must stay a reader');
  await assertDenied(updateDoc(zRef(MEMBER_WIFE, 'wife_p1'), { readers: [W], version: 9 }), 'no content change with a re-label');
  await assertDenied(updateDoc(zRef(MEMBER_WIFE, 'wife_p1'), { readers: [W, OWNER_HOME_B.uid].sort() }), 'non-member reader');
  await assertDenied(deleteDoc(zRef(MEMBER_WIFE, 'wife_p1')), 'no delete');
});

test('Z5 child records: guardian re-labels but can never be removed; Home owner (not guardian) denied', async () => {
  await savingsHome();
  const C = CHILD_A.uid; const W = MEMBER_WIFE.uid;
  await assertSucceeds(setDoc(zRef(MEMBER_WIFE, 'childA_p1'), zProfile(MEMBER_WIFE, CHILD_A, 1, [C, W].sort())));
  await assertSucceeds(updateDoc(zRef(MEMBER_WIFE, 'childA_p1'), { readers: [C, W, OWNER_A.uid].sort() }), 'guardian shares with the other parent');
  await assertDenied(updateDoc(zRef(MEMBER_WIFE, 'childA_p1'), { readers: [C, OWNER_A.uid].sort() }), 'guardian cannot be removed');
  await assertDenied(updateDoc(zRef(OWNER_A, 'childA_p1'), { readers: [C, W].sort() }), 'Home owner is not a guardian');
  await assertDenied(updateDoc(zRef(CHILD_A, 'childA_p1'), { readers: [C] }), 'child cannot remove guardians');
});

test('Z6/Z7 payments link only to the SAME owner\'s calculation (existing or same batch); history immutable', async () => {
  await savingsHome();
  const W = MEMBER_WIFE.uid;
  await assertDenied(setDoc(zRef(MEMBER_WIFE, 'pay0'), zPayment(MEMBER_WIFE, MEMBER_WIFE, [W], 'doesNotExist')), 'dangling snapshotId');
  const f = db(MEMBER_WIFE); const b = writeBatch(f);
  b.set(doc(f, 'homes', 'hA', 'zakatRecords', 'snap1'), zSnapshot(MEMBER_WIFE, MEMBER_WIFE, [W]));
  b.set(doc(f, 'homes', 'hA', 'zakatRecords', 'pay1'), zPayment(MEMBER_WIFE, MEMBER_WIFE, [W], 'snap1'));
  await assertSucceeds(b.commit(), 'calculation + linked payment in one batch');
  await assertSucceeds(setDoc(zRef(MEMBER_WIFE, 'pay2'), zPayment(MEMBER_WIFE, MEMBER_WIFE, [W], 'snap1')), 'second instalment links to the same calculation');
  await assertSucceeds(setDoc(zRef(MEMBER_WIFE, 'pay3'), zPayment(MEMBER_WIFE, MEMBER_WIFE, [W], null)), 'unlinked payments remain allowed');
  await assertSucceeds(setDoc(zRef(OWNER_A, 'osnap'), zSnapshot(OWNER_A, OWNER_A, [OWNER_A.uid])));
  await assertDenied(setDoc(zRef(MEMBER_WIFE, 'pay4'), zPayment(MEMBER_WIFE, MEMBER_WIFE, [W], 'osnap')), "another owner's calculation");
  await assertDenied(setDoc(zRef(MEMBER_WIFE, 'pay5'), zPayment(MEMBER_WIFE, MEMBER_WIFE, [W], 'pay1')), 'a payment is not a calculation');
  await assertDenied(updateDoc(zRef(MEMBER_WIFE, 'pay1'), { amountMinor: 1 }), 'amount immutable');
  await assertDenied(updateDoc(zRef(MEMBER_WIFE, 'snap1'), { estimateMinor: 1 }), 'estimate immutable');
});

test('Z8 Phase 5.1.3 regression: savings privacy unchanged — owner denied, explicit share works', async () => {
  await savingsHome();
  await assertDenied(getDoc(doc(db(OWNER_A), 'homes', 'hA', 'savingsAssets', 'wifePriv')), 'owner denied');
  await assertSucceeds(updateDoc(doc(db(MEMBER_WIFE), 'homes', 'hA', 'savingsAssets', 'wifePriv'), { visibility: 'shared', sharedWith: [OWNER_A.uid], readers: [MEMBER_WIFE.uid, OWNER_A.uid], updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(db(OWNER_A), 'homes', 'hA', 'savingsAssets', 'wifePriv')));
});

// =================================================================== PHASE 5.3 — EDIT ACTIVE BUDGET (amount only, audited)
const adjPath = (f, h, id) => doc(f, 'homes', h, 'budgetAdjustments', id);
const cycleDoc = (uid, extra = {}) => (asUid(uid, 'cycleDoc'), { walletId: 'cash', currency: 'EGP', startDate: '2026-10-05', endDate: '2026-10-14', days: 10, budgetMinor: 1000000, carryInMinor: 0,
  previousCycleId: null, status: 'active', closedAt: null, closedBy: null, closeOutcome: null, closingRemainingMinor: null, nextCycleId: null,
  audience: 'household', readers: [], ...audit(uid), ...extra });
async function budgetHome() {
  await financeHome();
  await seedMember('h1', { uid: 'viewerB', email: 'viewer@b.test' }, 'viewer');
  await seed(['homes', 'h1', 'spendingCycles', 'c1'], cycleDoc('alice'));
  await seed(['homes', 'h1', 'spendingCycles', 'cOld'], cycleDoc('alice', { status: 'closed', closeOutcome: 'keep', closingRemainingMinor: 0 }));
  await seed(['homes', 'h1', 'spendingCycles', 'cPriv'], cycleDoc('alice', { walletId: 'alicePriv', audience: 'restricted', readers: ['alice'] }));
  await seed(['homes', 'h1', 'expenses', 'spent'], expense('alice', { amountMinor: 250000, walletId: 'cash', budgetCycleId: 'c1' }));
}
// One atomic edit: cycle (amount + revision) + append-only adjustment. `o` overrides for negative cases.
function budgetEdit(u, cycleId, { from, to, rev, prevRev = rev - 1, walletId = 'cash', audience = 'household', readers = [], cycleExtra = {}, adjExtra = {}, onlyCycle = false, onlyAdj = false, adjId } = {}) {
  const f = db(u); const b = writeBatch(f);
  if (!onlyAdj) b.update(cPath(f, 'h1', cycleId), { budgetMinor: to, budgetRevision: rev, updatedBy: u.uid, updatedAt: serverTimestamp(), ...cycleExtra });
  if (!onlyCycle) b.set(adjPath(f, 'h1', adjId || `${cycleId}_r${rev}`), { cycleId, walletId, revision: rev, oldBudgetMinor: from, newBudgetMinor: to, deltaMinor: to - from,
    currency: 'EGP', reason: null, editorUid: u.uid, createdAt: serverTimestamp(), audience, readers, schemaVersion: 1, ...adjExtra });
  return b.commit();
}

test('B1 increase, decrease below spent, and zero — each an atomic, audited edit; history readable', async () => {
  await budgetHome();
  await seedMember('h1', ADMIN_H1, 'admin');   // V6 batch 3: household budgets → owner / admin only
  await assertSucceeds(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1 }), '10,000 → 12,000');
  await assertDenied(budgetEdit(BOB, 'c1', { from: 1200000, to: 200000, rev: 2 }), 'member: not a budget manager');
  await assertSucceeds(budgetEdit(ADMIN_H1, 'c1', { from: 1200000, to: 200000, rev: 2 }), 'admin; below the 2,500 spent');
  await assertSucceeds(budgetEdit(ALICE, 'c1', { from: 200000, to: 0, rev: 3 }), 'zero is non-negative');
  await assertSucceeds(getDocs(query(collection(db(BOB), 'homes', 'h1', 'budgetAdjustments'), where('audience', '==', 'household'))));
  const c = (await getDoc(cPath(db(ALICE), 'h1', 'c1'))).data();
  assert.deepEqual([c.budgetMinor, c.budgetRevision, c.startDate, c.endDate, c.days], [0, 3, '2026-10-05', '2026-10-14', 10]);
});

test('B2 both halves required; invalid values and no-op edits refused', async () => {
  await budgetHome();
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1, onlyCycle: true }), 'cycle without its audit record');
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1, onlyAdj: true }), 'audit record without the cycle change');
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: -100, rev: 1 }), 'negative');
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000.5, rev: 1 }), 'not an integer minor amount');
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1000000, rev: 1 }), 'unchanged');
});

test('B3 stale / concurrent edits refused (revision + stored-amount checks)', async () => {
  await budgetHome();
  await seedMember('h1', ADMIN_H1, 'admin');   // V6 batch 3: the concurrent second writer must be authorized
  await assertSucceeds(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1 }), 'first writer wins');
  await assertDenied(budgetEdit(ADMIN_H1, 'c1', { from: 1000000, to: 1500000, rev: 1 }), 'second writer on a stale revision');
  await assertDenied(budgetEdit(ADMIN_H1, 'c1', { from: 1000000, to: 1500000, rev: 2 }), 'old amount must equal the stored amount');
  await assertDenied(budgetEdit(ADMIN_H1, 'c1', { from: 1200000, to: 1500000, rev: 3 }), 'no revision skipping');
  await assertDenied(budgetEdit(BOB, 'c1', { from: 1200000, to: 1500000, rev: 2 }), 'member (fresh values) — not a budget manager');
  await assertSucceeds(budgetEdit(ADMIN_H1, 'c1', { from: 1200000, to: 1500000, rev: 2 }), 'retry with fresh values succeeds');
});

test('B4 identity, dates and duration immutable through a budget edit', async () => {
  await budgetHome();
  for (const extra of [{ endDate: '2026-10-20' }, { days: 12 }, { startDate: '2026-10-01' }, { currency: 'USD' }, { walletId: 'bank' }, { status: 'closed' }]) {
    await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1, cycleExtra: extra }), JSON.stringify(extra));
  }
});

test('B5 closed cycle denied; audit record immutable and unforgeable', async () => {
  await budgetHome();
  await assertDenied(budgetEdit(ALICE, 'cOld', { from: 1000000, to: 1200000, rev: 1 }), 'closed');
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1, adjExtra: { editorUid: 'bob' } }), 'forged editor');
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1, adjExtra: { deltaMinor: 1 } }), 'wrong delta');
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1, adjId: 'c1_r9' }), 'id must match the revision');
  await assertDenied(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1, adjExtra: { readers: ['alice'] } }), 'privacy labels copied from the cycle');
  await assertSucceeds(budgetEdit(ALICE, 'c1', { from: 1000000, to: 1200000, rev: 1 }));
  await assertDenied(updateDoc(adjPath(db(ALICE), 'h1', 'c1_r1'), { reason: 'rewritten' }), 'append-only');
  await assertDenied(deleteDoc(adjPath(db(ALICE), 'h1', 'c1_r1')), 'no delete');
});

test('B6 unauthorized and cross-home edits denied; private cycles stay private', async () => {
  await budgetHome();
  await assertDenied(budgetEdit({ uid: 'viewerB', email: 'viewer@b.test' }, 'c1', { from: 1000000, to: 1200000, rev: 1 }), 'viewer can view, not manage budgets');
  await bootstrap(MALLORY, 'h2');
  await assertDenied(budgetEdit(MALLORY, 'c1', { from: 1000000, to: 1200000, rev: 1 }), 'member of another home');
  await assertDenied(budgetEdit(BOB, 'cPriv', { from: 1000000, to: 1, rev: 1, walletId: 'alicePriv', audience: 'restricted', readers: ['alice'] }), "another adult's private wallet");
  await assertSucceeds(budgetEdit(ALICE, 'cPriv', { from: 1000000, to: 1, rev: 1, walletId: 'alicePriv', audience: 'restricted', readers: ['alice'] }), 'owner of the private wallet');
  await assertDenied(getDoc(adjPath(db(BOB), 'h1', 'cPriv_r1')), 'private history hidden from other adults');
  await assertSucceeds(getDoc(adjPath(db(ALICE), 'h1', 'cPriv_r1')));
});

// =================================================================== PHASE 5.3 — HOME ROUTINE & CLEANING
const ctPath = (f, id) => doc(f, 'homes', 'hA', 'cleaningTasks', id);
const coPath = (f, id) => doc(f, 'homes', 'hA', 'cleaningOccurrences', id);
const clPath = (f, id) => doc(f, 'homes', 'hA', 'cleaningLog', id);
const taskDoc = (uid, extra = {}) => (asUid(uid, 'taskDoc'), { title: 'Kitchen floor', instructions: null, roomId: 'kitchen', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [],
  recurrence: { kind: 'days', interval: 1 }, startDate: '2026-10-01', dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null,
  createdBy: uid, createdAt: serverTimestamp(), updatedBy: uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
async function cleaningHome() {
  await savingsHome();   // hA: owner, admin, viewer, member(other), wife, child (guardian: wife); hB separately owned
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore(); const R = (id, active) => ({ name: id, type: 'kitchen', icon: 'kitchen', floor: null, notes: null, order: 1, active, archivedAt: null, archivedBy: null, createdBy: 'ownerA', createdAt: new Date(), updatedBy: 'ownerA', updatedAt: new Date(), schemaVersion: 1 });
    await setDoc(doc(f, 'homes', 'hA', 'rooms', 'kitchen'), R('kitchen', true));
    await setDoc(doc(f, 'homes', 'hA', 'rooms', 'oldRoom'), R('oldRoom', false));
    const tk = (extra) => ({ ...taskDoc('ownerA', extra), createdAt: new Date(), updatedAt: new Date() });
    await setDoc(doc(f, 'homes', 'hA', 'cleaningTasks', 'shared'), tk());
    await setDoc(doc(f, 'homes', 'hA', 'cleaningTasks', 'forKid'), tk({ eligibleUids: [CHILD_A.uid] }));
    await setDoc(doc(f, 'homes', 'hA', 'cleaningTasks', 'assignedOther'), tk({ assignMode: 'assigned', assigneeUids: [MEMBER_OTHER.uid] }));
    await setDoc(doc(f, 'homes', 'hA', 'cleaningTasks', 'onceT'), tk({ recurrence: { kind: 'once' }, dueDate: '2026-10-09' }));
    await setDoc(doc(f, 'homes', 'hA', 'cleaningTasks', 'inOldRoom'), tk({ roomId: 'oldRoom' }));
  });
}
// One audited action: occurrence (create at rev 1, or update to rev n) + its log entry, in ONE batch.
function cleanAct(u, taskId, date, { action, status, rev, create = rev === 1, occExtra = {}, logExtra = {}, noLog = false, onlyLog = false, notes = null }) {
  const f = db(u); const b = writeBatch(f); const id = `${taskId}_${date.replace(/-/g, '')}`;
  const T = serverTimestamp();
  const fields = status === 'claimed' ? { claimedBy: u.uid, claimedAt: T, completedBy: null, completedAt: null }
    : status === 'done' ? { completedBy: u.uid, completedAt: T, notes } : { claimedBy: null, claimedAt: null, completedBy: null, completedAt: null };
  if (!onlyLog) {
    if (create) b.set(coPath(f, id), { taskId, dueDate: date, status, rev, claimedBy: null, claimedAt: null, completedBy: null, completedAt: null, notes: null, ...fields, createdAt: T, updatedBy: u.uid, updatedAt: T, schemaVersion: 1, ...occExtra });
    else b.update(coPath(f, id), { status, rev, ...fields, updatedBy: u.uid, updatedAt: T, ...occExtra });
  }
  if (!noLog) b.set(clPath(f, `${id}_r${rev}`), { occurrenceId: id, taskId, rev, action, actorUid: u.uid, at: T, notes: action === 'reopen' || action === 'complete' ? notes : null, schemaVersion: 1, ...logExtra });
  return b.commit();
}

test('C1 tasks: create/edit by members, archive by admin only; viewer/child/other-home denied; rooms checked', async () => {
  await cleaningHome();
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'n1'), taskDoc(MEMBER_WIFE.uid)), 'member creates');
  await assertDenied(setDoc(ctPath(db(VIEWER_A), 'n2'), taskDoc(VIEWER_A.uid)), 'viewer cannot create');
  await assertDenied(setDoc(ctPath(db(CHILD_A), 'n3'), taskDoc(CHILD_A.uid)), 'child cannot create');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'n4'), taskDoc(MEMBER_WIFE.uid, { roomId: 'oldRoom' })), 'archived room cannot be chosen');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'n5'), taskDoc(MEMBER_WIFE.uid, { assignMode: 'assigned', assigneeUids: [OWNER_HOME_B.uid] })), 'assignee from another home');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'n6'), taskDoc(MEMBER_WIFE.uid, { recurrence: { kind: 'weeks', interval: 1, weekdays: [9] } })), 'bad weekday');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'n7'), taskDoc(MEMBER_WIFE.uid, { createdBy: OWNER_A.uid })), 'forged creator');
  await assertSucceeds(updateDoc(ctPath(db(MEMBER_WIFE), 'inOldRoom'), { title: 'Renamed', updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'archived room kept when unchanged');
  await assertDenied(updateDoc(ctPath(db(MEMBER_WIFE), 'shared'), { active: false, archivedAt: serverTimestamp(), archivedBy: MEMBER_WIFE.uid, updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'member cannot archive');
  await assertSucceeds(updateDoc(ctPath(db(ADMIN_A), 'shared'), { active: false, archivedAt: serverTimestamp(), archivedBy: ADMIN_A.uid, updatedBy: ADMIN_A.uid, updatedAt: serverTimestamp() }), 'admin archives');
  await assertDenied(deleteDoc(ctPath(db(OWNER_A), 'onceT')), 'no hard delete');
  await assertDenied(getDoc(ctPath(db(OWNER_HOME_B), 'onceT')), 'cross-home read');
  await assertDenied(getDocs(collection(db(MALLORY), 'homes', 'hA', 'cleaningTasks')), 'non-member list');
  await assertSucceeds(getDocs(collection(db(CHILD_A), 'homes', 'hA', 'cleaningTasks')), 'child can view');
});

test('C2 claim: audited, one per date (first claimer wins), date must be a valid due date of the task', async () => {
  await cleaningHome();
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-12', { action: 'claim', status: 'claimed', rev: 1 }), 'wife claims');
  await assertDenied(cleanAct(MEMBER_OTHER, 'shared', '2026-10-12', { action: 'claim', status: 'claimed', rev: 1 }), 'second claimer loses (id exists)');
  await assertDenied(cleanAct(MEMBER_OTHER, 'shared', '2026-10-13', { action: 'claim', status: 'claimed', rev: 1, noLog: true }), 'no claim without its audit entry');
  await assertDenied(cleanAct(MEMBER_OTHER, 'shared', '2026-10-13', { action: 'claim', status: 'claimed', rev: 1, onlyLog: true }), 'no audit entry without the claim');
  await assertDenied(cleanAct(MEMBER_OTHER, 'shared', '2026-09-30', { action: 'claim', status: 'claimed', rev: 1 }), 'before the task starts');
  await assertDenied(cleanAct(MEMBER_OTHER, 'onceT', '2026-10-10', { action: 'claim', status: 'claimed', rev: 1 }), 'one-time task: only its due date');
  await assertSucceeds(cleanAct(MEMBER_OTHER, 'onceT', '2026-10-09', { action: 'claim', status: 'claimed', rev: 1 }));
  await assertDenied(cleanAct(MEMBER_WIFE, 'assignedOther', '2026-10-12', { action: 'claim', status: 'claimed', rev: 1 }), 'assigned to someone else');
  await assertDenied(cleanAct(VIEWER_A, 'shared', '2026-10-14', { action: 'claim', status: 'claimed', rev: 1 }), 'viewer has no complete permission');
  await assertDenied(cleanAct(MEMBER_OTHER, 'shared', '2026-10-15', { action: 'claim', status: 'claimed', rev: 1, logExtra: { actorUid: MEMBER_WIFE.uid } }), 'forged actor');
});

test('C3 complete / release / reopen: revision chain, reason required, audit immutable', async () => {
  await cleaningHome();
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-12', { action: 'claim', status: 'claimed', rev: 1 }));
  await assertDenied(cleanAct(VIEWER_A, 'shared', '2026-10-12', { action: 'complete', status: 'done', rev: 2 }), 'viewer cannot complete');
  await assertDenied(cleanAct(MEMBER_WIFE, 'shared', '2026-10-12', { action: 'complete', status: 'done', rev: 3 }), 'revision must step by one');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-12', { action: 'complete', status: 'done', rev: 2, notes: 'mopped' }), 'claimer completes');
  // V6.1: one-tap Reopen — no note required; the paired audit entry (actor, server time) is still required.
  await assertDenied(cleanAct(MEMBER_WIFE, 'shared', '2026-10-12', { action: 'reopen', status: 'open', rev: 3, notes: null, noLog: true }), 'reopen without its audit entry');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-12', { action: 'reopen', status: 'open', rev: 3, notes: null }), 'completer reopens with one tap (no note)');
  await assertSucceeds(cleanAct(MEMBER_OTHER, 'shared', '2026-10-12', { action: 'complete', status: 'done', rev: 4 }), 'eligible member completes directly');
  await assertDenied(updateDoc(clPath(db(MEMBER_WIFE), 'shared_20261012_r2'), { notes: 'changed' }), 'audit entries are immutable');
  await assertDenied(deleteDoc(coPath(db(OWNER_A), 'shared_20261012')), 'no hard delete');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-13', { action: 'claim', status: 'claimed', rev: 1 }));
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-13', { action: 'unclaim', status: 'open', rev: 2 }), 'claimer releases');
});

test('V630-1 cleaning: no claim step — an eligible member completes a legacy claimed occurrence; private / ineligible still refused', async () => {
  await cleaningHome();
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-14', { action: 'claim', status: 'claimed', rev: 1 }), 'legacy claim record');
  await assertDenied(cleanAct(VIEWER_A, 'shared', '2026-10-14', { action: 'complete', status: 'done', rev: 2 }), 'viewer still refused');
  await assertDenied(cleanAct(CHILD_A, 'shared', '2026-10-14', { action: 'complete', status: 'done', rev: 2 }), 'child not listed still refused');
  await assertDenied(cleanAct(OWNER_HOME_B, 'shared', '2026-10-14', { action: 'complete', status: 'done', rev: 2 }), 'other home refused');
  await assertSucceeds(cleanAct(MEMBER_OTHER, 'shared', '2026-10-14', { action: 'complete', status: 'done', rev: 2 }), 'eligible member completes directly (claim no longer blocks)');
  await assertDenied(cleanAct(MEMBER_WIFE, 'shared', '2026-10-14', { action: 'complete', status: 'done', rev: 3 }), 'never completed twice');
  await assertSucceeds(cleanAct(MEMBER_OTHER, 'assignedOther', '2026-10-14', { action: 'claim', status: 'claimed', rev: 1 }));
  await assertDenied(cleanAct(CHILD_A, 'assignedOther', '2026-10-14', { action: 'complete', status: 'done', rev: 2 }), 'assigned to someone else: not completable by an ineligible child');
});

test('V630-2 cleaning reset: restarting a schedule needs cleaning.edit; earlier dates cannot be recreated afterwards (no resurrection)', async () => {
  await cleaningHome();
  const restart = (u, id, day) => updateDoc(ctPath(db(u), id), { startDate: day, updatedBy: u.uid, updatedAt: serverTimestamp() });
  await assertDenied(restart(VIEWER_A, 'shared', '2026-10-20'), 'viewer cannot reset');
  await assertDenied(restart(CHILD_A, 'shared', '2026-10-20'), 'child cannot reset');
  await assertDenied(restart(OWNER_HOME_B, 'shared', '2026-10-20'), 'other home cannot reset');
  await assertSucceeds(restart(MEMBER_WIFE, 'shared', '2026-10-20'), 'editor restarts the schedule');
  await assertDenied(cleanAct(MEMBER_WIFE, 'shared', '2026-10-19', { action: 'complete', status: 'done', rev: 1 }), 'a stale tab cannot complete a date before the new start');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-20', { action: 'complete', status: 'done', rev: 1 }), 'the new schedule works');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-20', { action: 'reopen', status: 'open', rev: 2 }), 'undo is an audited inverse action');
  await assertDenied(deleteDoc(coPath(db(OWNER_A), 'shared_20261020')), 'reset never hard-deletes occurrences');
  await assertDenied(updateDoc(ctPath(db(MEMBER_WIFE), 'shared'), { active: false, archivedAt: serverTimestamp(), archivedBy: MEMBER_WIFE.uid, updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), '"remove custom tasks" archive still needs admin rights');
});

test('V6301-R cleaning reset generation: resetGen only +1 by an editor; occurrence writes must state the current generation (stale tabs refused)', async () => {
  await cleaningHome();
  const bump = (u, gen) => updateDoc(ctPath(db(u), 'shared'), { resetGen: gen, updatedBy: u.uid, updatedAt: serverTimestamp() });
  // before any reset: absent generation = 0 → older clients (no taskGen) keep working
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-14', { action: 'complete', status: 'done', rev: 1 }), 'generation 0, field absent');
  await assertDenied(cleanAct(MEMBER_WIFE, 'shared', '2026-10-15', { action: 'complete', status: 'done', rev: 1, occExtra: { taskGen: 1 } }), 'a future generation is refused');
  await assertDenied(bump(VIEWER_A, 1), 'viewer cannot reset');
  await assertDenied(bump(CHILD_A, 1), 'child cannot reset');
  await assertDenied(bump(OWNER_HOME_B, 1), 'other home cannot reset');
  await assertDenied(bump(MEMBER_WIFE, 2), 'never skips a generation');
  await assertDenied(bump(MEMBER_WIFE, -1), 'never goes back');
  await assertSucceeds(bump(MEMBER_WIFE, 1), 'editor: next generation');
  await assertDenied(bump(MEMBER_WIFE, 3), 'still only +1');
  // after the reset: anything decided under generation 0 is refused
  await assertDenied(cleanAct(MEMBER_OTHER, 'shared', '2026-10-15', { action: 'complete', status: 'done', rev: 1 }), 'stale create (no taskGen)');
  await assertDenied(cleanAct(MEMBER_OTHER, 'shared', '2026-10-15', { action: 'complete', status: 'done', rev: 1, occExtra: { taskGen: 0 } }), 'stale create (taskGen 0)');
  await assertDenied(cleanAct(MEMBER_WIFE, 'shared', '2026-10-14', { action: 'reopen', status: 'open', rev: 2 }), 'stale update (no taskGen)');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', '2026-10-14', { action: 'reopen', status: 'open', rev: 2, occExtra: { taskGen: 1 } }), 'audited undo under the new generation');
  await assertSucceeds(cleanAct(MEMBER_OTHER, 'shared', '2026-10-15', { action: 'complete', status: 'done', rev: 1, occExtra: { taskGen: 1 } }), 'current generation works');
  await assertDenied(cleanAct(MEMBER_OTHER, 'shared', '2026-10-15', { action: 'reopen', status: 'open', rev: 2, occExtra: { taskGen: 0 } }), 'cannot write an older generation back');
  // generation still never relaxes the existing checks
  await assertDenied(cleanAct(VIEWER_A, 'shared', '2026-10-16', { action: 'complete', status: 'done', rev: 1, occExtra: { taskGen: 1 } }), 'viewer still refused');
  await assertDenied(updateDoc(ctPath(db(MEMBER_WIFE), 'shared'), { resetGen: 2, title: 'x'.repeat(200), updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'content still validated');
});

test('C4 children: only tasks that list them; guardian may correct the child\'s completion', async () => {
  await cleaningHome();
  await assertDenied(cleanAct(CHILD_A, 'shared', '2026-10-12', { action: 'complete', status: 'done', rev: 1 }), '"everyone" means adults');
  await assertSucceeds(cleanAct(CHILD_A, 'forKid', '2026-10-12', { action: 'complete', status: 'done', rev: 1 }), 'listed child completes');
  await assertDenied(updateDoc(ctPath(db(CHILD_A), 'forKid'), { title: 'x', updatedBy: CHILD_A.uid, updatedAt: serverTimestamp() }), 'child cannot edit tasks');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'forKid', '2026-10-12', { action: 'reopen', status: 'open', rev: 2, notes: 'not finished' }), 'guardian reopens');
});

test('C5 cross-home and non-member: no reads, no actions', async () => {
  await cleaningHome();
  await assertDenied(cleanAct(OWNER_HOME_B, 'shared', '2026-10-12', { action: 'claim', status: 'claimed', rev: 1 }), 'owner of another home');
  await assertDenied(getDocs(collection(db(OWNER_HOME_B), 'homes', 'hA', 'cleaningOccurrences')), 'cross-home list');
  await assertDenied(getDocs(collection(db(MALLORY), 'homes', 'hA', 'cleaningLog')), 'non-member log');
});

// =================================================================== PHASE 5.3.1 — TEMPLATE-GENERATED CLEANING TASKS
const genDoc = (uid, kind, sid, key, extra = {}) => (asUid(uid, 'genDoc'), { title: 'Wipe the counter', instructions: null, roomId: kind === 'room' ? sid : null, priority: 'normal',
  assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: { kind: 'after', unit: 'day', interval: 1 }, startDate: '2026-10-13', dueDate: null, endDate: null,
  active: true, archivedAt: null, archivedBy: null, source: { kind, id: sid, typeKey: kind === 'room' ? 'kitchen' : 'dishwasher', templateKey: key, templateVersion: 1 },
  estimatedMinutes: 3, createdBy: uid, createdAt: serverTimestamp(), updatedBy: uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
async function genHome() {
  await cleaningHome();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore(); const D = (active, roomId) => ({ name: 'DW', category: 'kitchen_appliance', subtype: 'dishwasher', roomId, status: 'operational', icon: 'dishwasher', active, schemaVersion: 1 });
    await setDoc(doc(f, 'homes', 'hA', 'devices', 'dw'), D(true, 'kitchen'));
    await setDoc(doc(f, 'homes', 'hA', 'devices', 'oldDw'), D(false, null));
    await setDoc(doc(f, 'homes', 'hB', 'rooms', 'bKitchen'), { name: 'B', type: 'kitchen', active: true });
  });
}

test('G1 generated tasks: deterministic ids; declined tombstone allowed; second (or concurrent) setup refused', async () => {
  await genHome();
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_1'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_1')), 'room template task');
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'd_dw_w_filter'), genDoc(MEMBER_WIFE.uid, 'device', 'dw', 'w_filter')), 'device template task');
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_0'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_0', { active: false, archivedAt: serverTimestamp(), archivedBy: MEMBER_WIFE.uid })), 'declined → archived tombstone');
  await assertDenied(setDoc(ctPath(db(MEMBER_OTHER), 'r_kitchen_kitchen_1'), genDoc(MEMBER_OTHER.uid, 'room', 'kitchen', 'kitchen_1')), 'same id again (repeat / concurrent setup)');
  await assertDenied(setDoc(ctPath(db(MEMBER_OTHER), 'r_kitchen_kitchen_0'), genDoc(MEMBER_OTHER.uid, 'room', 'kitchen', 'kitchen_0')), 'declined tombstone cannot be re-created active');
});

test('G2 generated tasks: id must match source; room/device must be active and in this home; roomId rules', async () => {
  await genHome();
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'x_kitchen_kitchen_1'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_1')), 'wrong id pattern');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_2'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_1')), 'id key ≠ templateKey');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_oldRoom_bedroom_0'), genDoc(MEMBER_WIFE.uid, 'room', 'oldRoom', 'bedroom_0')), 'archived room');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_bKitchen_kitchen_1'), genDoc(MEMBER_WIFE.uid, 'room', 'bKitchen', 'kitchen_1')), "another home's room");
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'd_oldDw_w_filter'), genDoc(MEMBER_WIFE.uid, 'device', 'oldDw', 'w_filter')), 'archived device');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'd_ghost_w_filter'), genDoc(MEMBER_WIFE.uid, 'device', 'ghost', 'w_filter')), 'missing device');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'd_dw_w_spin'), genDoc(MEMBER_WIFE.uid, 'device', 'dw', 'w_spin', { roomId: 'kitchen' })), 'device tasks keep roomId null (follow the device)');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_3'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_3', { roomId: 'oldRoom' })), 'room task roomId = its room');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_4'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_4', { recurrence: { kind: 'days', interval: 1 } })), "generated tasks use 'after'");
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_5'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_5', { assignMode: 'assigned', assigneeUids: [MEMBER_WIFE.uid] })), 'fixed shared shape');
});

test('G3 permissions and immutability: viewer/child cannot generate; source is permanent; minutes validated', async () => {
  await genHome();
  await assertDenied(setDoc(ctPath(db(VIEWER_A), 'r_kitchen_kitchen_1'), genDoc(VIEWER_A.uid, 'room', 'kitchen', 'kitchen_1')), 'viewer');
  await assertDenied(setDoc(ctPath(db(CHILD_A), 'r_kitchen_kitchen_1'), genDoc(CHILD_A.uid, 'room', 'kitchen', 'kitchen_1')), 'child');
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_1'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_1')));
  await assertDenied(updateDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_1'), { source: { kind: 'room', id: 'kitchen', typeKey: 'kitchen', templateKey: 'kitchen_9', templateVersion: 1 }, updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'source immutable');
  await assertSucceeds(updateDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_1'), { title: 'Wipe counters well', estimatedMinutes: 5, recurrence: { kind: 'after', unit: 'day', interval: 2 }, updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'user may customise');
  await assertDenied(updateDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_1'), { estimatedMinutes: 0, updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'minutes 1..600');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_6'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_6', { estimatedMinutes: 9999 })), 'minutes bound on create');
});

test("G4 'after' recurrence shapes; manual tasks unaffected", async () => {
  await genHome();
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_7'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_7', { recurrence: { kind: 'after', unit: 'month', interval: 3 } })));
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_8'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_8', { recurrence: { kind: 'after', unit: 'month', interval: 13 } })), '> 12 months');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_9'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_9', { recurrence: { kind: 'after', unit: 'week', interval: 1 } })), 'unknown unit');
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'manual1'), taskDoc(MEMBER_WIFE.uid)), 'manual create unchanged');
  // B0 fix: Phase 5.4c deliberately allows estimatedMinutes on manual tasks (bounds tested in T3), so the
  // exact-keys intent is now tested with a genuinely unknown field.
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'manual2'), taskDoc(MEMBER_WIFE.uid, { unexpected: 1 })), 'manual exact keys: unknown field denied');
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'manual3'), taskDoc(MEMBER_WIFE.uid, { estimatedMinutes: 5 })), 'manual estimatedMinutes allowed (Phase 5.4c)');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'r_kitchen_kitchen_7', '2026-10-13', { action: 'complete', status: 'done', rev: 1 }), "completing an 'after' task (date ≥ start)");
  await assertDenied(cleanAct(MEMBER_WIFE, 'r_kitchen_kitchen_7', '2026-10-12', { action: 'complete', status: 'done', rev: 1 }), 'never before its start date');
});

test('G5 cross-home / non-member cannot generate or read generated tasks', async () => {
  await genHome();
  await assertDenied(setDoc(ctPath(db(OWNER_HOME_B), 'r_kitchen_kitchen_1'), genDoc(OWNER_HOME_B.uid, 'room', 'kitchen', 'kitchen_1')), 'owner of another home');
  await assertDenied(setDoc(ctPath(db(MALLORY), 'r_kitchen_kitchen_1'), genDoc(MALLORY.uid, 'room', 'kitchen', 'kitchen_1')), 'non-member');
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'r_kitchen_kitchen_1'), genDoc(MEMBER_WIFE.uid, 'room', 'kitchen', 'kitchen_1')));
  await assertDenied(getDoc(ctPath(db(OWNER_HOME_B), 'r_kitchen_kitchen_1')), 'cross-home read');
});

// =================================================================== PHASE 5.3.2 HOTFIX — REAL BUILDER, REALISTIC HOUSEHOLD
// v5.7.1 shipped one batched write for the whole setup (97 tasks here). Firestore applies its rule
// limits per request, so the batch was rejected as a whole. The app now writes ONE task per request;
// these tests use the REAL payload builder (not hand-written docs) on a realistic household.
import { buildSetupPlan as _plan, planWrites as _writes } from '../../src/modules/cleaning/cleaning-integration.js';
const H_ROOMS = [['k2', 'kitchen'], ['bA', 'bathroom'], ['bB', 'bathroom'], ['mb', 'master_bedroom'], ['bd', 'bedroom'], ['kd', 'kids_room'], ['lv', 'living_room'], ['hl', 'hallway'], ['bl', 'balcony'], ['gr', 'garage']];
const H_DEVICES = [['fr', 'kitchen_appliance', 'refrigerator'], ['dw2', 'kitchen_appliance', 'dishwasher'], ['mw', 'kitchen_appliance', 'microwave'], ['ov', 'kitchen_appliance', 'oven'], ['af', 'kitchen_appliance', 'air_fryer'], ['vc', 'cleaning_appliance', 'vacuum_cleaner'], ['ac1', 'climate', 'split_ac']];
async function realisticHome() {
  await cleaningHome();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore(); const now = new Date();
    for (const [i, [id, type]] of H_ROOMS.entries()) await setDoc(doc(f, 'homes', 'hA', 'rooms', id), { name: id, type, icon: type, floor: null, notes: null, order: 10 + i, active: true, archivedAt: null, archivedBy: null, createdBy: OWNER_A.uid, createdAt: now, updatedBy: OWNER_A.uid, updatedAt: now, schemaVersion: 1 });
    for (const [id, category, subtype] of H_DEVICES) await setDoc(doc(f, 'homes', 'hA', 'devices', id), { name: id, category, subtype, roomId: 'k2', status: 'operational', icon: subtype, brand: null, model: null, serialNumber: null, purchaseDate: null, installationDate: null, purchasePrice: null, currency: null, warrantyExpiry: null, notes: null, active: true, archivedAt: null, archivedBy: null, createdBy: OWNER_A.uid, createdAt: now, updatedBy: OWNER_A.uid, updatedAt: now, schemaVersion: 1 });
  });
}
// Payloads are built FOR the user who saves them (as the app does: planWrites({ uid: identity.uid })).
function realWrites(lang, author = OWNER_A) {
  const plan = _plan({ rooms: H_ROOMS.map(([id, type]) => ({ id, name: id, type, active: true })), devices: H_DEVICES.map(([id, , subtype]) => ({ id, name: id, subtype, roomId: 'k2', active: true })), tasks: [] });
  return _writes({ plan, accepted: new Set(plan.pending.flatMap((g) => g.add.map((a) => a.id))), lang, uid: author.uid, now: serverTimestamp(), today: '2026-10-15' });
}
async function saveOneByOne(u, writes) {
  const failed = [];
  for (const w of writes) { try { await setDoc(ctPath(db(u), w.id), w.data); } catch (e) { failed.push(`${w.id}: ${String(e.message).slice(0, 160)}`); } }
  return failed;
}

test('H1 realistic household, Arabic: the REAL builder\'s whole setup is accepted one task per write', async () => {
  await realisticHome();
  const w = realWrites('ar');
  // Phase 5.4b: 125 = the 97 periodic tasks + 16 AC (seasonal) + 12 usage-triggered device tasks — all must be accepted.
  assert.equal(w.length, 125);
  assert.deepEqual(await saveOneByOne(OWNER_A, w), [], 'every generated task accepted');
  assert.equal((await getDocs(collection(db(OWNER_A), 'homes', 'hA', 'cleaningTasks'))).docs.filter((d) => d.data().source).length, 125);
});

test('H2 realistic household, English: includes the 83-character stove title; all accepted; a re-run is refused per task', async () => {
  await realisticHome();
  // v5.7.2 test defect fixed: H2 used payloads authored for OWNER_A while saving as MEMBER_WIFE, so
  // the rules (correctly) refused every task: createdBy must equal the caller. Build them for the wife.
  const w = realWrites('en', MEMBER_WIFE);
  assert.ok(w.some((x) => x.data.title.length === 83));
  // Security regression (the accidental finding, now deliberate): saving tasks authored in SOMEONE
  // ELSE's name is refused, even by a member who may create cleaning tasks.
  const forged = realWrites('en', OWNER_A)[0];
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), forged.id), forged.data), 'createdBy must be the caller');
  assert.deepEqual(await saveOneByOne(MEMBER_WIFE, w), [], 'member with cleaning.create');
  // Re-run by ANOTHER authorised member with a payload built for THEM: the only possible refusal
  // is "the task already exists" (deterministic id, create-only) — not an authorship mismatch.
  const rerun = realWrites('en', MEMBER_OTHER)[0];
  assert.equal(rerun.id, w[0].id);
  await assertDenied(setDoc(ctPath(db(MEMBER_OTHER), rerun.id), rerun.data), 'repeat / concurrent setup of the same task');
  await assertSucceeds(getDoc(ctPath(db(MEMBER_OTHER), rerun.id)), 'it exists (created by the wife)');
});

test('H3 titles: generated ≤ 120 (create + later edits); manual stays ≤ 80', async () => {
  await realisticHome();
  const base = realWrites('en').find((x) => x.data.title.length === 83);
  await assertSucceeds(setDoc(ctPath(db(OWNER_A), base.id), base.data), '83-char library title');
  await assertSucceeds(updateDoc(ctPath(db(OWNER_A), base.id), { priority: 'high', updatedBy: OWNER_A.uid, updatedAt: serverTimestamp() }), 'editing a long-titled generated task');
  const other = realWrites('en').find((x) => x.id !== base.id);
  await assertDenied(setDoc(ctPath(db(OWNER_A), other.id), { ...other.data, title: 'x'.repeat(121) }), 'generated > 120');
  await assertDenied(setDoc(ctPath(db(OWNER_A), 'manualLong'), taskDoc(OWNER_A.uid, { title: 'x'.repeat(81) })), 'manual > 80');
});

// =================================================================== PHASE 5.4a — ADVANCED CLEANING (skip / postpone / time / routine / settings)
// Dates are REAL (server-time bounds): skippedOn / routine day within ±2 days; postponedTo ≤ +31 days.
const isoDay = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const crPath = (f, h, id) => doc(f, 'homes', h, 'cleaningRoutines', id);
const csPath = (f, h, id) => doc(f, 'homes', h, 'cleaningSettings', id);
/** One audited Advanced action: occurrence (create at rev 1 / update) + its log entry, in ONE batch. */
function advAct(u, taskId, date, { action, status, rev, fields = {}, logExtra = {}, noLog = false }) {
  const f = db(u); const b = writeBatch(f); const id = `${taskId}_${date.replace(/-/g, '')}`; const T = serverTimestamp();
  if (rev === 1) b.set(coPath(f, id), { taskId, dueDate: date, status, rev, claimedBy: null, claimedAt: null, completedBy: null, completedAt: null, notes: null, createdAt: T, updatedBy: u.uid, updatedAt: T, schemaVersion: 1, ...fields });
  else b.update(coPath(f, id), { status, rev, updatedBy: u.uid, updatedAt: T, ...fields });
  if (!noLog) b.set(clPath(f, `${id}_r${rev}`), { occurrenceId: id, taskId, rev, action, actorUid: u.uid, at: T, notes: null, schemaVersion: 1, ...logExtra });
  return b.commit();
}

test('A1 skip: recorded, never a completion; near-today only; no minutes; resume by the skipper; claim after a skip', async () => {
  await cleaningHome();
  const d = isoDay(); const W = MEMBER_WIFE;
  await assertDenied(advAct(W, 'shared', d, { action: 'skip', status: 'skipped', rev: 1, fields: { skippedOn: isoDay(-10) } }), 'skippedOn far from today');
  await assertDenied(advAct(W, 'shared', d, { action: 'skip', status: 'skipped', rev: 1, fields: { skippedOn: d, actualMinutes: 5 } }), 'no minutes on a skip');
  await assertDenied(advAct(W, 'shared', d, { action: 'skip', status: 'skipped', rev: 1, fields: { skippedOn: d, completedBy: W.uid } }), 'a skip is never a completion');
  await assertDenied(advAct(VIEWER_A, 'shared', d, { action: 'skip', status: 'skipped', rev: 1, fields: { skippedOn: d } }), 'viewer cannot act');
  await assertSucceeds(advAct(W, 'shared', d, { action: 'skip', status: 'skipped', rev: 1, fields: { skippedOn: d } }), 'skip');
  await assertDenied(advAct(W, 'shared', d, { action: 'skip', status: 'skipped', rev: 1, fields: { skippedOn: d } }), 'same date again → refused (exists)');
  await assertSucceeds(advAct(W, 'shared', d, { action: 'resume', status: 'open', rev: 2, fields: { skippedOn: null, postponedTo: null } }), 'resume by the skipper');
  await assertSucceeds(advAct(W, 'shared', isoDay(1), { action: 'skip', status: 'skipped', rev: 1, fields: { skippedOn: d } }));
  await assertSucceeds(advAct(MEMBER_OTHER, 'shared', isoDay(1), { action: 'claim', status: 'claimed', rev: 2, fields: { claimedBy: MEMBER_OTHER.uid, claimedAt: serverTimestamp() } }), 'claim after a skip');
});

test('A2 postpone + time tracking: ≤ 31 days, after the due date, recorded in the audit; Done from postponed with minutes', async () => {
  await cleaningHome();
  const d = isoDay(); const W = MEMBER_WIFE;
  await assertDenied(advAct(W, 'shared', d, { action: 'postpone', status: 'postponed', rev: 1, fields: { postponedTo: isoDay(40) }, logExtra: { postponedTo: isoDay(40) } }), '> 30 days');
  await assertDenied(advAct(W, 'shared', d, { action: 'postpone', status: 'postponed', rev: 1, fields: { postponedTo: d }, logExtra: { postponedTo: d } }), 'not after the due date');
  await assertDenied(advAct(W, 'shared', d, { action: 'postpone', status: 'postponed', rev: 1, fields: { postponedTo: isoDay(5) }, logExtra: { postponedTo: isoDay(6) } }), 'audit must record the same date');
  await assertDenied(advAct(W, 'shared', d, { action: 'postpone', status: 'postponed', rev: 1, fields: { postponedTo: isoDay(5) } }), 'audit must record the date');
  await assertSucceeds(advAct(W, 'shared', d, { action: 'postpone', status: 'postponed', rev: 1, fields: { postponedTo: isoDay(5) }, logExtra: { postponedTo: isoDay(5) } }), 'postpone 5 days');
  await assertDenied(advAct(W, 'shared', d, { action: 'complete', status: 'done', rev: 2, fields: { completedBy: W.uid, completedAt: serverTimestamp(), actualMinutes: 0 }, logExtra: { actualMinutes: 0 } }), 'minutes ≥ 1');
  await assertDenied(advAct(W, 'shared', d, { action: 'complete', status: 'done', rev: 2, fields: { completedBy: W.uid, completedAt: serverTimestamp(), actualMinutes: 601 }, logExtra: { actualMinutes: 601 } }), 'minutes ≤ 600');
  await assertSucceeds(advAct(W, 'shared', d, { action: 'complete', status: 'done', rev: 2, fields: { completedBy: W.uid, completedAt: serverTimestamp(), actualMinutes: 15 }, logExtra: { actualMinutes: 15 } }), 'Done from postponed, 15 min');
  await assertDenied(advAct(MEMBER_OTHER, 'shared', isoDay(1), { action: 'claim', status: 'claimed', rev: 1, fields: { claimedBy: MEMBER_OTHER.uid, claimedAt: serverTimestamp(), actualMinutes: 5 } }), 'minutes only on a completion');
  await assertDenied(advAct(W, 'shared', isoDay(2), { action: 'skip', status: 'skipped', rev: 1, fields: { skippedOn: d }, logExtra: { postponedTo: isoDay(4) } }), 'postponedTo only on a postpone entry');
});

test('A3 daily routine: saved once (create-only), near-today, ≤ 200 items; viewer / cross-home denied; never updated', async () => {
  await cleaningHome();
  const day = isoDay(); const R = (u, extra = {}) => ({ date: day, items: ['shared_' + day.replace(/-/g, '')], catchUpMax: 2, startHour: 3, createdBy: u.uid, createdAt: serverTimestamp(), schemaVersion: 1, ...extra });
  await assertDenied(setDoc(crPath(db(VIEWER_A), 'hA', day), R(VIEWER_A)), 'viewer cannot save the plan');
  await assertDenied(setDoc(crPath(db(MEMBER_WIFE), 'hA', isoDay(-10)), R(MEMBER_WIFE, { date: isoDay(-10) })), 'day far from today');
  await assertDenied(setDoc(crPath(db(MEMBER_WIFE), 'hA', day), R(MEMBER_WIFE, { items: Array.from({ length: 201 }, (_, i) => `x${i}`) })), '> 200 items');
  await assertDenied(setDoc(crPath(db(MEMBER_WIFE), 'hA', day), R(MEMBER_WIFE, { date: isoDay(1) })), 'date must equal the id');
  await assertSucceeds(setDoc(crPath(db(MEMBER_WIFE), 'hA', day), R(MEMBER_WIFE)), 'first member saves the plan');
  await assertDenied(setDoc(crPath(db(MEMBER_OTHER), 'hA', day), R(MEMBER_OTHER)), 'a concurrent second save is refused (create-only)');
  await assertDenied(updateDoc(crPath(db(MEMBER_WIFE), 'hA', day), { items: [] }), 'never updated');
  await assertDenied(deleteDoc(crPath(db(OWNER_A), 'hA', day)), 'never deleted');
  await assertSucceeds(getDoc(crPath(db(VIEWER_A), 'hA', day)), 'viewer reads the plan');
  await assertDenied(getDoc(crPath(db(OWNER_HOME_B), 'hA', day)), 'cross-home read');
  await assertDenied(setDoc(crPath(db(OWNER_HOME_B), 'hA', isoDay(1)), R(OWNER_HOME_B, { date: isoDay(1) })), 'cross-home write');
});

test('A4 cleaning settings: editors only; bounds; only "general"; no delete; cross-home denied', async () => {
  await cleaningHome();
  const S = (u, extra = {}) => ({ catchUpMax: 3, startHour: 2, updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
  await assertSucceeds(setDoc(csPath(db(MEMBER_WIFE), 'hA', 'general'), S(MEMBER_WIFE)), 'member (cleaning.edit) creates');
  await assertSucceeds(setDoc(csPath(db(ADMIN_A), 'hA', 'general'), S(ADMIN_A, { catchUpMax: 5 })), 'admin updates');
  await assertDenied(setDoc(csPath(db(VIEWER_A), 'hA', 'general'), S(VIEWER_A)), 'viewer');
  await assertDenied(setDoc(csPath(db(CHILD_A), 'hA', 'general'), S(CHILD_A)), 'child');
  await assertDenied(setDoc(csPath(db(MEMBER_WIFE), 'hA', 'general'), S(MEMBER_WIFE, { catchUpMax: 11 })), 'catchUpMax ≤ 10');
  await assertDenied(setDoc(csPath(db(MEMBER_WIFE), 'hA', 'general'), S(MEMBER_WIFE, { startHour: 7 })), 'startHour ≤ 6');
  await assertDenied(setDoc(csPath(db(MEMBER_WIFE), 'hA', 'other'), S(MEMBER_WIFE)), 'only the general document');
  await assertDenied(setDoc(csPath(db(MEMBER_WIFE), 'hA', 'general'), S(MEMBER_WIFE, { updatedBy: OWNER_A.uid })), 'forged editor');
  await assertDenied(deleteDoc(csPath(db(OWNER_A), 'hA', 'general')), 'no delete');
  await assertSucceeds(getDoc(csPath(db(CHILD_A), 'hA', 'general')), 'child can read');
  await assertDenied(getDoc(csPath(db(OWNER_HOME_B), 'hA', 'general')), 'cross-home read');
});

test('A5 backward compatibility: v5.7.2-shape occurrences and audit entries (no optional fields) are still accepted', async () => {
  await cleaningHome();
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', isoDay(), { action: 'claim', status: 'claimed', rev: 1 }), 'old claim shape');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', isoDay(), { action: 'complete', status: 'done', rev: 2, notes: 'ok' }), 'old complete shape (no minutes)');
  await assertSucceeds(cleanAct(MEMBER_WIFE, 'shared', isoDay(), { action: 'reopen', status: 'open', rev: 3, notes: 'redo' }), 'old reopen');
});

// =================================================================== PHASE 5.4b — DEVICE USAGE & SEASONAL CLEANING
const evPath = (f, id) => doc(f, 'homes', 'hA', 'cleaningDeviceEvents', id);
const dsPath = (f, id) => doc(f, 'homes', 'hA', 'cleaningDeviceState', id);
const seasonPath = (f, id) => doc(f, 'homes', 'hA', 'cleaningDeviceSeasons', id);
const useDoc = (u, extra = {}) => (asUser(u, 'useDoc'), { deviceId: 'dw', kind: 'use', voidsEventId: null, note: null, actorUid: u.uid, at: serverTimestamp(), schemaVersion: 1, ...extra });
function season(u, deviceId, state, rev, { create = rev === 1, entry = {}, skipEntry = false } = {}) {
  const f = db(u); const b = writeBatch(f); const T = serverTimestamp();
  if (create) b.set(dsPath(f, deviceId), { state, rev, updatedBy: u.uid, updatedAt: T, schemaVersion: 1 });
  else b.update(dsPath(f, deviceId), { state, rev, updatedBy: u.uid, updatedAt: T });
  if (!skipEntry) b.set(seasonPath(f, `${deviceId}_s${rev}`), { deviceId, rev, state, note: null, actorUid: u.uid, at: T, schemaVersion: 1, ...entry });
  return b.commit();
}
const trigTask = (u, extra = {}) => (asUser(u, 'trigTask'), { title: 'Wipe after use', instructions: null, roomId: null, priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [],
  recurrence: { kind: 'onUse' }, startDate: '2026-01-01', dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null,
  trigger: { kind: 'afterUse', deviceId: 'dw' }, createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });

test('D1 usage events: append-only, idempotent id, active device of THIS home, actor = caller; viewer / cross-home denied', async () => {
  await genHome();
  await assertSucceeds(setDoc(evPath(db(MEMBER_WIFE), 'EVTa0000000001'), useDoc(MEMBER_WIFE, { note: 'after dinner' })), 'member logs a use');
  await assertSucceeds(setDoc(evPath(db(CHILD_A), 'EVTa0000000002'), useDoc(CHILD_A)), 'child (cleaning.complete) logs a use');
  await assertDenied(setDoc(evPath(db(MEMBER_OTHER), 'EVTa0000000001'), useDoc(MEMBER_OTHER)), 'same id again (retry / concurrent) → refused');
  await assertDenied(setDoc(evPath(db(VIEWER_A), 'EVTa0000000003'), useDoc(VIEWER_A)), 'viewer');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'EVTa0000000004'), useDoc(MEMBER_WIFE, { deviceId: 'oldDw' })), 'archived device');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'EVTa0000000005'), useDoc(MEMBER_WIFE, { deviceId: 'ghost' })), 'device not in this home');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'EVTa0000000006'), useDoc(MEMBER_WIFE, { actorUid: OWNER_A.uid })), 'forged actor');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'EVTa0000000007'), useDoc(MEMBER_WIFE, { at: new Date(Date.now() - 86400000) })), 'client-chosen time');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'EVTa0000000008'), useDoc(MEMBER_WIFE, { note: 'x'.repeat(201) })), 'note ≤ 200');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'bad id!'), useDoc(MEMBER_WIFE)), 'id format');
  await assertDenied(updateDoc(evPath(db(MEMBER_WIFE), 'EVTa0000000001'), { note: 'edited' }), 'immutable');
  await assertDenied(deleteDoc(evPath(db(OWNER_A), 'EVTa0000000001')), 'never deleted');
  await assertDenied(getDoc(evPath(db(OWNER_HOME_B), 'EVTa0000000001')), 'cross-home read');
  await assertDenied(setDoc(evPath(db(OWNER_HOME_B), 'EVTa0000000009'), useDoc(OWNER_HOME_B)), 'cross-home write');
});

test('D2 corrections: a NEW void event (<id>_void), once, for a use of the same device; never a deletion', async () => {
  await genHome();
  await assertSucceeds(setDoc(evPath(db(MEMBER_WIFE), 'EVTb0000000001'), useDoc(MEMBER_WIFE)));
  const V = (u, extra = {}) => useDoc(u, { kind: 'void', voidsEventId: 'EVTb0000000001', ...extra });
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'EVTb0000000001_void'), V(MEMBER_WIFE, { deviceId: 'oldDw' })), 'wrong device');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'somethingElse_void'), V(MEMBER_WIFE)), 'id must be <eventId>_void');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'NOPE000000000_void'), V(MEMBER_WIFE, { voidsEventId: 'NOPE000000000' })), 'target must exist');
  await assertSucceeds(setDoc(evPath(db(MEMBER_WIFE), 'EVTb0000000001_void'), V(MEMBER_WIFE)), 'correction');
  await assertDenied(setDoc(evPath(db(MEMBER_OTHER), 'EVTb0000000001_void'), V(MEMBER_OTHER)), 'only once');
  await assertDenied(setDoc(evPath(db(MEMBER_WIFE), 'EVTb0000000001_void_void'), V(MEMBER_WIFE, { voidsEventId: 'EVTb0000000001_void' })), 'cannot void a void');
  await assertSucceeds(getDoc(evPath(db(VIEWER_A), 'EVTb0000000001')), 'the original use remains (history)');
});

test('D3 seasons: state rev n→n+1 only WITH its season entry; editors only; no no-op / stale toggles; append-only history', async () => {
  await genHome();
  await assertDenied(season(MEMBER_WIFE, 'dw', 'active', 1, { skipEntry: true }), 'state change without its entry');
  await assertDenied(season(VIEWER_A, 'dw', 'active', 1), 'viewer');
  await assertDenied(season(CHILD_A, 'dw', 'active', 1), 'child');
  await assertDenied(season(MEMBER_WIFE, 'oldDw', 'active', 1), 'archived device');
  await assertDenied(season(MEMBER_WIFE, 'dw', 'active', 1, { entry: { state: 'inactive' } }), 'entry must match');
  await assertSucceeds(season(MEMBER_WIFE, 'dw', 'active', 1), 'start season');
  await assertDenied(season(MEMBER_OTHER, 'dw', 'active', 2, { create: false }), 'no-op toggle');
  await assertDenied(season(MEMBER_OTHER, 'dw', 'inactive', 3, { create: false }), 'stale / skipped revision');
  await assertSucceeds(season(ADMIN_A, 'dw', 'inactive', 2, { create: false }), 'end season');
  await assertDenied(season(MEMBER_WIFE, 'dw', 'inactive', 2, { create: false }), 'concurrent duplicate of the same transition');
  await assertDenied(setDoc(seasonPath(db(MEMBER_WIFE), 'dw_s9'), { deviceId: 'dw', rev: 9, state: 'active', note: null, actorUid: MEMBER_WIFE.uid, at: serverTimestamp(), schemaVersion: 1 }), 'entry on its own');
  await assertDenied(deleteDoc(seasonPath(db(OWNER_A), 'dw_s1')), 'history never deleted');
  await assertDenied(deleteDoc(dsPath(db(OWNER_A), 'dw')), 'state never deleted');
  await assertDenied(getDoc(dsPath(db(OWNER_HOME_B), 'dw')), 'cross-home');
});

test('D4 device-triggered tasks: valid shapes only; device of THIS home; trigger immutable; real generated payloads accepted', async () => {
  await genHome();
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'useTask'), trigTask(MEMBER_WIFE)), 'manual after-use task');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'u2'), trigTask(MEMBER_WIFE, { trigger: { kind: 'afterUse', deviceId: 'oldDw' } })), 'archived device');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'u3'), trigTask(MEMBER_WIFE, { trigger: { kind: 'afterUse', deviceId: 'ghost' } })), 'device not in this home');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'u4'), (({ trigger, ...x }) => x)(trigTask(MEMBER_WIFE))), 'onUse needs a trigger');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'u5'), trigTask(MEMBER_WIFE, { recurrence: { kind: 'days', interval: 1 } })), 'afterUse ⇒ onUse');
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), 'u6'), trigTask(MEMBER_WIFE, { trigger: { kind: 'seasonal', deviceId: 'dw', phase: 'active' } })), 'seasonal active ⇒ periodic');
  await assertDenied(setDoc(ctPath(db(VIEWER_A), 'u7'), trigTask(VIEWER_A)), 'viewer');
  await assertDenied(updateDoc(ctPath(db(MEMBER_WIFE), 'useTask'), { trigger: { kind: 'afterUse', deviceId: 'oldDw' }, updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'trigger immutable');
  await assertSucceeds(updateDoc(ctPath(db(MEMBER_WIFE), 'useTask'), { title: 'Wipe well after use', updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'other edits allowed');
  const plan = _plan({ rooms: [], devices: [{ id: 'dw', name: 'DW', subtype: 'dishwasher', roomId: 'kitchen', active: true }], tasks: [] });
  const w = _writes({ plan, accepted: new Set(plan.pending.flatMap((g) => g.add.map((a) => a.id))), lang: 'en', uid: MEMBER_WIFE.uid, now: serverTimestamp(), today: '2026-01-01' });
  const afterCycle = w.filter((x) => x.data.trigger);
  assert.equal(afterCycle.length, 2);
  for (const x of afterCycle) await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), x.id), x.data), `generated ${x.id}`);
  const bad = w.find((x) => !x.data.trigger);
  await assertDenied(setDoc(ctPath(db(MEMBER_WIFE), bad.id), { ...bad.data, trigger: { kind: 'afterUse', deviceId: 'dw' }, recurrence: { kind: 'onUse' }, source: { ...bad.data.source, id: 'kitchen', kind: 'room' } }), 'trigger device ≠ source');
});

test('D5 occurrences: <task>_u<event> / <task>_s<rev> proven against the event / season entry; event tasks never date-keyed', async () => {
  await genHome();
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'useTask'), trigTask(MEMBER_WIFE)));
  await assertSucceeds(setDoc(evPath(db(MEMBER_WIFE), 'EVTc0000000001'), useDoc(MEMBER_WIFE)));
  const day = new Date().toISOString().slice(0, 10);
  const occAct = (u, id, extra) => { const f = db(u); const b = writeBatch(f); const T = serverTimestamp();
    b.set(coPath(f, id), { taskId: extra.taskId || 'useTask', dueDate: day, status: 'done', rev: 1, claimedBy: null, claimedAt: null, completedBy: u.uid, completedAt: T, notes: null, createdAt: T, updatedBy: u.uid, updatedAt: T, schemaVersion: 1, ...extra.fields });
    b.set(clPath(f, `${id}_r1`), { occurrenceId: id, taskId: extra.taskId || 'useTask', rev: 1, action: 'complete', actorUid: u.uid, at: T, notes: null, schemaVersion: 1 });
    return b.commit(); };
  await assertDenied(occAct(MEMBER_WIFE, 'useTask_uNOPE', { fields: { triggerEventId: 'NOPE' } }), 'event must exist');
  await assertDenied(occAct(MEMBER_WIFE, 'useTask_uOTHER', { fields: { triggerEventId: 'EVTc0000000001' } }), 'id must match the event');
  await assertDenied(occAct(MEMBER_WIFE, `useTask_${day.replace(/-/g, '')}`, { fields: {} }), 'event task: no date-keyed occurrence');
  await assertSucceeds(occAct(MEMBER_WIFE, 'useTask_uEVTc0000000001', { fields: { triggerEventId: 'EVTc0000000001' } }), 'Done resolves the use');
  await assertDenied(occAct(MEMBER_OTHER, 'useTask_uEVTc0000000001', { fields: { triggerEventId: 'EVTc0000000001' } }), 'resolved once');
  // Season checklist (start) proven against the season entry's state.
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'startTask'), trigTask(MEMBER_WIFE, { recurrence: { kind: 'onSeason' }, trigger: { kind: 'seasonal', deviceId: 'dw', phase: 'start' } })));
  await assertSucceeds(season(MEMBER_WIFE, 'dw', 'active', 1));
  await assertSucceeds(season(MEMBER_WIFE, 'dw', 'inactive', 2, { create: false }));
  await assertDenied(occAct(MEMBER_WIFE, 'startTask_s2', { taskId: 'startTask', fields: { triggerSeasonRev: 2 } }), 'start checklist ≠ an off-season transition');
  await assertSucceeds(occAct(MEMBER_WIFE, 'startTask_s1', { taskId: 'startTask', fields: { triggerSeasonRev: 1 } }), 'start checklist for transition 1');
});

// =================================================================== PHASE 5.4c — CUSTOM TEMPLATES & AI IMPORT
const tplPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'cleaningCustomTemplates', id);
const tplDoc = (u, extra = {}) => (asUser(u, 'tplDoc'), { pack: 'Kitchen', title: 'مسح السطح', titleEn: 'Wipe the counter', instructions: null, minutes: 5, priority: 'normal', target: 'room',
  recurrence: { kind: 'after', unit: 'day', interval: 1 }, trigger: null, active: true, archivedAt: null, archivedBy: null, rev: 1,
  createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
const tplTask = (u, extra = {}) => (asUser(u, 'tplTask'), { title: 'Wipe the counter', instructions: null, roomId: 'kitchen', priority: 'normal', assignMode: 'shared', assigneeUids: [], eligibleUids: [],
  recurrence: { kind: 'after', unit: 'day', interval: 1 }, startDate: '2026-01-01', dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null,
  templateRef: { templateId: 'tplKitchen1', rev: 1 }, estimatedMinutes: 5, createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });

test('T1 custom templates: editors only; exact shape; no once; device ⇔ trigger; rev n→n+1; archive / reactivate; no delete; cross-home denied', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertDenied(setDoc(tplPath(db(VIEWER_A), 'tplViewer1'), tplDoc(VIEWER_A)), 'viewer');
  await assertDenied(setDoc(tplPath(db(CHILD_A), 'tplChild01'), tplDoc(CHILD_A)), 'child');
  await assertDenied(setDoc(tplPath(db(W), 'tplOnce001'), tplDoc(W, { recurrence: { kind: 'once' } })), 'once');
  // B0 fix: Phase 5.4d deliberately allows PERIODIC device templates without a trigger (firestore.rules:844);
  // trigger-only recurrences still require a trigger.
  await assertSucceeds(setDoc(tplPath(db(W), 'tplDev0001'), tplDoc(W, { target: 'device' })), 'periodic device template without a trigger (Phase 5.4d)');
  await assertDenied(setDoc(tplPath(db(W), 'tplDev0002'), tplDoc(W, { target: 'device', recurrence: { kind: 'onUse' } })), 'onUse without a trigger');
  await assertDenied(setDoc(tplPath(db(W), 'tplDev0003'), tplDoc(W, { target: 'device', recurrence: { kind: 'onSeason' } })), 'onSeason without a trigger');
  await assertDenied(setDoc(tplPath(db(W), 'tplTrig001'), tplDoc(W, { trigger: { kind: 'afterUse' }, recurrence: { kind: 'onUse' } })), 'trigger on a room template');
  await assertDenied(setDoc(tplPath(db(W), 'tplLong001'), tplDoc(W, { title: 'x'.repeat(121) })), 'title ≤ 120');
  await assertDenied(setDoc(tplPath(db(W), 'bad id!!'), tplDoc(W)), 'id format');
  await assertDenied(setDoc(tplPath(db(W), 'tplForge01'), tplDoc(W, { createdBy: OWNER_A.uid })), 'forged author');
  await assertDenied(setDoc(tplPath(db(W), 'tplExtra01'), tplDoc(W, { homeId: 'hB' })), 'unknown key');
  await assertSucceeds(setDoc(tplPath(db(W), 'tplKitchen1'), tplDoc(W)), 'member (cleaning.edit) creates');
  await assertSucceeds(setDoc(tplPath(db(W), 'tplUse0001'), tplDoc(W, { target: 'device', trigger: { kind: 'afterUse' }, recurrence: { kind: 'onUse' } })), 'device after-use template');
  const U = (u, rev, extra = {}) => updateDoc(tplPath(db(u), 'tplKitchen1'), { rev, updatedBy: u.uid, updatedAt: serverTimestamp(), ...extra });
  await assertSucceeds(U(W, 2, { title: 'مسح السطح جيدًا' }), 'edit rev 2');
  await assertDenied(U(ADMIN_A, 2, { title: 'stale' }), 'stale revision');
  await assertDenied(U(W, 3, { createdBy: W.uid + 'x' }), 'immutable author');
  await assertSucceeds(U(ADMIN_A, 3, { active: false, archivedAt: serverTimestamp(), archivedBy: ADMIN_A.uid }), 'archive');
  await assertDenied(U(W, 4, { title: 'edit while archived' }), 'no content edits while archived');
  await assertSucceeds(U(W, 4, { active: true, archivedAt: null, archivedBy: null }), 'reactivate');
  await assertDenied(deleteDoc(tplPath(db(OWNER_A), 'tplKitchen1')), 'never deleted');
  await assertSucceeds(getDoc(tplPath(db(VIEWER_A), 'tplKitchen1')), 'viewer reads');
  await assertDenied(getDoc(tplPath(db(OWNER_HOME_B), 'tplKitchen1')), 'cross-home read');
  await assertDenied(setDoc(tplPath(db(OWNER_HOME_B), 'tplHomeB01'), tplDoc(OWNER_HOME_B)), 'cross-home write');
});

test('T2 template-derived tasks: id c_<template>_<target>; template active in THIS home; templateRef immutable; fixed shape', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertSucceeds(setDoc(tplPath(db(W), 'tplKitchen1'), tplDoc(W)));
  await assertSucceeds(setDoc(tplPath(db(W), 'tplUse0001'), tplDoc(W, { target: 'device', trigger: { kind: 'afterUse' }, recurrence: { kind: 'onUse' } })));
  await assertDenied(setDoc(ctPath(db(W), 'c_tplKitchen1_other'), tplTask(W)), 'id must match the target');
  await assertDenied(setDoc(ctPath(db(W), 'c_tplNOPE_kitchen'), tplTask(W, { templateRef: { templateId: 'tplNOPE', rev: 1 } })), 'template must exist in this home');
  await assertDenied(setDoc(ctPath(db(VIEWER_A), 'c_tplKitchen1_kitchen'), tplTask(VIEWER_A)), 'viewer');
  await assertDenied(setDoc(ctPath(db(W), 'c_tplKitchen1_kitchen'), tplTask(W, { assignMode: 'assigned', assigneeUids: [W.uid] })), 'fixed shared shape');
  await assertDenied(setDoc(ctPath(db(W), 'c_tplKitchen1_kitchen'), tplTask(W, { recurrence: { kind: 'once' } })), 'never once');
  await assertSucceeds(setDoc(ctPath(db(W), 'c_tplKitchen1_kitchen'), tplTask(W, { title: 'x'.repeat(100) })), 'room task (title ≤ 120)');
  await assertDenied(setDoc(ctPath(db(MEMBER_OTHER), 'c_tplKitchen1_kitchen'), tplTask(MEMBER_OTHER)), 'applied once (concurrent / repeated apply)');
  await assertDenied(updateDoc(ctPath(db(W), 'c_tplKitchen1_kitchen'), { templateRef: { templateId: 'tplUse0001', rev: 1 }, updatedBy: W.uid, updatedAt: serverTimestamp() }), 'templateRef immutable');
  await assertSucceeds(updateDoc(ctPath(db(W), 'c_tplKitchen1_kitchen'), { priority: 'high', updatedBy: W.uid, updatedAt: serverTimestamp() }), 'normal edits allowed');
  await assertSucceeds(setDoc(ctPath(db(W), 'c_tplUse0001_dw'), tplTask(W, { roomId: null, recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'dw' }, templateRef: { templateId: 'tplUse0001', rev: 1 } })), 'device after-use task');
  await assertDenied(setDoc(ctPath(db(W), 'c_tplUse0001_oldDw'), tplTask(W, { roomId: null, recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'oldDw' }, templateRef: { templateId: 'tplUse0001', rev: 1 } })), 'archived device');
  await updateDoc(tplPath(db(W), 'tplKitchen1'), { rev: 2, active: false, archivedAt: serverTimestamp(), archivedBy: W.uid, updatedBy: W.uid, updatedAt: serverTimestamp() });
  await assertDenied(setDoc(ctPath(db(W), 'c_tplKitchen1_home'), tplTask(W, { roomId: null })), 'archived template cannot be applied');
});

test('T3 AI-imported tasks (ai_<hash>): ordinary manual tasks with estimatedMinutes; manual limits unchanged', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  const ai = (extra = {}) => ({ ...taskDoc(W.uid), estimatedMinutes: 5, ...extra });
  await assertSucceeds(setDoc(ctPath(db(W), 'ai_0123456789abcdef'), ai()), 'AI-imported manual task');
  await assertDenied(setDoc(ctPath(db(MEMBER_OTHER), 'ai_0123456789abcdef'), { ...taskDoc(MEMBER_OTHER.uid), estimatedMinutes: 5 }), 'same id again (retry / concurrent import)');
  await assertDenied(setDoc(ctPath(db(W), 'ai_1111111111111111'), ai({ estimatedMinutes: 0 })), 'minutes ≥ 1');
  await assertDenied(setDoc(ctPath(db(W), 'ai_2222222222222222'), ai({ estimatedMinutes: 601 })), 'minutes ≤ 600');
  await assertDenied(setDoc(ctPath(db(W), 'ai_3333333333333333'), ai({ title: 'x'.repeat(81) })), 'manual title still ≤ 80');
  await assertSucceeds(setDoc(ctPath(db(W), 'plainManual'), taskDoc(W.uid)), 'manual tasks without new fields (backward compatible)');
});

// =================================================================== PHASE 5.4d — DEVICE ↔ CLEANING LINKS
import { DEVICE_CATEGORIES as _DEVICE_CATEGORIES } from '../../src/modules/devices/device-model.js';
const linked = (u, deviceId, extra = {}) => (asUser(u, 'linked'), { ...taskDoc(u.uid), deviceId, ...extra });

test('E1 plain device link: active device of THIS home only; not with a trigger; change / clear validated; later-archived link still editable', async () => {
  await genHome();
  const W = MEMBER_WIFE; const upd = (u, id, data) => updateDoc(ctPath(db(u), id), { ...data, updatedBy: u.uid, updatedAt: serverTimestamp() });
  await assertSucceeds(setDoc(ctPath(db(W), 'linkTask'), linked(W, 'dw')), 'linked to an active device');
  await assertDenied(setDoc(ctPath(db(W), 'link2'), linked(W, 'oldDw')), 'archived device');
  await assertDenied(setDoc(ctPath(db(W), 'link3'), linked(W, 'ghostDevice')), "device not in this home (forged / another home's id)");
  await assertDenied(setDoc(ctPath(db(W), 'link4'), linked(W, 'dw', { recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'dw' } })), 'not together with a trigger');
  await assertDenied(setDoc(ctPath(db(VIEWER_A), 'link5'), linked(VIEWER_A, 'dw')), 'viewer');
  await assertDenied(setDoc(ctPath(db(OWNER_HOME_B), 'link6'), linked(OWNER_HOME_B, 'dw')), 'cross-home');
  await assertDenied(upd(W, 'linkTask', { deviceId: 'oldDw' }), 'change to an archived device');
  await assertDenied(upd(W, 'linkTask', { deviceId: 'ghostDevice' }), 'change to a forged device');
  await assertSucceeds(upd(W, 'linkTask', { deviceId: null }), 'clear the link');
  await assertSucceeds(upd(W, 'linkTask', { deviceId: 'dw' }), 'link again');
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), 'homes', 'hA', 'devices', 'dw'), { active: false }));
  await assertSucceeds(upd(W, 'linkTask', { title: 'Still editable' }), 'device archived later: the unchanged link does not block edits');
  await assertSucceeds(setDoc(ctPath(db(W), 'plainTask'), taskDoc(W.uid)), 'tasks without a device unchanged');
});

test('E2 templates: periodic device template; applied as c_<template>_<device> with deviceId', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertSucceeds(setDoc(tplPath(db(W), 'tplDevPer1'), tplDoc(W, { target: 'device' })), 'device template without a trigger (5.4d)');
  const T = (extra) => tplTask(W, { roomId: null, deviceId: 'dw', templateRef: { templateId: 'tplDevPer1', rev: 1 }, ...extra });
  await assertDenied(setDoc(ctPath(db(W), 'c_tplDevPer1_kitchen'), T()), 'id must name the device');
  await assertDenied(setDoc(ctPath(db(W), 'c_tplDevPer1_oldDw'), T({ deviceId: 'oldDw' })), 'archived device');
  await assertSucceeds(setDoc(ctPath(db(W), 'c_tplDevPer1_dw'), T()), 'applied to the device');
  await assertDenied(setDoc(ctPath(db(MEMBER_OTHER), 'c_tplDevPer1_dw'), tplTask(MEMBER_OTHER, { roomId: null, deviceId: 'dw', templateRef: { templateId: 'tplDevPer1', rev: 1 } })), 'applied once');
});

test('E3 every Add Device category / subtype (incl. null): a cleaning task can be linked (real rules)', async () => {
  await genHome();
  const combos = Object.entries(_DEVICE_CATEGORIES).flatMap(([cat, v]) => [...v.subtypes, null].map((sub) => [cat, sub]));
  assert.equal(combos.length, 104);
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore(); const now = new Date();
    for (const [i, [category, subtype]] of combos.entries()) await setDoc(doc(f, 'homes', 'hA', 'devices', `cat${i}`), { name: `${category}/${subtype}`, category, subtype, roomId: null, status: 'operational', icon: 'other', brand: null, model: null, serialNumber: null, purchaseDate: null, installationDate: null, purchasePrice: null, currency: null, warrantyExpiry: null, notes: null, active: true, archivedAt: null, archivedBy: null, createdBy: OWNER_A.uid, createdAt: now, updatedBy: OWNER_A.uid, updatedAt: now, schemaVersion: 1 });
  });
  const failed = [];
  for (const [i, [category, subtype]] of combos.entries()) {
    try { await setDoc(ctPath(db(MEMBER_WIFE), `catTask${i}`), linked(MEMBER_WIFE, `cat${i}`)); } catch (e) { failed.push(`${category}/${subtype}: ${String(e.message).slice(0, 80)}`); }
  }
  assert.deepEqual(failed, [], 'every category / subtype accepted');
});

// =================================================================== PHASE 5.5 — DEVICE MAINTENANCE
const mp = (f, id, h = 'hA') => doc(f, 'homes', h, 'maintenancePlans', id);
const mr = (f, id, h = 'hA') => doc(f, 'homes', h, 'maintenanceRecords', id);
const mf = (f, id, h = 'hA') => doc(f, 'homes', h, 'maintenanceFaults', id);
const me = (f, id, h = 'hA') => doc(f, 'homes', h, 'maintenanceFaultEvents', id);
const today5 = () => new Date().toISOString().slice(0, 10);
const planDoc = (u, extra = {}) => (asUser(u, 'planDoc'), { title: 'AC service', instructions: null, notes: null, deviceId: 'dw', recurrence: { kind: 'every', unit: 'month', interval: 12 },
  firstDueDate: '2026-11-01', assigneeUid: null, estimatedMinutes: 60, priority: 'normal', active: true, archivedAt: null, archivedBy: null,
  completedCount: 0, lastDoneDate: null, rev: 1, createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
const recDoc = (u, extra = {}) => (asUser(u, 'recDoc'), { kind: 'preventive', deviceId: 'dw', planId: 'planAC01', faultId: null, correctsRecordId: null, serviceDate: today5(),
  workPerformed: 'Serviced', provider: null, parts: null, notes: null, costMinor: 50000, currency: 'EGP', actorUid: u.uid, at: serverTimestamp(), schemaVersion: 1, ...extra });
function completeBatch(u, n, { rec = {}, plan = {}, skipRec = false, skipPlan = false, planId = 'planAC01' } = {}) {
  const f = db(u); const b = writeBatch(f);
  if (!skipRec) b.set(mr(f, `${planId}_c${n}`), recDoc(u, { planId, ...rec }));
  if (!skipPlan) b.update(mp(f, planId), { completedCount: n, lastDoneDate: rec.serviceDate || today5(), rev: n + 1, updatedBy: u.uid, updatedAt: serverTimestamp(), ...plan });
  return b.commit();
}
const faultDoc = (u, extra = {}) => (asUser(u, 'faultDoc'), { summary: 'Leaking', description: null, diagnosis: null, resolution: null, deviceId: 'dw', severity: 'high', assigneeUid: null,
  estimateMinor: null, estimateCurrency: null, status: 'open', rev: 1, reportedBy: u.uid, reportedAt: serverTimestamp(), resolvedAt: null, resolvedBy: null,
  closedAt: null, closedBy: null, updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
const evDoc = (u, faultId, rev, from, to, extra = {}) => (asUser(u, 'evDoc'), { faultId, rev, fromStatus: from, toStatus: to, note: null, actorUid: u.uid, at: serverTimestamp(), schemaVersion: 1, ...extra });
function reportBatch(u, id = 'faultX01', { fault = {}, ev = {}, skipEv = false } = {}) {
  const f = db(u); const b = writeBatch(f);
  b.set(mf(f, id), faultDoc(u, fault)); if (!skipEv) b.set(me(f, `${id}_r1`), evDoc(u, id, 1, null, 'open', ev));
  return b.commit();
}
function moveBatch(u, id, rev, from, to, { fields = {}, ev = {}, record = null, skipEv = false } = {}) {
  const f = db(u); const b = writeBatch(f); const T = serverTimestamp();
  const extra = to === 'resolved' ? { resolvedAt: T, resolvedBy: u.uid } : to === 'closed' ? { closedAt: T, closedBy: u.uid } : (from === 'resolved' && to === 'inProgress') ? { resolvedAt: null, resolvedBy: null } : {};
  b.update(mf(f, id), { status: to, rev, updatedBy: u.uid, updatedAt: T, ...extra, ...fields });
  if (!skipEv) b.set(me(f, `${id}_r${rev}`), evDoc(u, id, rev, from, to, ev));
  if (record) b.set(mr(f, `${id}_r${rev}`), { ...recDoc(u, { kind: 'repair', planId: null, faultId: id }), ...record });
  return b.commit();
}

test('M1 maintenance plans: members create for an ACTIVE device of THIS home; exact shape; rev; immutable device; archive (delete perm); no delete', async () => {
  await genHome();
  const W = MEMBER_WIFE; const up = (u, data) => updateDoc(mp(db(u), 'planAC01'), { ...data, updatedBy: u.uid, updatedAt: serverTimestamp() });
  await assertDenied(setDoc(mp(db(VIEWER_A), 'planV0001'), planDoc(VIEWER_A)), 'viewer');
  await assertDenied(setDoc(mp(db(CHILD_A), 'planC0001'), planDoc(CHILD_A)), 'child (no maintenance permission)');
  await assertDenied(setDoc(mp(db(W), 'planX0001'), planDoc(W, { deviceId: 'oldDw' })), 'archived device');
  await assertDenied(setDoc(mp(db(W), 'planX0002'), planDoc(W, { deviceId: 'ghostDev' })), 'missing / other-home device');
  await assertDenied(setDoc(mp(db(W), 'planX0003'), planDoc(W, { assigneeUid: OWNER_HOME_B.uid })), 'assignee not a member of this home');
  await assertDenied(setDoc(mp(db(W), 'planX0004'), planDoc(W, { createdBy: OWNER_A.uid })), 'forged author');
  await assertDenied(setDoc(mp(db(W), 'planX0005'), planDoc(W, { createdAt: new Date() })), 'client-chosen time');
  await assertDenied(setDoc(mp(db(W), 'planX0006'), planDoc(W, { recurrence: { kind: 'once', interval: 3 } })), 'once with an interval');
  await assertDenied(setDoc(mp(db(W), 'planX0007'), planDoc(W, { recurrence: { kind: 'every', unit: 'month', interval: 25 } })), 'interval bound');
  await assertDenied(setDoc(mp(db(W), 'planX0008'), planDoc(W, { completedCount: 3 })), 'counters start at zero');
  await assertDenied(setDoc(mp(db(W), 'planX0009'), planDoc(W, { homeId: 'hB' })), 'unexpected field');
  await assertDenied(setDoc(mp(db(W), 'planX0010'), planDoc(W, { title: 'x'.repeat(121) })), 'title ≤ 120');
  await assertSucceeds(setDoc(mp(db(W), 'planAC01'), planDoc(W, { assigneeUid: W.uid })), 'member creates');
  await assertSucceeds(up(W, { title: 'AC yearly service', rev: 2 }), 'edit rev 2');
  await assertDenied(up(ADMIN_A, { title: 'stale', rev: 2 }), 'stale revision');
  await assertDenied(up(W, { deviceId: 'oldDw', rev: 3 }), 'device link immutable');
  await assertDenied(up(W, { active: false, archivedAt: serverTimestamp(), archivedBy: W.uid, rev: 3 }), 'archive needs maintenance.delete (member)');
  await assertSucceeds(up(ADMIN_A, { active: false, archivedAt: serverTimestamp(), archivedBy: ADMIN_A.uid, rev: 3 }), 'admin archives');
  await assertDenied(up(W, { title: 'edit while archived', rev: 4 }), 'no edits while archived');
  await assertSucceeds(up(ADMIN_A, { active: true, archivedAt: null, archivedBy: null, rev: 4 }), 'reactivate');
  await assertDenied(deleteDoc(mp(db(OWNER_A), 'planAC01')), 'never deleted');
});

test('M2 completions: record + plan count together ONCE; duplicates / concurrency / one-time / mismatches refused; history immutable', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertSucceeds(setDoc(mp(db(W), 'planAC01'), planDoc(W)));
  await assertDenied(completeBatch(W, 1, { skipPlan: true }), 'record without the plan count');
  await assertDenied(completeBatch(W, 1, { skipRec: true }), 'plan count without its record');
  await assertDenied(completeBatch(W, 1, { rec: { deviceId: 'oldDw' } }), 'record device must match the plan');
  await assertDenied(completeBatch(W, 1, { plan: { lastDoneDate: '2020-01-01' } }), 'lastDoneDate must equal the record date');
  await assertDenied(completeBatch(VIEWER_A, 1), 'viewer');
  await assertSucceeds(completeBatch(W, 1), 'completion 1');
  await assertDenied(completeBatch(MEMBER_OTHER, 1), 'duplicate / concurrent completion of the same occurrence');
  await assertSucceeds(completeBatch(MEMBER_OTHER, 2), 'next completion');
  await assertDenied(updateDoc(mr(db(W), 'planAC01_c1'), { notes: 'edited' }), 'records are immutable');
  await assertDenied(deleteDoc(mr(db(OWNER_A), 'planAC01_c1')), 'records never deleted');
  await assertSucceeds(setDoc(mp(db(W), 'planOnce1'), planDoc(W, { recurrence: { kind: 'once' } })));
  await assertSucceeds(completeBatch(W, 1, { planId: 'planOnce1' }), 'one-time plan done');
  await assertDenied(completeBatch(W, 2, { planId: 'planOnce1' }), 'one-time plan cannot be completed twice');
});

test('M3 costs and text: integer minor units with a 3-letter currency; no negative / fractional / orphan values; bounded text; no future service date', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertSucceeds(setDoc(mp(db(W), 'planAC01'), planDoc(W)));
  for (const [rec, why] of [[{ costMinor: -1 }, 'negative'], [{ costMinor: 10.5 }, 'fractional'], [{ costMinor: 100, currency: null }, 'cost without currency'],
    [{ costMinor: null, currency: 'EGP' }, 'currency without cost'], [{ currency: 'egp' }, 'malformed currency'], [{ costMinor: 100000001 }, 'too large'],
    [{ workPerformed: 'x'.repeat(1001) }, 'work text bound'], [{ provider: 'x'.repeat(101) }, 'provider bound'], [{ serviceDate: '2099-01-01' }, 'future date'], [{ serviceDate: 'today' }, 'malformed date']]) {
    await assertDenied(completeBatch(W, 1, { rec }), why);
  }
  await assertSucceeds(completeBatch(W, 1, { rec: { costMinor: 0, currency: 'USD' } }), 'zero cost in another currency is fine');
});

test('M4 faults: report with event r1; only legal transitions with the right permission; audited; repair record only on resolve; closed final', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertDenied(reportBatch(W, 'faultX01', { skipEv: true }), 'report without its event');
  await assertDenied(reportBatch(VIEWER_A, 'faultV01'), 'viewer');
  await assertDenied(reportBatch(W, 'faultX02', { fault: { deviceId: 'oldDw' } }), 'archived device');
  await assertDenied(reportBatch(W, 'faultX03', { fault: { status: 'resolved' } }), 'must start open');
  await assertDenied(reportBatch(W, 'faultX04', { fault: { estimateMinor: 500, estimateCurrency: null } }), 'estimate needs a currency');
  await assertSucceeds(reportBatch(W, 'faultX01'), 'report');
  await assertDenied(moveBatch(W, 'faultX01', 2, 'open', 'resolved'), 'open → resolved is not a legal transition');
  await assertDenied(moveBatch(W, 'faultX01', 2, 'open', 'inProgress', { skipEv: true }), 'transition without its event');
  await assertDenied(moveBatch(W, 'faultX01', 2, 'open', 'inProgress', { ev: { fromStatus: 'resolved' } }), 'event must record the real from-status');
  await assertDenied(moveBatch(W, 'faultX01', 3, 'open', 'inProgress'), 'rev must be +1');
  await assertSucceeds(moveBatch(W, 'faultX01', 2, 'open', 'inProgress'), 'start work');
  await assertDenied(moveBatch(MEMBER_OTHER, 'faultX01', 2, 'open', 'inProgress'), 'concurrent duplicate transition (stale rev)');
  await assertDenied(moveBatch(W, 'faultX01', 3, 'inProgress', 'resolved', { record: { deviceId: 'oldDw' } }), 'repair record device must match');
  await assertSucceeds(moveBatch(W, 'faultX01', 3, 'inProgress', 'resolved', { fields: { resolution: 'Drain cleared' }, record: {} }), 'resolve with a repair record');
  await assertDenied(setDoc(mr(db(W), 'faultX01_r9'), recDoc(W, { kind: 'repair', planId: null, faultId: 'faultX01' })), 'repair record outside a resolve');
  await assertSucceeds(moveBatch(W, 'faultX01', 4, 'resolved', 'closed'), 'close');
  await assertDenied(moveBatch(W, 'faultX01', 5, 'closed', 'open'), 'closed is final');
  await assertDenied(updateDoc(me(db(W), 'faultX01_r2'), { note: 'rewritten' }), 'events immutable');
  await assertDenied(deleteDoc(mf(db(OWNER_A), 'faultX01')), 'faults never deleted');
  await assertDenied(setDoc(me(db(W), 'faultX01_r9'), evDoc(W, 'faultX01', 9, 'closed', 'open')), 'event on its own');
});

test('M5 isolation and corrections: cross-home denied; corrections copy the original identity, never a correction of a correction; protected data unchanged', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertSucceeds(setDoc(mp(db(W), 'planAC01'), planDoc(W)));
  await assertSucceeds(completeBatch(W, 1));
  await assertDenied(getDoc(mp(db(OWNER_HOME_B), 'planAC01')), 'cross-home read (plan)');
  await assertDenied(getDoc(mr(db(OWNER_HOME_B), 'planAC01_c1')), 'cross-home read (history)');
  await assertDenied(setDoc(mp(db(OWNER_HOME_B), 'planB0001'), planDoc(OWNER_HOME_B)), 'cross-home write');
  await assertDenied(getDoc(mp(db(MALLORY), 'planAC01')), 'non-member');
  await assertSucceeds(getDoc(mr(db(VIEWER_A), 'planAC01_c1')), 'viewer reads history');
  await assertDenied(getDoc(mr(db(CHILD_A), 'planAC01_c1')), 'child has no maintenance.view');
  const fix = (u, id, extra = {}) => setDoc(mr(db(u), id), recDoc(u, { correctsRecordId: 'planAC01_c1', costMinor: 45000, ...extra }));
  await assertDenied(fix(W, 'planAC01_c1_fix1', { deviceId: 'oldDw' }), 'correction must keep the device');
  await assertDenied(fix(W, 'planAC01_c1_fix1', { kind: 'repair' }), 'correction must keep the kind');
  await assertDenied(fix(W, 'someOtherId'), 'correction id format');
  await assertDenied(fix(VIEWER_A, 'planAC01_c1_fix1'), 'viewer');
  await assertSucceeds(fix(W, 'planAC01_c1_fix1'), 'correction (original kept)');
  await assertDenied(fix(W, 'planAC01_c1_fix1'), 'same correction twice');
  await assertDenied(setDoc(mr(db(W), 'planAC01_c1_fix1_fix1'), recDoc(W, { correctsRecordId: 'planAC01_c1_fix1' })), 'no correction of a correction');
  // Protected areas are unaffected: a maintenance member still cannot touch devices or finance it could not before.
  await assertDenied(updateDoc(doc(db(W), 'homes', 'hA', 'devices', 'dw'), { status: 'needs_attention' }), 'maintenance never edits devices (member lacks devices.edit)');
});

// =================================================================== PHASE 5.6 — REMINDERS (owner-only presentation state)
const rsPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'reminderStates', id);
const rpPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'reminderPrefs', id);
const hex16 = (s) => { let h = 0xcbf29ce484222325n; for (const b of new TextEncoder().encode(s)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & ((1n << 64n) - 1n); } return h.toString(16).padStart(16, '0'); };
const sid = (u, key) => (asUser(u, 'sid'), `${u.uid}_${hex16(key)}`);
const isoIn = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const stDoc = (u, key, extra = {}) => (asUser(u, 'stDoc'), { ownerUid: u.uid, key, state: 'read', snoozeUntil: null, sourceKind: key[0] === 'c' ? 'cleaning' : key[0] === 'p' ? 'maintenancePlan' : 'maintenanceFault', updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
const prefDoc = (extra = {}) => ({ lookAheadDays: 3, cleaning: true, maintenancePlans: true, maintenanceFaults: true, quietStart: null, quietEnd: null, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });

test('RM1 reminder states: owner-only; id bound to the caller; exact shape; snooze bounds; no takeover; cross-home denied', async () => {
  await genHome();
  const W = MEMBER_WIFE; const O = MEMBER_OTHER; const k = 'p:planAC01@2026-11-01';
  await assertSucceeds(setDoc(rsPath(db(W), sid(W, k)), stDoc(W, k)), 'own state');
  await assertSucceeds(setDoc(rsPath(db(W), sid(W, k)), stDoc(W, k, { state: 'snoozed', snoozeUntil: isoIn(3) })), 'update own (snooze)');
  await assertDenied(setDoc(rsPath(db(W), sid(O, k)), stDoc(W, k)), "id with another member's uid");
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:x@2026-10-20')), stDoc(W, 'c:x@2026-10-20', { ownerUid: O.uid })), 'forged owner');
  await assertDenied(setDoc(rsPath(db(W), `${W.uid}_nothex`), stDoc(W, k)), 'id format');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'x:bad')), stDoc(W, 'x:bad', { sourceKind: 'cleaning' })), 'key format');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:a@2026-10-20')), stDoc(W, 'c:a@2026-10-20', { sourceKind: 'maintenanceFault' })), 'sourceKind must match the key');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:b')), stDoc(W, 'c:b', { state: 'archived' })), 'unknown state');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:c')), stDoc(W, 'c:c', { state: 'snoozed', snoozeUntil: null })), 'snooze needs a date');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:d')), stDoc(W, 'c:d', { state: 'snoozed', snoozeUntil: isoIn(-5) })), 'snooze in the past');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:e')), stDoc(W, 'c:e', { state: 'snoozed', snoozeUntil: isoIn(400) })), 'snooze > 1 year');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:f')), stDoc(W, 'c:f', { snoozeUntil: isoIn(2) })), 'a date only when snoozed');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:g')), stDoc(W, 'c:g', { updatedAt: new Date() })), 'client-chosen time');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:h')), stDoc(W, 'c:h', { title: 'leak' })), 'no copied source fields');
  await assertDenied(setDoc(rsPath(db(O), sid(W, k)), stDoc(O, k)), "taking over another member's state");
  await assertDenied(getDoc(rsPath(db(O), sid(W, k))), "another member cannot read it (same home)");
  await assertDenied(getDocs(query(collection(db(O), 'homes', 'hA', 'reminderStates'), where('ownerUid', '==', W.uid))), "another member cannot list it");
  await assertSucceeds(getDocs(query(collection(db(W), 'homes', 'hA', 'reminderStates'), where('ownerUid', '==', W.uid))), 'owner lists own');
  await assertDenied(getDocs(collection(db(W), 'homes', 'hA', 'reminderStates')), 'unfiltered list denied');
  await assertDenied(deleteDoc(rsPath(db(O), sid(W, k))), "deleting another member's state");
  await assertDenied(getDoc(rsPath(db(OWNER_HOME_B), sid(W, k))), 'cross-home');
  await assertDenied(setDoc(rsPath(db(MALLORY), sid(MALLORY, k)), stDoc(MALLORY, k)), 'non-member');
  await assertSucceeds(deleteDoc(rsPath(db(W), sid(W, k))), 'restore = delete own state');
});

test('RM2 reminder prefs: owner-only; exact shape; bounds', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertSucceeds(setDoc(rpPath(db(W), W.uid), prefDoc({ lookAheadDays: 7, quietStart: 22, quietEnd: 6 })), 'own prefs');
  await assertSucceeds(getDoc(rpPath(db(W), W.uid)), 'owner reads');
  await assertDenied(getDoc(rpPath(db(MEMBER_OTHER), W.uid)), 'another member cannot read');
  await assertDenied(setDoc(rpPath(db(MEMBER_OTHER), W.uid), prefDoc()), "another member cannot write");
  for (const [x, why] of [[{ lookAheadDays: 5 }, 'look-ahead set'], [{ cleaning: 'yes' }, 'boolean'], [{ quietStart: 24 }, 'hour bound'], [{ quietEnd: -1 }, 'hour bound'], [{ updatedAt: new Date() }, 'server time'], [{ extra: 1 }, 'exact keys']]) {
    await assertDenied(setDoc(rpPath(db(W), W.uid), prefDoc(x)), why);
  }
  await assertDenied(getDoc(rpPath(db(OWNER_HOME_B), W.uid)), 'cross-home');
  await assertSucceeds(deleteDoc(rpPath(db(W), W.uid)), 'owner deletes');
});

test('RM3 no escalation: reminders paths grant nothing on Cleaning / Maintenance data', async () => {
  await genHome();
  await assertSucceeds(setDoc(mp(db(MEMBER_WIFE), 'planAC01'), planDoc(MEMBER_WIFE)));
  await assertSucceeds(setDoc(ctPath(db(MEMBER_WIFE), 'remTask1'), taskDoc(MEMBER_WIFE.uid)));
  // Even with their own reminder state / prefs, users without the source permission still cannot read the sources.
  await assertSucceeds(setDoc(rpPath(db(CHILD_A), CHILD_A.uid), prefDoc()), 'a child may keep own prefs (cleaning.view)');
  await assertDenied(getDoc(mp(db(CHILD_A), 'planAC01')), 'child: still no maintenance access');
  await assertDenied(getDoc(mp(db(OWNER_HOME_B), 'planAC01')), 'other home: no maintenance access');
  await assertDenied(getDoc(ctPath(db(MALLORY), 'remTask1')), 'non-member: no cleaning access');
});

// =================================================================== V6 FINANCE — batch 1
const OPEN = '2026-01-01';   // fixed past opening date (robust to the run date)
const v6Day = (n = 0) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const pPath = (f, h, id) => doc(f, 'homes', h, 'budgetPeriods', id);
const hdPath = (f, h) => doc(f, 'homes', h, 'budgetHead', 'primary');
const lPath = (f, h, id) => doc(f, 'homes', h, 'refundLedgers', id);
const v6mv = (uid, extra) => (asUid(uid, 'v6mv'), { amountMinor: 100000, currency: 'EGP', date: v6Day(0), fromWalletId: null, toWalletId: 'vBank', cycleId: null, note: null,
  audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, ...audit(uid), ...extra });
// V6 batch 3: household budgets are managed by owners / admins only (template v7 + role check in the rules).
const V6_VIEWER = { uid: 'v6viewer', email: 'v6viewer@example.com' };
const V6_CHILD = { uid: 'v6child', email: 'v6child@example.com' };
// V6.2.2: a correction = rc_{wallet}_{n} movement + the wallet's correctionSeq n-1 → n, in ONE batch.
function recon(u, f, h, w, seq, { delta = -2000, before = 100000, mv = {}, wallet = {}, bump = true, date } = {}) {
  const b = writeBatch(f);
  b.set(doc(f, 'homes', h, 'walletMovements', `rc_${w}_${seq}`), { amountMinor: Math.abs(delta), currency: 'EGP', date: date || v6Day(0), fromWalletId: delta < 0 ? w : null, toWalletId: delta > 0 ? w : null,
    cycleId: null, note: null, audience: 'household', readers: [], status: 'active', voidedAt: null, voidedBy: null, ...audit(u.uid),
    type: 'reconciliation', reason: 'Counted', beforeMinor: before, afterMinor: before + delta, correctionSeq: seq, ...mv });
  if (bump) b.update(doc(f, 'homes', h, 'wallets', w), { correctionSeq: seq, updatedBy: u.uid, updatedAt: T(), ...wallet });
  return b.commit();
}
async function v6Home() {
  await financeHome();
  await seedMember('h1', V6_VIEWER, 'viewer');
  await seedMember('h1', V6_CHILD, 'child');
  await seedMember('h1', ADMIN_H1, 'admin');
  await seed(['homes', 'h1', 'wallets', 'vBank'], householdWallet('alice', { name: 'Bank', type: 'bank', role: 'bank', openingDate: OPEN }));
  await seed(['homes', 'h1', 'wallets', 'vCash'], householdWallet('alice', { name: 'Cash', type: 'cash', role: 'cash', openingDate: OPEN }));
}
function periodBatch(u, f, { id, start, end, cap = 2000000, headRev }) {
  const b = writeBatch(f);
  b.set(pPath(f, 'h1', id), { startDate: start, endDateExclusive: end, capMinor: cap, audience: 'household', readers: [], status: 'open', closingSnapshot: null, rev: 1, ...audit(u.uid) });
  b.set(hdPath(f, 'h1'), { lastPeriodId: id, endDateExclusive: end, audience: 'household', readers: [], rev: headRev, updatedBy: u.uid, updatedAt: T() });
  return b.commit();
}
function refundBatch(u, eId, seq, amount, { ledger, mv = {} } = {}) {
  const f = db(u); const b = writeBatch(f);
  b.set(lPath(f, 'h1', eId), { refundSeq: seq, refundedMinor: ledger, rev: seq, updatedBy: u.uid, updatedAt: T(), schemaVersion: 1 });
  b.set(mPath(f, 'h1', `${eId}_rf${seq}`), v6mv(u.uid, { type: 'refund', amountMinor: amount, refundOf: eId, refundSeq: seq, periodId: null, voidReason: null, ...mv }));
  return b.commit();
}

test('V6-1 accounts: role / openingDate set at creation only; direction-signed opening op_{wallet} once; never income', async () => {
  await v6Home();
  await assertSucceeds(setDoc(wPath(db(ALICE), 'h1', 'vSave'), householdWallet('alice', { name: 'Other', role: 'other', openingDate: OPEN })), 'create a V6 account');
  await assertDenied(setDoc(wPath(db(ALICE), 'h1', 'vBad'), householdWallet('alice', { role: 'credit' })), 'unknown role');
  await assertDenied(updateDoc(wPath(db(ALICE), 'h1', 'vBank'), { role: 'cash', updatedBy: 'alice', updatedAt: T() }), 'role immutable');
  await assertDenied(updateDoc(wPath(db(ALICE), 'h1', 'vBank'), { openingDate: '2026-02-01', updatedBy: 'alice', updatedAt: T() }), 'openingDate immutable');
  await assertSucceeds(setDoc(mPath(db(ALICE), 'h1', 'op_vBank'), v6mv('alice', { type: 'opening', date: OPEN, amountMinor: 6000000 })), 'positive opening');
  await assertSucceeds(setDoc(mPath(db(ALICE), 'h1', 'op_vCash'), v6mv('alice', { type: 'opening', date: OPEN, amountMinor: 120000, toWalletId: null, fromWalletId: 'vCash' })), 'negative opening = outflow');
  await assertDenied(setDoc(mPath(db(ALICE), 'h1', 'op_vBank'), v6mv('alice', { type: 'opening', date: OPEN, amountMinor: 1 })), 'second opening (replay) denied');
  await assertDenied(setDoc(mPath(db(ALICE), 'h1', 'op_vSave'), v6mv('alice', { type: 'opening', date: '2026-02-01', toWalletId: 'vSave' })), 'opening must be dated openingDate');
  await assertDenied(setDoc(mPath(db(ALICE), 'h1', 'xx_vSave'), v6mv('alice', { type: 'opening', date: OPEN, toWalletId: 'vSave' })), 'id must be op_{wallet}');
  await assertDenied(setDoc(mPath(db(BOB), 'h1', 'op_vSave'), v6mv('bob', { type: 'opening', date: OPEN, toWalletId: 'vSave' })), 'member lacks manageWallets');
  await assertDenied(updateDoc(mPath(db(ALICE), 'h1', 'op_vBank'), { status: 'void', voidedAt: T(), voidedBy: 'alice', updatedBy: 'alice', updatedAt: T() }), 'opening never voided');
});

test('V6-2 income (received only) and reconciliation (reason, balance only); exact keys', async () => {
  await v6Home();
  await assertSucceeds(setDoc(mPath(db(BOB), 'h1', 'inc1'), v6mv('bob', { type: 'income', source: 'Salary' })), 'income received today');
  await assertDenied(setDoc(mPath(db(BOB), 'h1', 'inc2'), v6mv('bob', { type: 'income', source: null, date: v6Day(5) })), 'future income');
  await assertDenied(setDoc(mPath(db(BOB), 'h1', 'inc3'), v6mv('bob', { type: 'income', source: null, date: '2025-12-31' })), 'before the opening');
  await assertDenied(setDoc(mPath(db(BOB), 'h1', 'inc4'), v6mv('bob', { type: 'income', source: null, fromWalletId: 'vCash' })), 'income has no source account');
  await assertDenied(setDoc(mPath(db(BOB), 'h1', 'inc5'), v6mv('bob', { type: 'income', source: null, reason: 'x' })), 'unexpected key');
  await assertDenied(setDoc(mPath(db(BOB), 'h1', 'inc6'), v6mv('bob', { type: 'income', source: null, cycleId: 'c1' })), 'never cycle-linked');
  // V6.2.2: corrections need wallet management (member BOB no longer); shape via the rc_ batch
  await assertDenied(recon(BOB, db(BOB), 'h1', 'vCash', 1), 'member cannot correct a household balance');
  await assertSucceeds(recon(ALICE, db(ALICE), 'h1', 'vCash', 1), 'reconciliation');
  await assertDenied(recon(ALICE, db(ALICE), 'h1', 'vCash', 2, { mv: { reason: ' ' } }), 'reason required');
  await assertDenied(setDoc(mPath(db(MALLORY), 'h1', 'inc7'), v6mv('mallory', { type: 'income', source: null })), 'non-member');
});

test('V6-3 expenses on V6 accounts: Visa debit only from the bank; nothing before the opening; pre-V6 wallets unchanged', async () => {
  await v6Home();
  await assertSucceeds(setDoc(ePath(db(BOB), 'h1', 'v1'), expense('bob', { walletId: 'vBank', paymentMethod: 'debit_card', date: '2026-03-01' })), 'Visa from Bank');
  await assertDenied(setDoc(ePath(db(BOB), 'h1', 'v2'), expense('bob', { walletId: 'vCash', paymentMethod: 'debit_card', date: '2026-03-01' })), 'Visa from Cash');
  await assertDenied(setDoc(ePath(db(BOB), 'h1', 'v3'), expense('bob', { walletId: 'vBank', paymentMethod: 'cash', date: '2025-12-31' })), 'before the opening');
  await assertSucceeds(setDoc(ePath(db(BOB), 'h1', 'v4'), expense('bob', { walletId: 'cash', paymentMethod: 'debit_card', date: '2025-01-01' })), 'pre-V6 wallet: unchanged behaviour');
  await assertDenied(setDoc(ePath(db(BOB), 'h1', 'v5'), expense('bob', { walletId: 'vBank', date: '2026-03-01', periodId: 'p_missing' })), 'periodId must exist');
  await assertDenied(setDoc(ePath(db(BOB), 'h1', 'v6'), expense('bob', { walletId: 'vBank', date: '2026-03-01', lateEntry: 'yes' })), 'lateEntry boolean');
});

test('V6-4 periods: serialized head; first-period race; no overlap; immutable dates; close only after the end; no delete', async () => {
  await v6Home();
  await assertDenied(periodBatch(V6_VIEWER, db(V6_VIEWER), { id: 'p_20260101', start: '2026-01-01', end: '2026-02-01', headRev: 1 }), 'viewer lacks manageBudgets');
  await assertDenied(setDoc(pPath(db(ALICE), 'h1', 'p_20260101'), { startDate: '2026-01-01', endDateExclusive: '2026-02-01', capMinor: 1, audience: 'household', readers: [], status: 'open', closingSnapshot: null, rev: 1, ...audit('alice') }), 'period without the head');
  await assertSucceeds(periodBatch(ALICE, db(ALICE), { id: 'p_20260101', start: '2026-01-01', end: '2026-02-01', headRev: 1 }), 'first period');
  await assertDenied(periodBatch(ALICE, db(ALICE), { id: 'p_20260115', start: '2026-01-15', end: '2026-03-01', headRev: 1 }), 'second "first period" (concurrent race): head is now an update needing rev 2');
  await assertDenied(periodBatch(ALICE, db(ALICE), { id: 'p_20260115', start: '2026-01-15', end: '2026-03-01', headRev: 2 }), 'overlap with the head end');
  await assertDenied(periodBatch(ALICE, db(ALICE), { id: 'p_x', start: '2026-02-01', end: '2026-03-01', headRev: 2 }), 'id must be p_<startDate>');
  await assertSucceeds(periodBatch(ALICE, db(ALICE), { id: 'p_20260201', start: '2026-02-01', end: '2099-01-01', headRev: 2 }), 'next period (contiguous)');
  await assertDenied(updateDoc(pPath(db(ALICE), 'h1', 'p_20260201'), { endDateExclusive: '2026-03-01', rev: 2, updatedBy: 'alice', updatedAt: T() }), 'dates immutable');
  await assertDenied(updateDoc(pPath(db(ALICE), 'h1', 'p_20260201'), { capMinor: 5, rev: 2, updatedBy: 'alice', updatedAt: T() }), 'cap immutable in batch 1');
  const close = (id, snap) => updateDoc(pPath(db(ALICE), 'h1', id), { status: 'closed', closingSnapshot: snap, rev: 2, updatedBy: 'alice', updatedAt: T() });
  await assertDenied(close('p_20260201', { capMinor: 2000000, spentMinor: 0, remainingMinor: 2000000 }), 'close before the end');
  await assertDenied(close('p_20260101', { capMinor: 1, spentMinor: 0, remainingMinor: 1 }), 'snapshot cap must match');
  await assertSucceeds(close('p_20260101', { capMinor: 2000000, spentMinor: 0, remainingMinor: 2000000 }), 'close after the end');
  await assertDenied(deleteDoc(pPath(db(ALICE), 'h1', 'p_20260101')), 'no delete');
  await assertSucceeds(getDoc(pPath(db(BOB), 'h1', 'p_20260101')), 'member reads the household budget');
  await assertDenied(getDoc(pPath(db(MALLORY), 'h1', 'p_20260101')), 'cross-home / non-member');
});

test('V6-5 refunds: paired ledger; Σ ≤ original; same account; latest-only void with reason; original frozen', async () => {
  await v6Home();
  await assertSucceeds(setDoc(ePath(db(BOB), 'h1', 'e1'), expense('bob', { walletId: 'vBank', paymentMethod: 'debit_card', date: '2026-03-01', amountMinor: 300000 })));
  await assertDenied(setDoc(mPath(db(BOB), 'h1', 'e1_rf1'), v6mv('bob', { type: 'refund', refundOf: 'e1', refundSeq: 1, periodId: null, voidReason: null })), 'refund without its ledger');
  await assertDenied(refundBatch(BOB, 'e1', 1, 400000, { ledger: 400000 }), 'over-refund');
  await assertDenied(refundBatch(BOB, 'e1', 1, 100000, { ledger: 100000, mv: { toWalletId: 'vCash' } }), 'refund to another account');
  await assertDenied(refundBatch(BOB, 'e1', 1, 100000, { ledger: 90000 }), 'ledger must equal the refund');
  await assertSucceeds(refundBatch(BOB, 'e1', 1, 100000, { ledger: 100000 }), 'refund #1');
  await assertDenied(refundBatch(BOB, 'e1', 1, 100000, { ledger: 200000 }), 'retry of #1 cannot double-count');
  await assertSucceeds(refundBatch(BOB, 'e1', 2, 50000, { ledger: 150000 }), 'refund #2');
  const voidRf = (n, reason, refunded) => { const f = db(BOB); const b = writeBatch(f);
    b.update(mPath(f, 'h1', `e1_rf${n}`), { status: 'void', voidedAt: T(), voidedBy: 'bob', voidReason: reason, updatedBy: 'bob', updatedAt: T() });
    b.update(lPath(f, 'h1', 'e1'), { refundSeq: 2, refundedMinor: refunded, rev: 3, updatedBy: 'bob', updatedAt: T(), schemaVersion: 1 }); return b.commit(); };
  await assertDenied(voidRf(1, 'mistake', 50000), 'only the latest created refund');
  await assertDenied(voidRf(2, null, 100000), 'reason required');
  await assertSucceeds(voidRf(2, 'entered twice', 100000), 'void latest');
  await assertDenied(updateDoc(ePath(db(BOB), 'h1', 'e1'), { amountMinor: 1, updatedBy: 'bob', updatedAt: T() }), 'money fields frozen once refunded');
  await assertDenied(updateDoc(ePath(db(BOB), 'h1', 'e1'), { status: 'void', voidedAt: T(), voidedBy: 'bob', voidReason: 'x', updatedBy: 'bob', updatedAt: T() }), 'no void while refunds are active');
  await assertSucceeds(updateDoc(ePath(db(BOB), 'h1', 'e1'), { note: 'kept', updatedBy: 'bob', updatedAt: T() }), 'non-money edits still allowed');
  await assertDenied(getDoc(lPath(db(MALLORY), 'h1', 'e1')), 'ledger: cross-home / non-member');
});

test('V6-6 savings / zakat links: sv_* never voided by Finance; zk_* expense never voided or re-priced by Finance', async () => {
  await v6Home();
  await seed(['homes', 'h1', 'walletMovements', 'sv_t1'], v6mv('alice', { type: 'savings', savingsTransferId: 't1', fromWalletId: 'vBank', toWalletId: null }));
  await assertDenied(updateDoc(mPath(db(ALICE), 'h1', 'sv_t1'), { status: 'void', voidedAt: T(), voidedBy: 'alice', updatedBy: 'alice', updatedAt: T() }), 'sv_* void');
  await seed(['homes', 'h1', 'expenses', 'zk_r1'], expense('alice', { category: 'zakat', walletId: null }));
  await assertDenied(updateDoc(ePath(db(ALICE), 'h1', 'zk_r1'), { status: 'void', voidedAt: T(), voidedBy: 'alice', voidReason: 'x', updatedBy: 'alice', updatedAt: T() }), 'zk_* void');
  await assertDenied(updateDoc(ePath(db(ALICE), 'h1', 'zk_r1'), { amountMinor: 1, updatedBy: 'alice', updatedAt: T() }), 'zk_* amount edit');
});

test('V6-7 budget authorization matrix: member / viewer / child denied on every period + head path; admin and owner allowed', async () => {
  await v6Home();
  const headOnly = (u, rev, last, end) => setDoc(hdPath(db(u), 'h1'), { lastPeriodId: last, endDateExclusive: end, audience: 'household', readers: [], rev, updatedBy: u.uid, updatedAt: T() });
  const close = (u, id) => updateDoc(pPath(db(u), 'h1', id), { status: 'closed', closingSnapshot: { capMinor: 2000000, spentMinor: 0, remainingMinor: 2000000 }, rev: 2, updatedBy: u.uid, updatedAt: T() });
  for (const u of [BOB, V6_VIEWER, V6_CHILD]) {
    await assertDenied(periodBatch(u, db(u), { id: 'p_20260101', start: '2026-01-01', end: '2026-02-01', headRev: 1 }), `${u.uid}: first period`);
    await assertDenied(headOnly(u, 1, 'p_20260101', '2026-02-01'), `${u.uid}: head alone`);
  }
  await assertSucceeds(periodBatch(ADMIN_H1, db(ADMIN_H1), { id: 'p_20260101', start: '2026-01-01', end: '2026-02-01', headRev: 1 }), 'admin: first period');
  for (const u of [BOB, V6_VIEWER, V6_CHILD]) {
    await assertDenied(periodBatch(u, db(u), { id: 'p_20260201', start: '2026-02-01', end: '2026-03-01', headRev: 2 }), `${u.uid}: next period`);
    await assertDenied(headOnly(u, 2, 'p_20260101', '2026-02-01'), `${u.uid}: head update`);
    await assertDenied(close(u, 'p_20260101'), `${u.uid}: close`);
  }
  await assertSucceeds(periodBatch(ALICE, db(ALICE), { id: 'p_20260201', start: '2026-02-01', end: '2026-03-01', headRev: 2 }), 'owner: next period');
  await assertSucceeds(close(ADMIN_H1, 'p_20260101'), 'admin: close an ended period');
  await assertSucceeds(getDoc(pPath(db(V6_VIEWER), 'h1', 'p_20260101')), 'viewer can still read the household budget');
  await assertDenied(getDoc(pPath(db(V6_CHILD), 'h1', 'p_20260101')), 'child has no expenses.view');
});


// =================================================================== V6 FINANCE — batch 2
const ccPath = (f, h, id) => doc(f, 'homes', h, 'budgetCapChanges', id);
function capBatch(u, { id = 'p_20260201', to, from = 2000000, rev = 2, reason = 'Guests', skipRecord = false, skipPeriod = false, rec = {} } = {}) {
  const f = db(u); const b = writeBatch(f);
  if (!skipPeriod) b.update(pPath(f, 'h1', id), { capMinor: to, rev, updatedBy: u.uid, updatedAt: T() });
  if (!skipRecord) b.set(ccPath(f, 'h1', `${id}_r${rev}`), { periodId: id, rev, fromMinor: from, toMinor: to, reason, audience: 'household', readers: [], actorUid: u.uid, at: T(), schemaVersion: 1, ...rec });
  return b.commit();
}

test('V6-8 audited cap edits: period + create-only record in one batch; from / to / actor exact; manageBudgets; open periods only', async () => {
  await v6Home();
  await assertSucceeds(periodBatch(ALICE, db(ALICE), { id: 'p_20260101', start: '2026-01-01', end: '2026-02-01', headRev: 1 }));
  await assertSucceeds(periodBatch(ALICE, db(ALICE), { id: 'p_20260201', start: '2026-02-01', end: '2099-01-01', headRev: 2 }));
  await assertDenied(capBatch(ADMIN_H1, { to: 2500000, skipRecord: true }), 'cap without its change record');
  await assertDenied(capBatch(ADMIN_H1, { to: 2500000, skipPeriod: true }), 'change record alone');
  await assertDenied(capBatch(ADMIN_H1, { to: 2500000, from: 1 }), 'from must be the stored cap');
  await assertDenied(capBatch(ADMIN_H1, { to: 2500000, rec: { toMinor: 2400000 } }), 'to must be the new cap');
  await assertDenied(capBatch(ADMIN_H1, { to: 2500000, rec: { actorUid: 'alice' } }), 'forged actor');
  await assertDenied(capBatch(ADMIN_H1, { to: 2500000, reason: ' ' }), 'reason required');
  await assertDenied(capBatch(V6_VIEWER, { to: 2500000 }), 'viewer lacks manageBudgets');
  await assertDenied(capBatch(BOB, { to: 2500000 }), 'member: not a budget manager (V6 batch 3)');
  await assertSucceeds(capBatch(ADMIN_H1, { to: 2500000 }), 'admin: audited edit');
  await assertDenied(updateDoc(ccPath(db(ALICE), 'h1', 'p_20260201_r2'), { reason: 'rewritten' }), 'history immutable');
  await assertDenied(deleteDoc(ccPath(db(ALICE), 'h1', 'p_20260201_r2')), 'history never deleted');
  await assertSucceeds(getDoc(ccPath(db(V6_VIEWER), 'h1', 'p_20260201_r2')), 'household can read the history');
  await assertDenied(getDoc(ccPath(db(MALLORY), 'h1', 'p_20260201_r2')), 'cross-home');
  await assertSucceeds(updateDoc(pPath(db(ALICE), 'h1', 'p_20260101'), { status: 'closed', closingSnapshot: { capMinor: 2000000, spentMinor: 0, remainingMinor: 2000000 }, rev: 2, updatedBy: 'alice', updatedAt: T() }));
  await assertDenied(capBatch(ALICE, { id: 'p_20260101', to: 1, rev: 3 }), 'closed period: cap read-only');
});

test('V6-9 closed periods read-only for money; transfers not before an opening; rename keeps identity', async () => {
  await v6Home();
  await assertSucceeds(periodBatch(ALICE, db(ALICE), { id: 'p_20260101', start: '2026-01-01', end: '2026-02-01', headRev: 1 }));
  await assertSucceeds(setDoc(ePath(db(BOB), 'h1', 'c1'), expense('bob', { walletId: 'vBank', paymentMethod: 'debit_card', date: '2026-01-15', periodId: 'p_20260101', lateEntry: false })));
  await assertSucceeds(updateDoc(pPath(db(ALICE), 'h1', 'p_20260101'), { status: 'closed', closingSnapshot: { capMinor: 2000000, spentMinor: 45000, remainingMinor: 1955000 }, rev: 2, updatedBy: 'alice', updatedAt: T() }));
  await assertDenied(updateDoc(ePath(db(BOB), 'h1', 'c1'), { amountMinor: 1, updatedBy: 'bob', updatedAt: T() }), 'money edit in a closed period');
  await assertDenied(updateDoc(ePath(db(BOB), 'h1', 'c1'), { status: 'void', voidedAt: T(), voidedBy: 'bob', voidReason: 'x', updatedBy: 'bob', updatedAt: T() }), 'void in a closed period');
  await assertSucceeds(updateDoc(ePath(db(BOB), 'h1', 'c1'), { note: 'receipt filed', updatedBy: 'bob', updatedAt: T() }), 'non-money edit still allowed');
  await assertDenied(setDoc(ePath(db(BOB), 'h1', 'c2'), expense('bob', { walletId: 'vBank', date: '2026-01-20', periodId: 'p_20260101', lateEntry: false })), 'new attribution to a closed period');
  const tr = (date) => setDoc(mPath(db(BOB), 'h1', `tr_${date}`), v6mv('bob', { type: 'transfer', fromWalletId: 'vBank', toWalletId: 'vCash', date }));
  await assertDenied(tr('2025-12-31'), 'transfer before the opening');
  await assertSucceeds(tr('2026-03-01'), 'ATM withdrawal');
  await assertSucceeds(updateDoc(wPath(db(ALICE), 'h1', 'vBank'), { name: 'Main bank', updatedBy: 'alice', updatedAt: T() }), 'rename (manageWallets)');
  await assertDenied(updateDoc(wPath(db(BOB), 'h1', 'vBank'), { name: 'Mine', updatedBy: 'bob', updatedAt: T() }), 'member cannot rename household accounts');
});

test('V6-10 stale role documents: a member role that still grants manageBudgets (pre-v7 Home) gives NO budget authority; admin / owner keep it', async () => {
  await v6Home();
  await env.withSecurityRulesDisabled(async (c) => {
    const r = doc(c.firestore(), 'homes', 'h1', 'roles', 'member');
    const cur = (await getDoc(r)).data();
    await setDoc(r, { ...cur, permissions: [...new Set([...(cur.permissions || []), 'expenses.manageBudgets'])], templateVersion: 6 });
  });
  await assertDenied(periodBatch(BOB, db(BOB), { id: 'p_20260101', start: '2026-01-01', end: '2026-02-01', headRev: 1 }), 'member with a stale grant: denied by role');
  await seed(['homes', 'h1', 'spendingCycles', 'cx'], cycleDoc('alice'));
  await assertDenied(budgetEdit(BOB, 'cx', { from: 1000000, to: 1100000, rev: 1 }), 'household wallet cycle: denied by role');
  await assertSucceeds(periodBatch(ADMIN_H1, db(ADMIN_H1), { id: 'p_20260101', start: '2026-01-01', end: '2026-02-01', headRev: 1 }), 'admin');
  await assertDenied(periodBatch(OWNER_HOME_B, db(OWNER_HOME_B), { id: 'p_20260201', start: '2026-02-01', end: '2026-03-01', headRev: 2 }), 'another Home\'s owner');
  await assertDenied(periodBatch(MALLORY, db(MALLORY), { id: 'p_20260201', start: '2026-02-01', end: '2026-03-01', headRev: 2 }), 'non-member');
});


test('V6-11 V6 accounts: Savings transfers never predate the opening; funding / adjustment refused (income / reconciliation instead); pre-V6 wallets unchanged', async () => {
  await savingsHome();
  const W = (extra) => ({ name: 'Bank', type: 'bank', scope: 'home', ownerUid: null, visibility: 'household', sharedWith: [], readers: [], currency: 'EGP', active: true,
    archivedAt: null, archivedBy: null, createdBy: OWNER_A.uid, createdAt: new Date(), updatedBy: OWNER_A.uid, updatedAt: new Date(), schemaVersion: 1, ...extra });
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();   // one firestore() per context
    await setDoc(doc(f, 'homes', 'hA', 'wallets', 'v6bank'), W({ role: 'bank', openingDate: '2026-10-05' }));
    await setDoc(doc(f, 'homes', 'hA', 'wallets', 'oldbank'), W({ name: 'Old bank' }));
  });
  const fund = assetDoc(OWNER_A, { scope: 'home', ownerUid: null, visibility: 'household', audience: 'household', readers: [] });
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'homes', 'hA', 'savingsAssets', 'fund'), { ...fund, createdAt: new Date(), updatedAt: new Date() }));
  const base = { amountMinor: 1000000, currency: 'EGP', fromWalletId: null, toWalletId: null, cycleId: null, note: null, audience: 'household', readers: [], status: 'active',
    voidedAt: null, voidedBy: null, createdBy: OWNER_A.uid, createdAt: nowTs(), updatedBy: OWNER_A.uid, updatedAt: nowTs(), schemaVersion: 1 };
  const pair = (tid, date) => { const b = writeBatch(db(OWNER_A));
    b.set(svRef(OWNER_A, 'walletMovements', `sv_${tid}`), { ...base, type: 'savings', date, fromWalletId: 'v6bank', savingsTransferId: tid });
    b.set(svRef(OWNER_A, 'savingsEvents', `${tid}_in`), eventDoc(OWNER_A, 'fund', fund, { type: 'transfer_in', qty: 1000000, transferId: tid, walletId: 'v6bank' }));
    return b.commit(); };
  await assertDenied(pair('e1', '2026-10-04'), 'savings transfer before the opening');
  await assertSucceeds(pair('e2', '2026-10-05'), 'on the opening date');
  await assertDenied(setDoc(svRef(OWNER_A, 'walletMovements', 'f1'), { ...base, type: 'funding', date: '2026-10-06', toWalletId: 'v6bank' }), 'funding on a V6 account (use income)');
  await assertDenied(setDoc(svRef(OWNER_A, 'walletMovements', 'a1'), { ...base, type: 'adjustment', date: '2026-10-06', toWalletId: 'v6bank' }), 'adjustment on a V6 account (use reconciliation)');
  await assertSucceeds(setDoc(svRef(OWNER_A, 'walletMovements', 'i1'), { ...base, type: 'income', source: 'Salary', date: '2026-10-06', toWalletId: 'v6bank' }), 'income instead');
  await assertSucceeds(recon(OWNER_A, db(OWNER_A), 'hA', 'v6bank', 1, { delta: 1000000, before: 0, date: '2026-10-06' }), 'reconciliation instead');
  await assertSucceeds(setDoc(svRef(OWNER_A, 'walletMovements', 'f2'), { ...base, type: 'funding', date: '2026-10-06', toWalletId: 'oldbank' }), 'pre-V6 wallet: funding unchanged');
});

test('V622-1 Correct Balance: atomic rc_ id + wallet seq; managers only; duplicates / skipped / unpaired / mismatched / archived refused; append-only (no void)', async () => {
  await v6Home();
  const A = db(ALICE);
  await assertSucceeds(recon(ALICE, A, 'h1', 'vCash', 1, { delta: 2500, before: 40000 }), 'owner: + correction');
  await assertSucceeds(recon(ADMIN_H1, db(ADMIN_H1), 'h1', 'vCash', 2, { delta: -500, before: 42500 }), 'admin: − correction');
  await assertDenied(recon(ALICE, A, 'h1', 'vCash', 2, { delta: 100, before: 42000 }), 'same id again (double click / other device)');
  await assertDenied(recon(ALICE, A, 'h1', 'vCash', 4, { delta: 100, before: 42000 }), 'sequence cannot skip');
  await assertDenied(recon(ALICE, A, 'h1', 'vCash', 3, { delta: 100, before: 42000, bump: false }), 'movement without the wallet bump');
  await assertDenied(updateDoc(wPath(A, 'h1', 'vCash'), { correctionSeq: 3, updatedBy: 'alice', updatedAt: T() }), 'wallet bump without its movement');
  await assertDenied(recon(ALICE, A, 'h1', 'vCash', 3, { delta: 100, before: 42000, mv: { afterMinor: 50000 } }), 'before / after must match the signed amount');
  await assertDenied(recon(ALICE, A, 'h1', 'vCash', 3, { delta: 100, before: 42000, mv: { date: '2025-12-31' } }), 'before the opening date');
  await assertDenied(recon(ALICE, A, 'h1', 'vCash', 3, { delta: 100, before: 42000, mv: { correctionSeq: 0 } }), 'seq ≥ 1 and id must agree');
  await assertDenied(recon(BOB, db(BOB), 'h1', 'vCash', 3, { delta: 100, before: 42000 }), 'member');
  await assertDenied(recon(V6_VIEWER, db(V6_VIEWER), 'h1', 'vCash', 3, { delta: 100, before: 42000 }), 'viewer');
  await assertDenied(recon(MALLORY, db(MALLORY), 'h1', 'vCash', 3, { delta: 100, before: 42000 }), 'non-member');
  await assertDenied(updateDoc(mPath(A, 'h1', 'rc_vCash_1'), { status: 'void', voidedAt: T(), voidedBy: 'alice', updatedBy: 'alice', updatedAt: T() }), 'corrections are append-only');
  await assertSucceeds(recon(ALICE, A, 'h1', 'vCash', 3, { delta: 100, before: 42000 }), 'next in sequence');
  // archived (non-role) wallet: no correction
  await seed(['homes', 'h1', 'wallets', 'oldVisa'], householdWallet('alice', { name: 'Old Visa', type: 'card', active: false, archivedAt: new Date(), archivedBy: 'alice' }));
  await assertDenied(recon(ALICE, A, 'h1', 'oldVisa', 1, { delta: 100, before: 0 }), 'archived wallet');
});

test('V622-2 Delete wallet = archive: the Home Cash / Bank are never archived; other wallets archive + restore (managers only); nothing is hard-deleted', async () => {
  await v6Home();
  const arch = (u, w, active) => updateDoc(wPath(db(u), 'h1', w), active ? { active: true, archivedAt: null, archivedBy: null, updatedBy: u.uid, updatedAt: T() }
    : { active: false, archivedAt: T(), archivedBy: u.uid, updatedBy: u.uid, updatedAt: T() });
  await assertDenied(arch(ALICE, 'vCash', false), 'required Cash');
  await assertDenied(arch(ALICE, 'vBank', false), 'required Bank');
  await assertSucceeds(updateDoc(wPath(db(ALICE), 'h1', 'vCash'), { name: 'Cash in hand', updatedBy: 'alice', updatedAt: T() }), 'rename still allowed');
  await seed(['homes', 'h1', 'wallets', 'visa'], householdWallet('alice', { name: 'Visa', type: 'card' }));
  await assertDenied(arch(BOB, 'visa', false), 'member cannot delete');
  await assertSucceeds(arch(ALICE, 'visa', false), 'archive');
  await assertSucceeds(arch(ALICE, 'visa', true), 'restore');
  await assertDenied(deleteDoc(wPath(db(ALICE), 'h1', 'visa')), 'no hard delete');
});

test('V622-3 calendar shift subtype: day / night only; a shift is always Work; older events gain it on edit', async () => {
  await savingsHome();
  const W = MEMBER_WIFE;
  await assertSucceeds(setDoc(calPath(db(W), 'evShift1'), calDoc(W, { title: 'Day Shift', type: 'work', shift: 'day' })), 'day shift');
  await assertSucceeds(setDoc(calPath(db(W), 'evShift2'), calDoc(W, { title: 'Night Shift', type: 'work', shift: 'night' })), 'night shift');
  await assertDenied(setDoc(calPath(db(W), 'evShift3'), calDoc(W, { title: 'Night Shift', type: 'vacation', shift: 'night' })), 'a shift is never Vacation');
  await assertDenied(setDoc(calPath(db(W), 'evShift4'), calDoc(W, { shift: 'evening', type: 'work' })), 'unknown subtype');
  await assertSucceeds(setDoc(calPath(db(W), 'evShift5'), calDoc(W, { title: 'Day Shift', type: 'vacation', shift: null })), 'explicit "not a shift" override');
  await seed(['homes', 'hA', 'calendarEvents', 'evLegacy1'], (() => { const d = calDoc(W, { title: 'Day Shift', type: 'work' }); delete d.shift; return d; })());
  await assertSucceeds(updateDoc(calPath(db(W), 'evLegacy1'), { shift: 'day', rev: 2, updatedBy: W.uid, updatedAt: serverTimestamp() }), 'V6.2 event classified on edit');
});

// =================================================================== V6.1 — RECIPES + COOKING TIMERS
const rcPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'recipes', id);
const tmPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'cookingTimers', id);
const recipeDoc = (u, extra = {}) => (asUser(u, 'recipeDoc'), { titleEn: 'Koshari', titleAr: null, description: null, category: 'main', prepMinutes: 10, cookMinutes: 30, servings: 4,
  videoId: 'dQw4w9WgXcQ', videoUrl: null, ingredients: [{ id: 'irice01', name: 'Rice', amountMilli: 1500, unit: 'cup', note: null }], steps: [{ id: 'sboil01', text: 'Boil', minutes: 10 }], notes: null,
  favoritedBy: [], archived: false, archivedAt: null, archivedBy: null, rev: 1, createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
const timerDoc = (u, extra = {}) => (asUser(u, 'timerDoc'), { ownerUid: u.uid, label: 'Rice', durationMs: 600000, status: 'running', endsAtMs: Date.now() + 600000, remainingMsAtPause: null,
  recipeId: null, stepId: null, rev: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });

test('V61-1 recipes: chef.* only; strict shape (video id, bounds); edit rev + 1; archive / restore; no delete; favorites = own uid only; isolation', async () => {
  await genHome();
  const W = MEMBER_WIFE; const up = (u, data) => updateDoc(rcPath(db(u), 'rec001'), { ...data, updatedBy: u.uid, updatedAt: serverTimestamp() });
  await assertDenied(setDoc(rcPath(db(VIEWER_A), 'recV01'), recipeDoc(VIEWER_A)), 'viewer cannot create');
  await assertDenied(setDoc(rcPath(db(CHILD_A), 'recC01'), recipeDoc(CHILD_A)), 'child cannot create');
  for (const [x, why] of [[{ videoId: '<iframe>' }, 'video id format'], [{ videoId: 'https://youtu.be/dQw4w9WgXcQ' }, 'a URL is not stored'], [{ servings: 0 }, 'servings ≥ 1'],
    [{ prepMinutes: 2000 }, 'minutes bound'], [{ titleEn: null, titleAr: null }, 'a title is required'], [{ category: 'poison' }, 'category'], [{ createdBy: OWNER_A.uid }, 'forged author'],
    [{ favoritedBy: [W.uid] }, 'starts with no favorites'], [{ cost: 5 }, 'no unknown fields (no finance)']]) await assertDenied(setDoc(rcPath(db(W), 'recX01'), recipeDoc(W, x)), why);
  await assertSucceeds(setDoc(rcPath(db(W), 'rec001'), recipeDoc(W)), 'member creates');
  await assertSucceeds(up(W, { notes: 'Spicy', rev: 2 }), 'edit');
  await assertDenied(up(OWNER_A, { notes: 'stale', rev: 2 }), 'stale revision');
  await assertDenied(up(VIEWER_A, { notes: 'x', rev: 3 }), 'viewer cannot edit');
  await assertSucceeds(updateDoc(rcPath(db(VIEWER_A), 'rec001'), { favoritedBy: [VIEWER_A.uid] }), 'viewer favorites (own uid)');
  await assertDenied(updateDoc(rcPath(db(VIEWER_A), 'rec001'), { favoritedBy: [VIEWER_A.uid, W.uid] }), "cannot add someone else's favorite");
  await assertSucceeds(updateDoc(rcPath(db(W), 'rec001'), { favoritedBy: [VIEWER_A.uid, W.uid] }), 'member adds own');
  await assertDenied(updateDoc(rcPath(db(W), 'rec001'), { favoritedBy: [W.uid] }), "cannot remove someone else's favorite");
  await assertSucceeds(up(W, { archived: true, archivedAt: serverTimestamp(), archivedBy: W.uid, rev: 3 }), 'archive');
  await assertDenied(up(W, { notes: 'while archived', rev: 4 }), 'no edits while archived');
  await assertSucceeds(up(W, { archived: false, archivedAt: null, archivedBy: null, rev: 4 }), 'restore');
  await assertDenied(deleteDoc(rcPath(db(OWNER_A), 'rec001')), 'never deleted (future meal-plan references)');
  await assertSucceeds(getDoc(rcPath(db(CHILD_A), 'rec001')), 'child can read (chef.view)');
  await assertDenied(getDoc(rcPath(db(OWNER_HOME_B), 'rec001')), 'cross-home');
  await assertDenied(getDoc(rcPath(db(MALLORY), 'rec001')), 'non-member');
});

test('V61-2 cooking timers: owner-only per Home; derived-time fields validated; idempotent transitions; no sharing', async () => {
  await genHome();
  const W = MEMBER_WIFE; const O = MEMBER_OTHER;
  const up = (u, data) => updateDoc(tmPath(db(u), 'tim001'), { ...data, updatedAt: serverTimestamp() });
  for (const [x, why] of [[{ ownerUid: O.uid }, 'forged owner'], [{ durationMs: 500 }, '≥ 1 s'], [{ durationMs: 90000000 }, '≤ 24 h'], [{ endsAtMs: Date.now() + 99999999 }, 'end within the duration'],
    [{ status: 'paused' }, 'paused needs remaining (and no end)'], [{ label: ' ' }, 'label'], [{ createdAt: new Date() }, 'server time'], [{ extra: 1 }, 'exact keys']]) await assertDenied(setDoc(tmPath(db(W), 'timX01'), timerDoc(W, x)), why);
  await assertSucceeds(setDoc(tmPath(db(W), 'tim001'), timerDoc(W)), 'create running');
  await assertSucceeds(up(W, { status: 'paused', endsAtMs: null, remainingMsAtPause: 400000, rev: 2 }), 'pause');
  await assertDenied(up(W, { status: 'running', endsAtMs: Date.now() + 400000, remainingMsAtPause: null, rev: 2 }), 'stale revision (another tab)');
  await assertSucceeds(up(W, { status: 'running', endsAtMs: Date.now() + 400000, remainingMsAtPause: null, rev: 3 }), 'resume');
  await assertSucceeds(up(W, { status: 'completed', endsAtMs: null, remainingMsAtPause: null, rev: 4 }), 'complete');
  await assertDenied(up(W, { status: 'completed', endsAtMs: null, remainingMsAtPause: null, rev: 4 }), 'second completion (same rev) refused → no duplicate');
  await assertDenied(up(W, { durationMs: 1000, rev: 5 }), 'duration immutable');
  await assertDenied(getDoc(tmPath(db(O), 'tim001')), 'another member cannot read');
  await assertDenied(getDocs(query(collection(db(O), 'homes', 'hA', 'cookingTimers'), where('ownerUid', '==', W.uid))), 'another member cannot list');
  await assertSucceeds(getDocs(query(collection(db(W), 'homes', 'hA', 'cookingTimers'), where('ownerUid', '==', W.uid))), 'owner lists own');
  await assertDenied(up(O, { label: 'mine', rev: 5 }), 'another member cannot control');
  await assertDenied(getDoc(tmPath(db(OWNER_HOME_B), 'tim001')), 'cross-home');
  await assertDenied(setDoc(tmPath(db(MALLORY), 'timM01'), timerDoc(MALLORY)), 'non-member');
  await assertDenied(deleteDoc(tmPath(db(O), 'tim001')), 'another member cannot delete');
  await assertSucceeds(deleteDoc(tmPath(db(W), 'tim001')), 'owner deletes');
});

// =================================================================== V6.1.1
test('V611-1 recipes: safe non-YouTube video LINK; soft delete (chef.delete) → immutable, still readable; no hard delete', async () => {
  await genHome();
  const W = MEMBER_WIFE; const O = OWNER_A;
  await assertSucceeds(setDoc(rcPath(db(W), 'recFB1'), recipeDoc(W, { videoId: null, videoUrl: 'https://www.facebook.com/watch?v=123' })), 'Facebook link');
  for (const [u, why] of [['https://www.facebook.com/x', 'never both a YouTube id and a link'], ['http://facebook.com/x', 'https only'], ['https://u:p@facebook.com/x', 'no credentials'],
    ['https://facebook.com:444/x', 'no port'], ['javascript:alert(1)', 'scheme'], ['https://a.com/<script>', 'no markup'], [`https://a.com/${'x'.repeat(500)}`, 'length']])
    await assertDenied(setDoc(rcPath(db(W), 'recBad1'), recipeDoc(W, { videoId: why.startsWith('never') ? 'dQw4w9WgXcQ' : null, videoUrl: u })), why);
  await assertSucceeds(setDoc(rcPath(db(W), 'recDel1'), recipeDoc(W)));
  const del = (u, extra = {}) => updateDoc(rcPath(db(u), 'recDel1'), { deletedAt: serverTimestamp(), deletedBy: u.uid, rev: 2, updatedBy: u.uid, updatedAt: serverTimestamp(), ...extra });
  await assertDenied(del(W), 'member lacks chef.delete');
  await assertDenied(del(O, { deletedBy: W.uid }), 'forged deletedBy');
  await assertDenied(del(O, { deletedAt: new Date() }), 'server time');
  await assertDenied(deleteDoc(rcPath(db(O), 'recDel1')), 'never a hard delete');
  await assertSucceeds(del(O), 'owner soft-deletes');
  await assertDenied(updateDoc(rcPath(db(O), 'recDel1'), { notes: 'x', rev: 3, updatedBy: O.uid, updatedAt: serverTimestamp() }), 'deleted: no edits');
  await assertDenied(updateDoc(rcPath(db(O), 'recDel1'), { archived: true, archivedAt: serverTimestamp(), archivedBy: O.uid, rev: 3, updatedBy: O.uid, updatedAt: serverTimestamp() }), 'deleted: no archive');
  await assertDenied(updateDoc(rcPath(db(W), 'recDel1'), { favoritedBy: [W.uid] }), 'deleted: no favorites');
  await assertDenied(updateDoc(rcPath(db(O), 'recDel1'), { deletedAt: serverTimestamp(), deletedBy: O.uid, rev: 3, updatedBy: O.uid, updatedAt: serverTimestamp() }), 'no re-delete');
  await assertSucceeds(getDoc(rcPath(db(W), 'recDel1')), 'still readable by id (future meal-plan references)');
  await assertDenied(getDoc(rcPath(db(OWNER_HOME_B), 'recDel1')), 'cross-home');
});

test('V611-2 timers: a ringing alarm (completed) is stopped only by its owner (→ dismissed); idempotent', async () => {
  await genHome();
  const W = MEMBER_WIFE;
  await assertSucceeds(setDoc(tmPath(db(W), 'timA01'), timerDoc(W, { status: 'completed', endsAtMs: null })), 'an undismissed alarm');
  const stop = (u, rev) => updateDoc(tmPath(db(u), 'timA01'), { status: 'dismissed', endsAtMs: null, remainingMsAtPause: null, rev, updatedAt: serverTimestamp() });
  await assertDenied(stop(MEMBER_OTHER, 2), 'another member cannot stop it');
  await assertSucceeds(stop(W, 2), 'owner stops the alarm');
  await assertDenied(stop(W, 2), 'second stop (same revision) refused — no duplicate effect');
  await assertDenied(updateDoc(tmPath(db(W), 'timA01'), { status: 'dismissed', endsAtMs: Date.now(), remainingMsAtPause: null, rev: 3, updatedAt: serverTimestamp() }), 'dismissed carries no end time');
});

// =================================================================== V6.2 — CALENDAR + MONTHLY BUDGET
const calPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'calendarEvents', id);
const calDoc = (u, extra = {}) => (asUser(u, 'calDoc'), { title: 'Day Shift', type: 'work', allDay: false, startDate: '2026-01-05', startTime: '07:00', endDate: '2026-01-08', endTime: '19:00',
  description: null, location: null, audience: 'household', timezone: 'Africa/Cairo', done: false, source: 'manual', sourceKey: null, importBatchId: null, importRev: null, shift: null, deletedAt: null, deletedBy: null, rev: 1,
  createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });

test('V62-1 calendar: calendar.* roles; strict shape; CSV create-only identity (no duplicates); private = creator only (owner denied); soft delete; isolation', async () => {
  await savingsHome();
  const W = MEMBER_WIFE; const up = (u, id, data) => updateDoc(calPath(db(u), id), { ...data, updatedBy: u.uid, updatedAt: serverTimestamp() });
  await assertDenied(setDoc(calPath(db(VIEWER_A), 'evV001'), calDoc(VIEWER_A)), 'viewer cannot create');
  await assertDenied(setDoc(calPath(db(CHILD_A), 'evC001'), calDoc(CHILD_A)), 'child cannot create');
  for (const [x, why] of [[{ type: 'party' }, 'type'], [{ endDate: '2026-01-04' }, 'end before start'], [{ startTime: '25:00' }, 'time format'], [{ allDay: true }, 'all-day carries no times'],
    [{ createdBy: OWNER_A.uid }, 'forged author'], [{ done: true }, 'starts not done'], [{ source: 'csv' }, 'csv needs its fingerprint id'], [{ title: ' ' }, 'title'], [{ cost: 1 }, 'exact keys']])
    await assertDenied(setDoc(calPath(db(W), 'evX001'), calDoc(W, x)), why);
  await assertSucceeds(setDoc(calPath(db(W), 'ev0001'), calDoc(W)), 'member creates (household)');
  const key = '0123456789abcdef';
  await assertSucceeds(setDoc(batchPath(db(W), 'btW001'), batchDoc(W)), 'import batch (V6.2.1)');
  await assertSucceeds(setDoc(batchPath(db(OWNER_A), 'btO001'), batchDoc(OWNER_A)), 'owner batch');
  const csv = (u, b, x = {}) => calDoc(u, { source: 'csv', sourceKey: key, importBatchId: b, importRev: 1, ...x });
  await assertDenied(setDoc(calPath(db(W), 'csv_ffffffffffffffff'), csv(W, 'btW001')), 'csv id must equal csv_ + sourceKey');
  await assertSucceeds(setDoc(calPath(db(W), `csv_${key}`), csv(W, 'btW001')), 'csv import row');
  await assertDenied(setDoc(calPath(db(OWNER_A), `csv_${key}`), csv(OWNER_A, 'btO001')), 're-import (any member) cannot overwrite → no duplicate');
  await assertSucceeds(up(W, 'ev0001', { title: 'Night Shift', rev: 2 }), 'edit');
  await assertDenied(up(OWNER_A, 'ev0001', { title: 'stale', rev: 2 }), 'stale revision');
  await assertDenied(up(W, 'ev0001', { done: true, rev: 3 }), 'only tasks can be done');
  await assertDenied(up(W, 'ev0001', { audience: 'private', rev: 3 }), 'audience immutable');
  await assertSucceeds(setDoc(calPath(db(W), 'evP001'), calDoc(W, { audience: 'private', type: 'task' })), 'private event');
  await assertDenied(getDoc(calPath(db(OWNER_A), 'evP001')), 'Home owner denied a private event');
  await assertDenied(getDocs(query(collection(db(OWNER_A), 'homes', 'hA', 'calendarEvents'), where('createdBy', '==', W.uid))), 'owner cannot list her private events');
  await assertSucceeds(getDocs(query(collection(db(W), 'homes', 'hA', 'calendarEvents'), where('createdBy', '==', W.uid))), 'creator lists her own (incl. private)');
  await assertSucceeds(getDocs(query(collection(db(CHILD_A), 'homes', 'hA', 'calendarEvents'), where('audience', '==', 'household'))), 'child reads household events');
  await assertDenied(up(OWNER_A, 'evP001', { done: true, rev: 2 }), 'owner cannot edit a private event');
  await assertSucceeds(up(W, 'evP001', { done: true, rev: 2 }), 'creator marks her task done');
  const del = (u, id, rev) => up(u, id, { deletedAt: serverTimestamp(), deletedBy: u.uid, rev });
  await assertDenied(del(W, 'ev0001', 3), 'member lacks calendar.delete');
  await assertDenied(deleteDoc(calPath(db(OWNER_A), 'ev0001')), 'never a hard delete');
  await assertSucceeds(del(ADMIN_A, 'ev0001', 3), 'admin soft-deletes');
  await assertDenied(up(W, 'ev0001', { title: 'x', rev: 4 }), 'deleted: immutable');
  await assertDenied(getDoc(calPath(db(OWNER_HOME_B), `csv_${key}`)), 'cross-home');
  await assertDenied(getDoc(calPath(db(MALLORY), `csv_${key}`)), 'non-member');
});

const batchPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'calendarImports', id);
const batchDoc = (u, extra = {}) => ({ fileName: 'google.csv', audience: 'household', status: 'importing', createdCount: 0, removedCount: 0, keptCount: 0, rev: 1,
  createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });

test('V621-1 CSV import batches: strict shape; imported events must name the importer\'s OPEN batch (same audience); manual events carry none; status transitions; private batches creator-only; no hard delete', async () => {
  await savingsHome();
  const W = MEMBER_WIFE; const key = 'aaaaaaaaaaaaaaaa'; const id = `csv_${key}`;
  const bu = (u, b, data) => updateDoc(batchPath(db(u), b), { ...data, updatedBy: u.uid, updatedAt: serverTimestamp() });
  for (const [x, why] of [[{ status: 'active' }, 'starts importing'], [{ createdCount: 3 }, 'starts at 0'], [{ createdBy: OWNER_A.uid }, 'forged importer'], [{ fileName: ' ' }, 'file name'],
    [{ audience: 'everyone' }, 'audience'], [{ extra: 1 }, 'exact keys'], [{ rev: 2 }, 'rev 1']])
    await assertDenied(setDoc(batchPath(db(W), 'btX001'), batchDoc(W, x)), `batch: ${why}`);
  await assertDenied(setDoc(batchPath(db(VIEWER_A), 'btV001'), batchDoc(VIEWER_A)), 'viewer cannot import');
  await assertSucceeds(setDoc(batchPath(db(W), 'btW101'), batchDoc(W)), 'member opens a batch');
  await assertSucceeds(setDoc(batchPath(db(OWNER_A), 'btO101'), batchDoc(OWNER_A)), 'owner opens a batch');
  const ev = (u, b, x = {}) => calDoc(u, { source: 'csv', sourceKey: key, importBatchId: b, importRev: 1, ...x });
  await assertDenied(setDoc(calPath(db(W), id), ev(W, null)), 'csv row without a batch');
  await assertDenied(setDoc(calPath(db(W), id), ev(W, 'btO101')), "someone else's batch");
  await assertDenied(setDoc(calPath(db(W), id), ev(W, 'btNONE1')), 'batch must exist');
  await assertDenied(setDoc(calPath(db(W), id), ev(W, 'btW101', { audience: 'private' })), 'audience must match the batch');
  await assertDenied(setDoc(calPath(db(W), id), ev(W, 'btW101', { importRev: 2 })), 'importRev starts at 1');
  await assertDenied(setDoc(calPath(db(W), 'evM101'), calDoc(W, { importBatchId: 'btW101' })), 'manual events carry no batch');
  await assertSucceeds(setDoc(calPath(db(W), id), ev(W, 'btW101')), 'imported row in its batch');
  await assertDenied(updateDoc(calPath(db(W), id), { importBatchId: 'btO101', rev: 2, updatedBy: W.uid, updatedAt: serverTimestamp() }), 'provenance immutable');
  await assertDenied(bu(OWNER_A, 'btW101', { status: 'active', createdCount: 1, rev: 2 }), "only the importer completes the batch");
  await assertSucceeds(bu(W, 'btW101', { status: 'active', createdCount: 1, rev: 2 }), 'importer completes the batch');
  await assertDenied(setDoc(calPath(db(W), 'csv_bbbbbbbbbbbbbbbb'), calDoc(W, { source: 'csv', sourceKey: 'bbbbbbbbbbbbbbbb', importBatchId: 'btW101', importRev: 1 })), 'closed batch takes no new rows');
  // Remove Import = status change (calendar.delete) + per-event soft deletes
  await assertDenied(bu(W, 'btW101', { status: 'removing', rev: 3 }), 'member lacks calendar.delete');
  await assertDenied(bu(ADMIN_A, 'btW101', { status: 'removing', createdCount: 9, rev: 3 }), 'created count frozen');
  await assertSucceeds(bu(ADMIN_A, 'btW101', { status: 'removing', rev: 3 }), 'admin starts removal');
  await assertSucceeds(updateDoc(calPath(db(ADMIN_A), id), { deletedAt: serverTimestamp(), deletedBy: ADMIN_A.uid, rev: 2, updatedBy: ADMIN_A.uid, updatedAt: serverTimestamp() }), 'event soft-deleted');
  await assertSucceeds(bu(ADMIN_A, 'btW101', { status: 'removed', removedCount: 1, keptCount: 0, rev: 4 }), 'removal finished');
  await assertDenied(bu(ADMIN_A, 'btW101', { status: 'removing', rev: 5 }), 'removed is final');
  await assertDenied(deleteDoc(batchPath(db(OWNER_A), 'btW101')), 'never hard-deleted');
  // deliberate re-import: restore the removed row into the owner's open batch (not a manual event; not a closed batch)
  const revive = (u, b, rev) => updateDoc(calPath(db(u), id), { deletedAt: null, deletedBy: null, importBatchId: b, importRev: rev, rev, done: false, updatedBy: u.uid, updatedAt: serverTimestamp() });
  await assertDenied(revive(OWNER_A, 'btW101', 3), 'restore needs an OPEN batch');
  await assertDenied(updateDoc(calPath(db(OWNER_A), id), { deletedAt: null, deletedBy: null, importBatchId: 'btO101', importRev: 2, rev: 3, updatedBy: OWNER_A.uid, updatedAt: serverTimestamp() }), 'importRev must equal rev');
  await assertSucceeds(revive(OWNER_A, 'btO101', 3), 'restored into the new batch');
  await assertSucceeds(setDoc(calPath(db(W), 'evM102'), calDoc(W)), 'manual event');
  await assertSucceeds(updateDoc(calPath(db(ADMIN_A), 'evM102'), { deletedAt: serverTimestamp(), deletedBy: ADMIN_A.uid, rev: 2, updatedBy: ADMIN_A.uid, updatedAt: serverTimestamp() }), 'manual soft delete');
  await assertDenied(updateDoc(calPath(db(ADMIN_A), 'evM102'), { deletedAt: null, deletedBy: null, importBatchId: 'btO101', importRev: 3, rev: 3, done: false, updatedBy: ADMIN_A.uid, updatedAt: serverTimestamp() }), 'a manual event is never resurrected by an import');
  // private batches: creator only
  await assertSucceeds(setDoc(batchPath(db(W), 'btP101'), batchDoc(W, { audience: 'private' })), 'private batch');
  await assertDenied(getDoc(batchPath(db(OWNER_A), 'btP101')), 'owner cannot read a private batch');
  await assertDenied(bu(OWNER_A, 'btP101', { status: 'removing', rev: 2 }), 'owner cannot remove a private batch');
  await assertDenied(getDocs(query(collection(db(OWNER_A), 'homes', 'hA', 'calendarImports'), where('createdBy', '==', W.uid))), 'no enumeration of her batches');
  await assertSucceeds(getDocs(query(collection(db(CHILD_A), 'homes', 'hA', 'calendarImports'), where('audience', '==', 'household'))), 'child lists household batches (calendar.view)');
  await assertDenied(getDoc(batchPath(db(OWNER_HOME_B), 'btW101')), 'cross-home');
  await assertDenied(getDoc(batchPath(db(MALLORY), 'btW101')), 'non-member');
});

test('V62-2 monthly budget: owner / admin only; exact shape; category keys bounded (no zakat); past months read-only; rev + 1; household read', async () => {
  await savingsHome();
  const now = new Date(); const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const cur = ym(now); const next = ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))); const old = ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)));
  const mPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'financeMonthly', id);
  const mDoc = (u, extra = {}) => ({ budgetMinor: 2000000, categoryLimits: { food: 50000 }, audience: 'household', readers: [], rev: 1, updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...extra });
  await assertDenied(setDoc(mPath(db(MEMBER_WIFE), cur), mDoc(MEMBER_WIFE)), 'member: not a budget manager');
  await assertDenied(setDoc(mPath(db(VIEWER_A), cur), mDoc(VIEWER_A)), 'viewer');
  for (const [x, why] of [[{ categoryLimits: { zakat: 1 } }, 'zakat never limited'], [{ budgetMinor: -1 }, 'non-negative'], [{ budgetMinor: 1.5 }, 'integer minor units'],
    [{ rev: 2 }, 'first rev is 1'], [{ updatedBy: ADMIN_A.uid }, 'forged editor'], [{ audience: 'restricted' }, 'household only'], [{ extra: 1 }, 'exact keys']])
    await assertDenied(setDoc(mPath(db(OWNER_A), cur), mDoc(OWNER_A, x)), why);
  await assertDenied(setDoc(mPath(db(OWNER_A), old), mDoc(OWNER_A)), 'past month read-only');
  await assertDenied(setDoc(mPath(db(OWNER_A), '2026-13'), mDoc(OWNER_A)), 'month id');
  await assertSucceeds(setDoc(mPath(db(OWNER_A), cur), mDoc(OWNER_A)), 'owner sets this month');
  await assertSucceeds(setDoc(mPath(db(ADMIN_A), next), mDoc(ADMIN_A, { budgetMinor: null, categoryLimits: {} })), 'admin sets next month (no overall budget)');
  await assertDenied(setDoc(mPath(db(ADMIN_A), cur), mDoc(ADMIN_A, { rev: 1 })), 'update must be rev + 1');
  await assertSucceeds(setDoc(mPath(db(ADMIN_A), cur), mDoc(ADMIN_A, { rev: 2, budgetMinor: 2500000 })), 'admin edits (rev 2)');
  await assertDenied(deleteDoc(mPath(db(OWNER_A), cur)), 'no delete');
  await assertSucceeds(getDoc(mPath(db(MEMBER_WIFE), cur)), 'household member reads');
  await assertDenied(getDoc(mPath(db(CHILD_A), cur)), 'child (no expenses.view)');
  await assertDenied(getDoc(mPath(db(OWNER_HOME_B), cur)), 'cross-home');
});

// ---------------------------------------------------------------------------------------------- V6.4 B: Shared Contacts
const cnPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'contacts', id);
const kcPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'contactCategories', id);
const cnDoc = (u, x = {}) => (asUser(u, 'cnDoc'), { name: 'Dr Ali', organization: null, email: null, address: null, notes: null, favorite: false,
  phones: ['mobile|+20 100 555 6666'], categoryIds: [], source: 'manual', deleted: false, deletedAt: null, deletedBy: null, rev: 1,
  createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...x });
const kcDoc = (u, x = {}) => (asUser(u, 'kcDoc'), { name: 'Plumbers', key: null, order: 0, rev: 1, createdBy: u.uid, createdAt: serverTimestamp(), updatedBy: u.uid, updatedAt: serverTimestamp(), schemaVersion: 1, ...x });
const cnUp = (u, id, x) => updateDoc(cnPath(db(u), id), { ...x, updatedBy: u.uid, updatedAt: serverTimestamp() });
async function contactsHome() { await family(); await seedMember('hA', MEMBER_WIFE, 'member'); await seedMember('hA', CHILD_A, 'child'); }

test('V64B-1 contacts: read = contacts.view for every household role; unauthenticated, non-member, other Home, suspended denied', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'ct0001'), cnDoc(OWNER_A)), 'owner creates');
  for (const u of [OWNER_A, ADMIN_A, MEMBER_WIFE, VIEWER_A, CHILD_A]) {
    await assertSucceeds(getDoc(cnPath(db(u), 'ct0001')), `${u.uid} reads`);
    await assertSucceeds(getDocs(query(collection(db(u), 'homes', 'hA', 'contacts'), where('deleted', '==', false))), `${u.uid} lists`);
  }
  await assertDenied(getDoc(cnPath(anon(), 'ct0001')), 'unauthenticated');
  await assertDenied(getDoc(cnPath(db(MALLORY), 'ct0001')), 'non-member');
  await assertDenied(getDoc(cnPath(db(OWNER_HOME_B), 'ct0001')), 'owner of another Home');
  await assertDenied(getDocs(collection(db(OWNER_HOME_B), 'homes', 'hA', 'contacts')), 'cross-home list');
  await assertDenied(setDoc(cnPath(db(OWNER_HOME_B), 'ct0002'), cnDoc(OWNER_HOME_B)), 'cross-home create');
  await assertDenied(getDoc(kcPath(db(MALLORY), 's_doctors')), 'non-member categories');
  await assertDenied(getDocs(collection(db(MALLORY), 'contacts')), 'no root contacts collection');
  await seedMember('hA', MEMBER_OTHER, 'member', 'suspended');
  await assertDenied(getDoc(cnPath(db(MEMBER_OTHER), 'ct0001')), 'suspended member');
});

test('V64B-2 contacts: create / import permissions — member creates & imports; viewer and child cannot; source decides the permission', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'ct0001'), cnDoc(MEMBER_WIFE)), 'member manual add');
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'vc_0123456789abcdef'), cnDoc(MEMBER_WIFE, { source: 'vcf' })), 'member import');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_0123456789abcdef'), cnDoc(MEMBER_WIFE, { source: 'vcf', name: 'Other' })), 'existing id: an import never overwrites (create-only)');
  for (const u of [VIEWER_A, CHILD_A]) {
    await assertDenied(setDoc(cnPath(db(u), `ct${u.uid}`), cnDoc(u)), `${u.uid} manual add`);
    await assertDenied(setDoc(cnPath(db(u), `vc_${u.uid}`), cnDoc(u, { source: 'vcf' })), `${u.uid} import`);
  }
  await assertDenied(setDoc(cnPath(db(OWNER_A), 'ct0003'), cnDoc(OWNER_A, { source: 'sync' })), 'unknown source');
  await assertSucceeds(setDoc(cnPath(db(ADMIN_A), 'ct0004'), cnDoc(ADMIN_A)), 'admin');
});

test('V64B-3 contacts: strict shape — exact keys, bounded strings, phone "label|number" format, email, categories, audit fields', async () => {
  await contactsHome();
  const O = OWNER_A; const bad = [
    [{ extra: 1 }, 'unknown key'], [{ name: '' }, 'empty name'], [{ name: 'x'.repeat(121) }, 'name > 120'], [{ name: 5 }, 'name type'],
    [{ notes: 'x'.repeat(1001) }, 'notes > 1000'], [{ organization: 'x'.repeat(121) }, 'org > 120'], [{ address: 'x'.repeat(301) }, 'address > 300'],
    [{ email: 'not-an-email' }, 'email'], [{ email: 'a@b.c'.padStart(300, 'a') }, 'email > 254'],
    [{ phones: ['+20 100 555 6666'] }, 'phone without label'], [{ phones: ['mobile|<script>'] }, 'phone number chars'], [{ phones: ['mob|ile|0100'] }, 'pipe in label'],
    [{ phones: ['mobile|javascript:alert(1)'] }, 'URI as number'], [{ phones: ['mobile|' + '1'.repeat(41)] }, 'number > 40'], [{ phones: ['x'.repeat(31) + '|0100'] }, 'label > 30'],
    [{ phones: Array.from({ length: 11 }, () => 'mobile|0100') }, '> 10 phones'], [{ phones: 'mobile|0100' }, 'phones type'],
    [{ categoryIds: ['s_doctors', 's_doctors'] }, 'duplicate category'], [{ categoryIds: ['bad id!'] }, 'category id format'], [{ categoryIds: Array.from({ length: 11 }, (_, i) => `cat00${i}`) }, '> 10 categories'],
    [{ favorite: 'yes' }, 'favorite type'], [{ deleted: true }, 'created deleted'], [{ rev: 2 }, 'rev starts at 1'], [{ createdBy: ADMIN_A.uid }, 'forged author'],
    [{ updatedBy: ADMIN_A.uid }, 'forged editor'], [{ createdAt: new Date() }, 'client timestamp'], [{ schemaVersion: 2 }, 'schema version'],
  ];
  for (const [x, why] of bad) await assertDenied(setDoc(cnPath(db(O), 'ct0009'), cnDoc(O, x)), why);
  await assertDenied(setDoc(cnPath(db(O), 'ab'), cnDoc(O)), 'id too short');
  await assertSucceeds(setDoc(cnPath(db(O), 'ct0009'), cnDoc(O, { name: 'أحمد محمود 😀', organization: 'عيادة', email: 'x@y.eg', address: 'شارع النيل', notes: 'سطر\nسطر',
    phones: ['mobile|+20 100 555 6666', 'Clinic desk|(02) 555-1234', 'whatsapp|0100#2'], categoryIds: ['s_doctors', 'cust_01'], favorite: true })), 'full Unicode contact');
});

test('V64B-4 contacts: edits — contacts.edit, rev + 1 (stale refused), immutable provenance; favourite is shared (edit permission)', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'ct0001'), cnDoc(OWNER_A)));
  await assertSucceeds(cnUp(MEMBER_WIFE, 'ct0001', { name: 'Dr Ali H', rev: 2 }), 'member edits');
  await assertDenied(cnUp(ADMIN_A, 'ct0001', { name: 'Stale', rev: 2 }), 'stale revision refused');
  await assertDenied(cnUp(ADMIN_A, 'ct0001', { name: 'Skip', rev: 4 }), 'revision skip refused');
  await assertDenied(cnUp(VIEWER_A, 'ct0001', { favorite: true, rev: 3 }), 'viewer cannot favourite');
  await assertDenied(cnUp(CHILD_A, 'ct0001', { name: 'x', rev: 3 }), 'child cannot edit');
  await assertSucceeds(cnUp(MEMBER_WIFE, 'ct0001', { favorite: true, rev: 3 }), 'member favourites (shared)');
  for (const [x, why] of [[{ createdBy: MEMBER_WIFE.uid }, 'createdBy'], [{ source: 'vcf' }, 'source'], [{ schemaVersion: 2 }, 'schemaVersion'], [{ createdAt: serverTimestamp() }, 'createdAt'], [{ phones: ['bad'] }, 'invalid content'], [{ extra: 1 }, 'new key']])
    await assertDenied(cnUp(OWNER_A, 'ct0001', { ...x, rev: 4 }), `immutable / validated: ${why}`);
  await assertDenied(updateDoc(cnPath(db(MEMBER_WIFE), 'ct0001'), { name: 'x', rev: 4, updatedBy: OWNER_A.uid, updatedAt: serverTimestamp() }), 'forged editor');
  await assertDenied(cnUp(OWNER_HOME_B, 'ct0001', { name: 'x', rev: 4 }), 'cross-home edit');
});

test('V64B-5 contacts: soft delete / restore = contacts.delete only (admin); deleted contacts are read-only; no hard delete for anyone', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'ct0001'), cnDoc(OWNER_A)));
  const del = (u, rev, x = {}) => cnUp(u, 'ct0001', { deleted: true, deletedAt: serverTimestamp(), deletedBy: u.uid, rev, ...x });
  await assertDenied(del(MEMBER_WIFE, 2), 'member lacks contacts.delete');
  await assertDenied(del(VIEWER_A, 2), 'viewer');
  await assertDenied(del(ADMIN_A, 2, { name: 'also renamed' }), 'delete changes only delete fields');
  await assertDenied(del(ADMIN_A, 2, { deletedBy: OWNER_A.uid }), 'forged deleter');
  await assertSucceeds(del(ADMIN_A, 2), 'admin soft-deletes');
  await assertDenied(cnUp(OWNER_A, 'ct0001', { name: 'edit while deleted', rev: 3 }), 'deleted is read-only');
  await assertSucceeds(getDocs(query(collection(db(ADMIN_A), 'homes', 'hA', 'contacts'), where('deleted', '==', true))), 'recently deleted list');
  await assertDenied(cnUp(MEMBER_WIFE, 'ct0001', { deleted: false, deletedAt: null, deletedBy: null, rev: 3 }), 'member cannot restore');
  await assertSucceeds(cnUp(OWNER_A, 'ct0001', { deleted: false, deletedAt: null, deletedBy: null, rev: 3 }), 'owner restores');
  for (const u of [OWNER_A, ADMIN_A, MEMBER_WIFE]) await assertDenied(deleteDoc(cnPath(db(u), 'ct0001')), `${u.uid}: no hard delete`);
});

test('V64B-6 contact categories: contacts.manageCategories (owner/admin); suggested key ↔ id; bounded; rev + 1; delete leaves contacts intact', async () => {
  await contactsHome();
  await assertDenied(setDoc(kcPath(db(MEMBER_WIFE), 'cust01'), kcDoc(MEMBER_WIFE)), 'member cannot manage categories');
  await assertDenied(setDoc(kcPath(db(VIEWER_A), 'cust01'), kcDoc(VIEWER_A)), 'viewer');
  await assertSucceeds(setDoc(kcPath(db(ADMIN_A), 's_doctors'), kcDoc(ADMIN_A, { name: null, key: 'doctors' })), 'suggested');
  await assertDenied(setDoc(kcPath(db(ADMIN_A), 's_plumbers'), kcDoc(ADMIN_A, { name: null, key: 'doctors' })), 'id must match the key');
  await assertDenied(setDoc(kcPath(db(ADMIN_A), 's_hackers'), kcDoc(ADMIN_A, { name: null, key: 'hackers' })), 'unknown suggestion key');
  await assertDenied(setDoc(kcPath(db(ADMIN_A), 'cust02'), kcDoc(ADMIN_A, { name: null })), 'custom needs a name');
  for (const [x, why] of [[{ name: 'x'.repeat(41) }, 'name > 40'], [{ order: 1000 }, 'order bound'], [{ order: -1 }, 'order ≥ 0'], [{ rev: 2 }, 'rev 1'], [{ extra: 1 }, 'exact keys'], [{ createdBy: OWNER_A.uid }, 'forged author']])
    await assertDenied(setDoc(kcPath(db(ADMIN_A), 'cust03'), kcDoc(ADMIN_A, x)), why);
  await assertSucceeds(setDoc(kcPath(db(ADMIN_A), 'cust01'), kcDoc(ADMIN_A, { name: 'سباكين' })), 'custom Arabic name');
  await assertSucceeds(getDoc(kcPath(db(CHILD_A), 'cust01')), 'child reads categories');
  const kUp = (u, x) => updateDoc(kcPath(db(u), 'cust01'), { ...x, updatedBy: u.uid, updatedAt: serverTimestamp() });
  await assertDenied(kUp(ADMIN_A, { name: 'Plumbers', rev: 3 }), 'rev + 1');
  await assertDenied(kUp(ADMIN_A, { key: 'doctors', rev: 2 }), 'key immutable');
  await assertDenied(kUp(MEMBER_WIFE, { name: 'Plumbers', rev: 2 }), 'member rename');
  await assertSucceeds(kUp(ADMIN_A, { name: 'Plumbers', rev: 2 }), 'admin rename');
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'ct0001'), cnDoc(OWNER_A, { categoryIds: ['cust01'] })));
  await assertDenied(deleteDoc(kcPath(db(MEMBER_WIFE), 'cust01')), 'member delete');
  await assertDenied(deleteDoc(kcPath(db(OWNER_HOME_B), 'cust01')), 'cross-home delete');
  await assertSucceeds(deleteDoc(kcPath(db(ADMIN_A), 'cust01')), 'admin delete');
  await assertSucceeds(getDoc(cnPath(db(OWNER_A), 'ct0001')), 'contact still there');
});

test('V64B-7 contacts: role template v9 refresh accepted; existing pre-v9 member keeps create/edit; owner "*" covers everything', async () => {
  await contactsHome();
  const roles = defaultRoles(); const member = roles.find((r) => r.id === 'member');
  await assertSucceeds(updateDoc(doc(db(OWNER_A), 'homes', 'hA', 'roles', 'member'), { permissions: member.permissions, templateVersion: 9, updatedAt: serverTimestamp() }), 'owner applies template v9');
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'vc_aaaaaaaaaaaaaaaa'), cnDoc(MEMBER_WIFE, { source: 'vcf' })), 'member imports after refresh');
});

test('V64B-8 (rev 2) deleted contacts: only contacts.delete holders read them — direct gets, queries, custom roles, cross-household', async () => {
  await contactsHome();
  const CUSTOM_DEL = { uid: 'custDel', email: 'cd@a.test' }; const CUSTOM_VIEW = { uid: 'custView', email: 'cv@a.test' };
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'homes', 'hA', 'roles', 'archivist'), { name: 'Archivist', rank: 30, permissions: ['contacts.view', 'contacts.delete'], system: false, createdAt: new Date(), updatedAt: new Date() });
    await setDoc(doc(f, 'homes', 'hA', 'roles', 'reader'), { name: 'Reader', rank: 20, permissions: ['contacts.view', 'contacts.create', 'contacts.edit', 'contacts.import'], system: false, createdAt: new Date(), updatedAt: new Date() });
  });
  await seedMember('hA', CUSTOM_DEL, 'archivist'); await seedMember('hA', CUSTOM_VIEW, 'reader');
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'live01'), cnDoc(OWNER_A)));
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'gone01'), cnDoc(OWNER_A, { name: 'Old driver' })));
  await assertSucceeds(cnUp(ADMIN_A, 'gone01', { deleted: true, deletedAt: serverTimestamp(), deletedBy: ADMIN_A.uid, rev: 2 }), 'admin soft-deletes');
  const col = (u) => collection(db(u), 'homes', 'hA', 'contacts');
  const activeQ = (u) => getDocs(query(col(u), where('deleted', '==', false)));
  const deletedQ = (u) => getDocs(query(col(u), where('deleted', '==', true)));
  // holders of contacts.delete (owner '*', admin, custom role with delete)
  for (const u of [OWNER_A, ADMIN_A, CUSTOM_DEL]) {
    await assertSucceeds(getDoc(cnPath(db(u), 'gone01')), `${u.uid}: direct get of a deleted contact`);
    await assertSucceeds(deletedQ(u), `${u.uid}: Recently deleted query`);
    await assertSucceeds(getDocs(col(u)), `${u.uid}: unconstrained list`);
  }
  // contacts.view WITHOUT contacts.delete (member, viewer, child, custom role)
  for (const u of [MEMBER_WIFE, VIEWER_A, CHILD_A, CUSTOM_VIEW]) {
    await assertDenied(getDoc(cnPath(db(u), 'gone01')), `${u.uid}: direct get of a deleted contact`);
    await assertDenied(deletedQ(u), `${u.uid}: deleted == true query`);
    await assertDenied(getDocs(col(u)), `${u.uid}: unconstrained list (would include deleted)`);
    await assertDenied(getDocs(query(col(u), where('name', '==', 'Old driver'))), `${u.uid}: query by another field`);
    await assertSucceeds(activeQ(u), `${u.uid}: active-contact listener query`);
    await assertSucceeds(getDoc(cnPath(db(u), 'live01')), `${u.uid}: direct get of a live contact`);
    await assertSucceeds(getDoc(cnPath(db(u), 'neverWritten1')), `${u.uid}: get of a missing id (reveals nothing)`);
  }
  // restore stays a contacts.delete action; once restored everybody reads it again
  await assertDenied(cnUp(CUSTOM_VIEW, 'gone01', { deleted: false, deletedAt: null, deletedBy: null, rev: 3 }), 'custom role without delete cannot restore');
  await assertSucceeds(cnUp(CUSTOM_DEL, 'gone01', { deleted: false, deletedAt: null, deletedBy: null, rev: 3 }), 'custom role with delete restores');
  await assertSucceeds(getDoc(cnPath(db(VIEWER_A), 'gone01')), 'restored → visible to viewers');
  // cross-household: even the owner of Home B, and nobody outside
  await assertSucceeds(cnUp(OWNER_A, 'gone01', { deleted: true, deletedAt: serverTimestamp(), deletedBy: OWNER_A.uid, rev: 4 }));
  await assertDenied(getDoc(cnPath(db(OWNER_HOME_B), 'gone01')), 'owner of another Home: deleted contact');
  await assertDenied(getDocs(query(collection(db(OWNER_HOME_B), 'homes', 'hA', 'contacts'), where('deleted', '==', true))), 'owner of another Home: deleted query');
  await assertDenied(getDocs(query(collection(db(OWNER_HOME_B), 'homes', 'hA', 'contacts'), where('deleted', '==', false))), 'owner of another Home: active query');
  await assertDenied(getDoc(cnPath(anon(), 'gone01')), 'unauthenticated');
  await assertDenied(getDoc(cnPath(db(MALLORY), 'live01')), 'non-member');
  // a member's re-import onto a deleted contact's id is refused (create-only) and does not reveal it
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'gone01'), cnDoc(MEMBER_WIFE, { source: 'vcf' })), 'no resurrection by create');
});

// ---------------------------------------------------------------------------------------------- V6.4 C: contact media
const AV = 'https://cdn.example.com/logo.png';
const MN = (kind, label, url) => `${kind}|${label}|${url}`;
const MENUS = [MN('image', 'Page 1', 'https://cdn.example.com/m1.jpg'), MN('pdf', 'قائمة', 'https://a.example/menu.pdf'), MN('web', '', 'https://a.example/'),
  MN('drive', 'Drive', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view')];
const dataOf = async (u, id) => (await getDoc(cnPath(db(u), id))).data();

test('V64C-1 contact media create: optional https picture + ≤ 10 menus; .vcf creates never carry media; every malformed value refused', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'rest01'), cnDoc(MEMBER_WIFE, { categoryIds: ['s_restaurants'], avatarUrl: AV, menus: MENUS })), 'member: picture + 4 menus');
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'old001'), cnDoc(MEMBER_WIFE)), 'older-client shape (no media keys) still accepted');
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'nul001'), cnDoc(MEMBER_WIFE, { avatarUrl: null, menus: [] })), 'explicit empty media');
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'ten001'), cnDoc(MEMBER_WIFE, { menus: Array.from({ length: 10 }, (_, i) => MN('image', 'x'.repeat(40), `https://a.example/${'p'.repeat(470)}${i}`)) })), '10 menus at the label / url limits');
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'url500'), cnDoc(MEMBER_WIFE, { avatarUrl: `https://a.example/${'x'.repeat(482)}` })), '500-character picture URL');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_media01'), cnDoc(MEMBER_WIFE, { source: 'vcf', avatarUrl: AV })), '.vcf create with a picture');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_media02'), cnDoc(MEMBER_WIFE, { source: 'vcf', menus: [] })), '.vcf create with a menus key');
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'vc_media03'), cnDoc(MEMBER_WIFE, { source: 'vcf' })), '.vcf create without media');
  const badAvatar = ['http://cdn.example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://user:pw@cdn.example.com/a.png', 'https://a.example@evil.example/',
    'https://127.0.0.1/a.png', 'https://192.168.1.1/', 'https://localhost/a.png', 'https://[::1]/a.png', 'https://CDN.example.com/a.png', 'https://a.example/a b.png',
    'https://a.example/"><img src=x onerror=alert(1)>', 'https://a.example/a|b', `https://a.example/${'x'.repeat(483)}`, '', 42, ['https://a.example/'], { url: AV }];
  for (const v of badAvatar) await assertDenied(setDoc(cnPath(db(OWNER_A), 'bad001'), cnDoc(OWNER_A, { avatarUrl: v })), `avatarUrl ${JSON.stringify(v).slice(0, 60)}`);
  const badMenus = [Array.from({ length: 11 }, () => MENUS[0]), [MN('image', 'x'.repeat(41), 'https://a.example/a.jpg')], [MN('exe', '', 'https://a.example/a')],
    [MN('image', '', 'http://a.example/a.jpg')], [MN('image', '', 'javascript:alert(1)')], ['image|https://a.example/a.jpg'], [MN('image', '', 'https://a.example/a|b')],
    [MN('image', '', `https://a.example/${'x'.repeat(483)}`)], [MN('image', 'a\nb', 'https://a.example/a.jpg')], [{ kind: 'image', label: '', url: 'https://a.example/a.jpg' }],
    [7], 'image||https://a.example/a.jpg', { 0: MENUS[0] }];
  for (const v of badMenus) await assertDenied(setDoc(cnPath(db(OWNER_A), 'bad002'), cnDoc(OWNER_A, { menus: v })), `menus ${JSON.stringify(v).slice(0, 60)}`);
  await assertDenied(setDoc(cnPath(db(OWNER_A), 'bad003'), cnDoc(OWNER_A, { avatar: AV })), 'unknown key');
  await assertDenied(setDoc(cnPath(db(OWNER_A), 'bad004'), cnDoc(OWNER_A, { photoData: 'iVBORw0KGgo=' })), 'no binary / base64 field');
  for (const u of [VIEWER_A, CHILD_A]) await assertDenied(setDoc(cnPath(db(u), `m${u.uid}`), cnDoc(u, { avatarUrl: AV })), `${u.uid} cannot create`);
});

test('V64C-2 contact media edits: contacts.edit + rev + 1 (stale refused); malicious direct writes refused; deleted contacts read-only', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'rest01'), cnDoc(OWNER_A, { categoryIds: ['s_restaurants'], avatarUrl: AV, menus: MENUS })));
  await assertSucceeds(cnUp(MEMBER_WIFE, 'rest01', { menus: [MENUS[1], MENUS[0]], rev: 2 }), 'member reorders menus');
  await assertDenied(cnUp(ADMIN_A, 'rest01', { avatarUrl: null, rev: 2 }), 'stale revision (second device)');
  await assertSucceeds(cnUp(ADMIN_A, 'rest01', { avatarUrl: null, rev: 3 }), 'remove picture');
  await assertSucceeds(cnUp(ADMIN_A, 'rest01', { avatarUrl: 'https://cdn.example.com/new.png', rev: 4 }), 'replace picture');
  await assertSucceeds(cnUp(ADMIN_A, 'rest01', { menus: [], rev: 5 }), 'remove all menus');
  for (const u of [VIEWER_A, CHILD_A]) await assertDenied(cnUp(u, 'rest01', { avatarUrl: AV, rev: 6 }), `${u.uid} cannot change the picture`);
  await assertDenied(cnUp(VIEWER_A, 'rest01', { menus: MENUS, rev: 6 }), 'viewer cannot change menus');
  for (const [x, why] of [[{ avatarUrl: 'javascript:alert(1)' }, 'executable scheme'], [{ avatarUrl: 'https://u:p@a.example/' }, 'credentials'], [{ menus: ['image||http://a.example/x.jpg'] }, 'http menu'],
    [{ menus: Array.from({ length: 11 }, () => MENUS[0]) }, '11 menus'], [{ avatarUrl: `https://a.example/${'x'.repeat(483)}` }, 'oversized'], [{ photo: 'AAAA' }, 'unknown key']])
    await assertDenied(cnUp(MEMBER_WIFE, 'rest01', { ...x, rev: 6 }), `malicious direct write: ${why}`);
  await assertDenied(updateDoc(cnPath(db(MEMBER_WIFE), 'rest01'), { avatarUrl: AV, rev: 6, updatedBy: OWNER_A.uid, updatedAt: serverTimestamp() }), 'forged editor');
  await assertDenied(cnUp(ADMIN_A, 'rest01', { deleted: true, deletedAt: serverTimestamp(), deletedBy: ADMIN_A.uid, avatarUrl: AV, rev: 6 }), 'delete path cannot change media');
  await assertSucceeds(cnUp(ADMIN_A, 'rest01', { deleted: true, deletedAt: serverTimestamp(), deletedBy: ADMIN_A.uid, rev: 6 }));
  await assertDenied(cnUp(OWNER_A, 'rest01', { avatarUrl: AV, rev: 7 }), 'a deleted contact is read-only');
});

test('V64C-3 compatibility: an OLDER client (6.4.0-b field patches, delete / restore) never erases media; media survives every other write', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'rest01'), cnDoc(OWNER_A, { categoryIds: ['s_restaurants'], avatarUrl: AV, menus: MENUS })));
  // the exact writes a 6.4.0-b client makes: content field patches, favourite, category change, delete, restore
  await assertSucceeds(cnUp(MEMBER_WIFE, 'rest01', { name: 'Pizza Place', organization: 'Pizza Co', rev: 2 }));
  await assertSucceeds(cnUp(MEMBER_WIFE, 'rest01', { favorite: true, rev: 3 }));
  await assertSucceeds(cnUp(MEMBER_WIFE, 'rest01', { categoryIds: [], rev: 4 }), 'Restaurants un-assigned (menus hidden, kept)');
  await assertSucceeds(cnUp(ADMIN_A, 'rest01', { deleted: true, deletedAt: serverTimestamp(), deletedBy: ADMIN_A.uid, rev: 5 }));
  await assertSucceeds(cnUp(ADMIN_A, 'rest01', { deleted: false, deletedAt: null, deletedBy: null, rev: 6 }));
  await assertSucceeds(cnUp(MEMBER_WIFE, 'rest01', { categoryIds: ['s_restaurants'], rev: 7 }), 'reassigned');
  const d = await dataOf(OWNER_A, 'rest01');
  assert.deepEqual([d.avatarUrl, d.menus, d.rev, d.organization], [AV, MENUS, 7, 'Pizza Co'], 'media untouched by all older-client writes');
  // an older client re-importing a vCard onto the same id is create-only → refused, nothing overwritten
  // (a denied write is atomic: nothing of it is applied)
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'rest01'), cnDoc(MEMBER_WIFE, { source: 'vcf' })), 'set over an existing contact');
});

test('V64C-4 contact media tenant isolation: other Homes / outsiders can neither read nor write pictures and menus', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'rest01'), cnDoc(OWNER_A, { avatarUrl: AV, menus: MENUS })));
  await assertDenied(getDoc(cnPath(db(OWNER_HOME_B), 'rest01')), 'owner of another Home reads');
  await assertDenied(cnUp(OWNER_HOME_B, 'rest01', { avatarUrl: 'https://evil.example/x.png', rev: 2 }), 'owner of another Home replaces the picture');
  await assertDenied(cnUp(OWNER_HOME_B, 'rest01', { menus: [], rev: 2 }), 'owner of another Home erases menus');
  await assertDenied(setDoc(cnPath(db(OWNER_HOME_B), 'evil01'), cnDoc(OWNER_HOME_B, { avatarUrl: 'https://evil.example/t.png' })), 'plants a contact');
  await assertDenied(getDoc(cnPath(db(MALLORY), 'rest01')), 'non-member'); await assertDenied(getDoc(cnPath(anon(), 'rest01')), 'unauthenticated');
  await assertDenied(cnUp(MALLORY, 'rest01', { avatarUrl: null, rev: 2 }), 'non-member edit');
});

test('V64C-5 (rev 2) menus: EVERY element validated on its own — combined, split, shifted, smuggled and empty elements refused (create AND update)', async () => {
  await contactsHome();
  const ok = 'https://a.example/1.jpg'; const ok2 = 'https://b.example/menu.pdf';
  const bad = {
    'two entries combined in one element': [MN('image', 'a', ok) + '|' + MN('pdf', 'b', ok2)],
    'one entry split across two elements': ['image', 'a|' + ok],
    'one entry split three ways': ['image', 'a', ok],
    'kind|label then url': ['image|a', ok],
    '11 entries smuggled into 6 elements': [...Array.from({ length: 5 }, () => MN('image', '', ok) + '|' + MN('image', '', ok)), MN('image', '', ok)],
    'trailing separator': [MN('image', 'a', ok) + '|'], 'leading separator': ['|' + MN('image', 'a', ok)], 'extra field': [MN('image', 'a', ok) + '|x'],
    'pipe in label': ['image|a|b|' + ok], 'empty element': [''], 'empty after valid': [MN('image', 'a', ok), ''], 'separators only': ['||'], 'kind only': ['image||'],
    'null element': [MN('image', 'a', ok), null], 'map element': [{ kind: 'image', label: '', url: ok }], 'number element': [7],
    'local host in 2nd element': [MN('image', 'a', ok), MN('web', 'r', 'https://router.local/')], 'wildcard-DNS host': [MN('image', 'a', 'https://10.0.0.1.nip.io/x.jpg')],
    'localhost subdomain': [MN('web', '', 'https://admin.localhost/')], 'home.arpa': [MN('web', '', 'https://nas.home.arpa/')],
  };
  for (const [why, menus] of Object.entries(bad)) await assertDenied(setDoc(cnPath(db(OWNER_A), 'adv001'), cnDoc(OWNER_A, { menus })), `create: ${why}`);
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'adv002'), cnDoc(OWNER_A, { menus: [MN('image', 'https://router.local', ok)] })), 'a label that only LOOKS like a local URL is text');
  await assertSucceeds(setDoc(cnPath(db(OWNER_A), 'adv003'), cnDoc(OWNER_A, { menus: Array.from({ length: 10 }, (_, i) => MN('image', (i % 2 ? 'ق' : '😀').repeat(40), `https://a.example/${'p'.repeat(481)}${i}`)) })), '10 entries at every limit');
  let rev = 1;
  for (const [why, menus] of Object.entries(bad)) await assertDenied(cnUp(MEMBER_WIFE, 'adv002', { menus, rev: rev + 1 }), `update: ${why}`);
  await assertSucceeds(cnUp(MEMBER_WIFE, 'adv002', { menus: [MN('pdf', 'Full', ok2), MN('image', 'p1', ok)], rev: ++rev }), 'valid update still works');
});

test('V64C-6 (rev 2) picture URL: local-network suffixes and wildcard-DNS hosts refused; look-alike public names accepted', async () => {
  await contactsHome();
  for (const u of ['https://foo.localhost/a.png', 'https://printer.local/a.png', 'https://nas.home.arpa/a.png', 'https://router.home/a.png', 'https://db.internal/a.png',
    'https://srv.lan/a.png', 'https://app.corp/a.png', 'https://x.private/a.png', 'https://a.localdomain/a.png', 'https://wiki.intranet/a.png',
    'https://192.168.1.1.nip.io/a.png', 'https://127-0-0-1.sslip.io/a.png', 'https://10.0.0.1.xip.io/a.png', 'https://localtest.me/a.png', 'https://x.lvh.me/a.png', 'https://printer.local:8443/a.png'])
    await assertDenied(setDoc(cnPath(db(OWNER_A), 'host01'), cnDoc(OWNER_A, { avatarUrl: u })), u);
  for (const [i, u] of ['https://localhost.example/a.png', 'https://myhome.example/a.png', 'https://local.example.com/a.png', 'https://cdn.example.com/home/a.png'].entries())
    await assertSucceeds(setDoc(cnPath(db(OWNER_A), `host1${i}`), cnDoc(OWNER_A, { avatarUrl: u })), u);
});

test('V641A-1 AI JSON import (source "json"): contacts.import required; validated media allowed (unlike .vcf); every media check still applies; viewer / child / outsider refused', async () => {
  await contactsHome();
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'vc_json000000001'), cnDoc(MEMBER_WIFE, { source: 'json' })), 'member: JSON import without media');
  await assertSucceeds(setDoc(cnPath(db(MEMBER_WIFE), 'vc_json000000002'), cnDoc(MEMBER_WIFE, { source: 'json', categoryIds: ['s_restaurants'], avatarUrl: AV, menus: MENUS })), 'member: JSON import with picture + menus');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_json000000002'), cnDoc(MEMBER_WIFE, { source: 'json', name: 'Other' })), 'existing id: never overwritten (create-only)');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_json000000003'), cnDoc(MEMBER_WIFE, { source: 'json', avatarUrl: 'http://cdn.example.com/a.png' })), 'http picture refused');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_json000000004'), cnDoc(MEMBER_WIFE, { source: 'json', avatarUrl: 'https://printer.local/a.png' })), 'local-network picture refused');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_json000000005'), cnDoc(MEMBER_WIFE, { source: 'json', menus: ['image|https://a.example/a.jpg'] })), 'malformed menu element refused');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_json000000006'), cnDoc(MEMBER_WIFE, { source: 'vcf', avatarUrl: AV })), '.vcf still never carries media');
  await assertDenied(setDoc(cnPath(db(MEMBER_WIFE), 'vc_json000000007'), cnDoc(MEMBER_WIFE, { source: 'JSON' })), 'source enum is exact');
  for (const u of [VIEWER_A, CHILD_A, MALLORY]) await assertDenied(setDoc(cnPath(db(u), `vc_json_${u.uid}`.slice(0, 40)), cnDoc(u, { source: 'json' })), `${u.uid} JSON import`);
  await assertDenied(cnUp(MEMBER_WIFE, 'vc_json000000001', { source: 'manual', rev: 2 }), 'source is immutable after create');
});

test('V641B-1 calendar contact activities / reminders: optional fields validated; older shapes still valid; private activity = creator only; CSV / revive untouched', async () => {
  await savingsHome();
  const W = MEMBER_WIFE; const up = (u, id, data) => updateDoc(calPath(db(u), id), { ...data, updatedBy: u.uid, updatedAt: serverTimestamp() });
  const act = (u, x = {}) => calDoc(u, { title: 'Call the plumber', type: 'other', kind: 'contactActivity', contactId: 'plumber01', status: 'planned', reminderMinutes: 15, ...x });
  await assertSucceeds(setDoc(calPath(db(W), 'evLegacyB'), calDoc(W)), 'an event WITHOUT the Stage B fields (older clients) is still valid');
  await assertSucceeds(setDoc(calPath(db(W), 'evRemB01'), calDoc(W, { reminderMinutes: 60 })), 'ordinary event with a reminder');
  await assertSucceeds(setDoc(calPath(db(W), 'evActB01'), act(W)), 'contact activity');
  await assertSucceeds(setDoc(calPath(db(W), 'evActB02'), act(W, { audience: 'private', reminderMinutes: null })), 'private activity');
  for (const [x, why] of [[{ reminderMinutes: 30 }, 'offset not in the list'], [{ reminderMinutes: '15' }, 'offset type'], [{ kind: 'meeting' }, 'unknown kind'],
    [{ contactId: null }, 'activity without a contact'], [{ contactId: '../x' }, 'contact id format'], [{ status: 'lost' }, 'unknown status'], [{ status: null }, 'activity without a status'],
    [{ kind: null }, 'contact link on an ordinary event'], [{ extra: 1 }, 'still no unknown keys']])
    await assertDenied(setDoc(calPath(db(W), 'evActBX1'), act(W, x)), why);
  await assertDenied(setDoc(calPath(db(W), 'evActBX2'), calDoc(W, { status: 'done' })), 'status only on activities');
  await assertSucceeds(up(W, 'evActB01', { status: 'done', rev: 2 }), 'mark done');
  await assertSucceeds(up(W, 'evActB01', { status: 'cancelled', reminderMinutes: 1440, rev: 3 }), 'cancel + reminder change');
  await assertDenied(up(W, 'evActB01', { status: 'archived', rev: 4 }), 'bad status on update');
  await assertDenied(up(W, 'evActB01', { contactId: null, rev: 4 }), 'cannot leave an activity without a contact');
  await assertSucceeds(up(W, 'evLegacyB', { reminderMinutes: 0, rev: 2 }), 'older event gains a reminder on edit');
  await assertSucceeds(up(W, 'evLegacyB', { title: 'Day Shift — Plant A', rev: 3 }), 'older-client edit (no Stage B keys) still valid');
  await assertDenied(getDoc(calPath(db(OWNER_A), 'evActB02')), 'private activity: even the owner cannot read it');
  await assertDenied(up(OWNER_A, 'evActB02', { status: 'done', rev: 2 }), 'nor change it');
  await assertDenied(setDoc(calPath(db(VIEWER_A), 'evActBV1'), act(VIEWER_A)), 'viewer cannot create activities');
  await assertDenied(up(VIEWER_A, 'evActB01', { status: 'planned', rev: 4 }), 'viewer cannot change status');
  await assertDenied(setDoc(calPath(db(OWNER_HOME_B), 'evActBB1', 'hA'), act(OWNER_HOME_B)), 'other Home denied');
});

test('V641B-2 reminder states for Calendar (e:) and commitments (m:): prefix ↔ kind binding; owner-only; prefs accept the older and the new shape', async () => {
  await genHome();
  const W = MEMBER_WIFE; const O = MEMBER_OTHER;
  const st = (u, key, sourceKind, x = {}) => ({ ...stDoc(u, key), sourceKind, ...x });
  await assertSucceeds(setDoc(rsPath(db(W), sid(W, 'e:ev1@2026-11-22')), st(W, 'e:ev1@2026-11-22', 'calendarEvent', { state: 'dismissed' })), 'calendar state');
  await assertSucceeds(setDoc(rsPath(db(W), sid(W, 'm:rent@2026-12-01')), st(W, 'm:rent@2026-12-01', 'commitment', { state: 'snoozed', snoozeUntil: isoIn(2) })), 'commitment snooze');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'e:ev2@2026-11-22')), st(W, 'e:ev2@2026-11-22', 'commitment')), 'e: is never a commitment');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'm:x@2026-11-22')), st(W, 'm:x@2026-11-22', 'calendarEvent')), 'm: is never a calendar event');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'c:y@2026-11-22')), st(W, 'c:y@2026-11-22', 'calendarEvent')), 'old prefixes keep their kinds');
  await assertDenied(setDoc(rsPath(db(W), sid(W, 'z:y')), st(W, 'z:y', 'calendarEvent')), 'unknown prefix');
  await assertDenied(getDoc(rsPath(db(O), sid(W, 'e:ev1@2026-11-22'))), 'another member cannot read it');
  await assertDenied(setDoc(rsPath(db(O), sid(W, 'e:ev1@2026-11-22')), st(O, 'e:ev1@2026-11-22', 'calendarEvent')), 'nor take it over');
  await assertSucceeds(setDoc(rpPath(db(W), W.uid), prefDoc()), 'older prefs shape (cached clients)');
  await assertSucceeds(setDoc(rpPath(db(W), W.uid), prefDoc({ calendar: false, commitments: true })), 'new shape');
  await assertDenied(setDoc(rpPath(db(W), W.uid), prefDoc({ calendar: 'no' })), 'toggle type');
  await assertDenied(setDoc(rpPath(db(W), W.uid), prefDoc({ contacts: true })), 'no other keys');
});

// =================================================================== V6.5 PHASE 01 — Pantry product catalog
import { createDoc as pnCreateDoc, validateProduct as pnValidate, archivePatch as pnArchive, restorePatch as pnRestore } from '../../src/modules/inventory/product-model.js';
const pnPath = (f, id, h = 'hA') => doc(f, 'homes', h, 'pantryProducts', id);
const pnDoc = (u, input = {}, x = {}) => ({ ...pnCreateDoc(pnValidate({ nameEn: 'Eggs', nameAr: 'بيض', category: 'dairy', location: 'fridge', trackMode: 'quantity',
  dimension: 'count', displayUnit: 'piece', minQty: '6', aliases: 'egg', ...input }).value, { uid: u.uid, now: serverTimestamp() }), ...x });
const pnUp = (u, id, data) => updateDoc(pnPath(db(u), id), { ...data, updatedBy: u.uid, updatedAt: serverTimestamp() });
async function pantryHome() { await family(); await seedMember('hA', MEMBER_WIFE, 'member'); await seedMember('hA', CHILD_A, 'child'); }

test('V65P01-1 pantry read: inventory.view (owner / admin / member / viewer); child, non-member, other Home, unauthenticated denied', async () => {
  await pantryHome();
  await assertSucceeds(setDoc(pnPath(db(OWNER_A), 'pnEggs01'), pnDoc(OWNER_A)), 'owner creates');
  for (const u of [OWNER_A, ADMIN_A, MEMBER_WIFE, VIEWER_A]) {
    await assertSucceeds(getDoc(pnPath(db(u), 'pnEggs01')), `${u.uid} reads`);
    await assertSucceeds(getDocs(query(collection(db(u), 'homes', 'hA', 'pantryProducts'), where('archived', '==', false))), `${u.uid} lists`);
  }
  await assertDenied(getDoc(pnPath(db(CHILD_A), 'pnEggs01')), 'child has no inventory.view by default');
  await assertDenied(getDoc(pnPath(anon(), 'pnEggs01')), 'unauthenticated');
  await assertDenied(getDoc(pnPath(db(MALLORY), 'pnEggs01')), 'non-member');
  await assertDenied(getDoc(pnPath(db(OWNER_HOME_B), 'pnEggs01')), 'owner of another Home');
  await assertDenied(getDocs(collection(db(OWNER_HOME_B), 'homes', 'hA', 'pantryProducts')), 'cross-home list');
});

test('V65P01-2 pantry create: inventory.create (owner / admin / member); viewer / child / outsider / other Home denied; strict shape; zero stock; no spoofing', async () => {
  await pantryHome();
  for (const [u, id] of [[OWNER_A, 'pnOwner1'], [ADMIN_A, 'pnAdmin1'], [MEMBER_WIFE, 'pnWife01']]) await assertSucceeds(setDoc(pnPath(db(u), id), pnDoc(u)), `${u.uid} creates`);
  await assertSucceeds(setDoc(pnPath(db(OWNER_A), 'pnRice01'), pnDoc(OWNER_A, { nameEn: '', nameAr: 'أرز', dimension: 'mass', displayUnit: 'kg', minQty: '1.5', aliases: '' })), 'Arabic-only name, mass');
  await assertSucceeds(setDoc(pnPath(db(OWNER_A), 'pnSoap01'), pnDoc(OWNER_A, { nameEn: 'Soap', nameAr: '', trackMode: 'presence', minQty: '' })), 'presence mode');
  for (const u of [VIEWER_A, CHILD_A, MALLORY]) await assertDenied(setDoc(pnPath(db(u), `pnX${u.uid}`.slice(0, 40)), pnDoc(u)), `${u.uid} cannot create`);
  await assertDenied(setDoc(pnPath(db(OWNER_HOME_B), 'pnCross1'), pnDoc(OWNER_HOME_B)), 'other Home owner into hA');
  const bad = [
    [{ stockMilli: 5000 }, 'non-zero initial stock'], [{ stockRev: 1 }, 'stockRev must start at 0'], [{ presence: 'in' }, 'presence must start unrecorded'],
    [{ rev: 2 }, 'rev must be 1'], [{ archived: true }, 'cannot create archived'], [{ createdBy: 'adminA' }, 'createdBy spoof'], [{ updatedBy: 'adminA' }, 'updatedBy spoof'],
    [{ createdAt: new Date('2020-01-01') }, 'client timestamp'], [{ schemaVersion: 2 }, 'schema version'], [{ price: 10 }, 'unknown key (price)'], [{ expenseId: 'e1' }, 'unknown key'],
    [{ nameEn: null, nameAr: null }, 'no name'], [{ nameEn: 'x'.repeat(81) }, 'name too long'], [{ nameEn: '   ' }, 'blank name'], [{ category: 'weapons' }, 'category enum'],
    [{ location: 'roof' }, 'location enum'], [{ dimension: 'mass', displayUnit: 'piece' }, 'unit / dimension mismatch'], [{ displayUnit: 'cup' }, 'unknown unit'],
    [{ minMilli: 1500 }, 'fractional pieces threshold'], [{ minMilli: 0 }, 'zero threshold'], [{ minMilli: -1000 }, 'negative threshold'], [{ minMilli: 1000000000001000 }, 'threshold overflow'],
    [{ minMilli: 6.5 }, 'non-integer threshold'], [{ aliases: ['a', 'a'] }, 'duplicate aliases'], [{ aliases: ['a|b'] }, 'alias separator'], [{ aliases: Array.from({ length: 9 }, (_, i) => `a${i}`) }, 'too many aliases'],
    [{ aliases: ['x'.repeat(41)] }, 'alias too long'], [{ aliases: [5] }, 'alias type'], [{ note: 'x'.repeat(201) }, 'note too long'], [{ trackMode: 'weight' }, 'track mode enum'],
  ];
  for (const [x, why] of bad) {
    console.log('PANTRY_DENIAL_CHECK:', why);
    await assertDenied(setDoc(pnPath(db(OWNER_A), 'pnBad001'), pnDoc(OWNER_A, {}, x)), why);
  }
  await assertDenied(setDoc(pnPath(db(OWNER_A), 'pnBad002'), pnDoc(OWNER_A, { trackMode: 'presence' }, { stockMilli: 0 })), 'presence mode with numeric stock');
  await assertDenied(setDoc(pnPath(db(OWNER_A), 'pnBad003'), pnDoc(OWNER_A, { trackMode: 'presence' }, { dimension: 'count', displayUnit: 'piece' })), 'presence mode with a unit');
  await assertDenied(setDoc(pnPath(db(OWNER_A), 'pnBad004'), pnDoc(OWNER_A, {}, { stockMilli: null })), 'quantity mode with null stock');
  await assertDenied(setDoc(pnPath(db(OWNER_A), 'x'), pnDoc(OWNER_A)), 'id format');
});

test('V65P01-3 pantry update: metadata = inventory.edit with rev + 1; stock fields immutable; trackMode fixed; replay / stale refused; archive = inventory.delete; no delete', async () => {
  await pantryHome();
  await assertSucceeds(setDoc(pnPath(db(OWNER_A), 'pnEggs01'), pnDoc(OWNER_A)));
  await assertSucceeds(pnUp(MEMBER_WIFE, 'pnEggs01', { nameEn: 'Free-range eggs', minMilli: 12000, rev: 2 }), 'member edits metadata');
  await assertSucceeds(pnUp(ADMIN_A, 'pnEggs01', { dimension: 'mass', displayUnit: 'g', minMilli: 500000, rev: 3 }), 'dimension change while stockRev == 0');
  await assertDenied(pnUp(MEMBER_WIFE, 'pnEggs01', { nameEn: 'Replay', rev: 3 }), 'revision replay (rev not + 1)');
  await assertDenied(pnUp(MEMBER_WIFE, 'pnEggs01', { nameEn: 'Skip', rev: 5 }), 'revision skip');
  await assertDenied(pnUp(VIEWER_A, 'pnEggs01', { nameEn: 'Viewer', rev: 4 }), 'viewer cannot edit');
  await assertDenied(pnUp(CHILD_A, 'pnEggs01', { nameEn: 'Child', rev: 4 }), 'child cannot edit');
  await assertDenied(pnUp(OWNER_HOME_B, 'pnEggs01', { nameEn: 'Cross', rev: 4 }), 'other Home cannot edit');
  for (const [x, why] of [[{ stockMilli: 1000 }, 'stock'], [{ stockRev: 1 }, 'stockRev'], [{ presence: 'in' }, 'presence'], [{ trackMode: 'presence', dimension: null, displayUnit: null, minMilli: null, stockMilli: null }, 'trackMode'],
    [{ createdBy: MEMBER_WIFE.uid }, 'createdBy'], [{ schemaVersion: 2 }, 'schemaVersion'], [{ archivedAt: serverTimestamp() }, 'archive field without archive'], [{ price: 1 }, 'unknown key'], [{ category: 'nope' }, 'invalid content']])
    await assertDenied(pnUp(OWNER_A, 'pnEggs01', { ...x, rev: 4 }), `immutable / invalid: ${why}`);
  await assertDenied(updateDoc(pnPath(db(OWNER_A), 'pnEggs01'), { nameEn: 'Late', rev: 4, updatedBy: OWNER_A.uid, updatedAt: new Date('2020-01-01') }), 'client updatedAt');
  await assertDenied(updateDoc(pnPath(db(OWNER_A), 'pnEggs01'), { nameEn: 'Who', rev: 4, updatedBy: MEMBER_WIFE.uid, updatedAt: serverTimestamp() }), 'updatedBy spoof');
  // stock recorded (simulated Phase 02 state) → the dimension is locked
  await env.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), 'homes', 'hA', 'pantryProducts', 'pnEggs01'), { stockRev: 1, stockMilli: 250000 }); });
  await assertDenied(pnUp(OWNER_A, 'pnEggs01', { dimension: 'volume', displayUnit: 'ml', rev: 4 }), 'dimension locked once stock was recorded');
  await assertSucceeds(pnUp(OWNER_A, 'pnEggs01', { displayUnit: 'kg', rev: 4 }), 'display unit within the same dimension stays editable');
  // archive / restore
  await assertDenied(pnUp(MEMBER_WIFE, 'pnEggs01', { archived: true, archivedAt: serverTimestamp(), archivedBy: MEMBER_WIFE.uid, rev: 5 }), 'member cannot archive (inventory.delete)');
  await assertDenied(pnUp(ADMIN_A, 'pnEggs01', { archived: true, archivedAt: serverTimestamp(), archivedBy: OWNER_A.uid, rev: 5 }), 'archivedBy spoof');
  await assertDenied(pnUp(ADMIN_A, 'pnEggs01', { archived: true, archivedAt: serverTimestamp(), archivedBy: ADMIN_A.uid, nameEn: 'Sneak', rev: 5 }), 'archive + edit mixed');
  await assertSucceeds(pnUp(ADMIN_A, 'pnEggs01', { archived: true, archivedAt: serverTimestamp(), archivedBy: ADMIN_A.uid, rev: 5 }), 'admin archives');
  await assertDenied(pnUp(OWNER_A, 'pnEggs01', { nameEn: 'Archived edit', rev: 6 }), 'archived product is read-only');
  await assertDenied(pnUp(OWNER_A, 'pnEggs01', { archived: true, archivedAt: serverTimestamp(), archivedBy: OWNER_A.uid, rev: 6 }), 'archive twice');
  await assertSucceeds(pnUp(OWNER_A, 'pnEggs01', { archived: false, archivedAt: null, archivedBy: null, rev: 6 }), 'owner restores');
  for (const u of [OWNER_A, ADMIN_A, MEMBER_WIFE, VIEWER_A, CHILD_A, MALLORY]) await assertDenied(deleteDoc(pnPath(db(u), 'pnEggs01')), `${u.uid} cannot delete`);
});

test('V65P01-4 pantry + customised roles: rules read the role document — a grant added by the owner works, a removed grant is enforced; Phase 01 changes no role template', async () => {
  await pantryHome();
  await assertSucceeds(setDoc(pnPath(db(OWNER_A), 'pnMilk01'), pnDoc(OWNER_A, { nameEn: 'Milk', dimension: 'volume', displayUnit: 'l', minQty: '1' })));
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    const child = (await getDoc(doc(f, 'homes', 'hA', 'roles', 'child'))).data();
    await updateDoc(doc(f, 'homes', 'hA', 'roles', 'child'), { permissions: [...child.permissions, 'inventory.view'] });
    const member = (await getDoc(doc(f, 'homes', 'hA', 'roles', 'member'))).data();
    await updateDoc(doc(f, 'homes', 'hA', 'roles', 'member'), { permissions: member.permissions.filter((p) => p !== 'inventory.edit') });
  });
  await assertSucceeds(getDoc(pnPath(db(CHILD_A), 'pnMilk01')), 'custom grant: child may view');
  await assertDenied(pnUp(CHILD_A, 'pnMilk01', { nameEn: 'Child edit', rev: 2 }), 'view grant does not imply edit');
  await assertDenied(pnUp(MEMBER_WIFE, 'pnMilk01', { nameEn: 'Member edit', rev: 2 }), 'removed grant enforced for members');
  await assertSucceeds(setDoc(pnPath(db(MEMBER_WIFE), 'pnWife02'), pnDoc(MEMBER_WIFE, { nameEn: 'Bread', dimension: 'count', displayUnit: 'piece' })), 'other grants untouched');
});
