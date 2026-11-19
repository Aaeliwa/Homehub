import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupWrites } from '../../src/core/home/setup-plan.js';
import { defaultRoles } from '../../src/modules/index.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';

const identity = { uid: 'UID_X', email: 'x@example.com', displayName: '' };
const plan = (extra = {}) => buildSetupWrites({
  identity, existingProfile: null, displayName: '  Abdo   Adel ', homeName: 'Adel Home', language: 'ar', theme: 'system',
  homeId: 'HOME_1', roles: defaultRoles(), now: 'NOW', ...extra,
});
const at = (writes, path) => writes.find((w) => w.path.join('/') === path);

test('creates exactly the foundation documents (no business data)', () => {
  const paths = plan().map((w) => w.path.join('/')).sort();
  assert.deepEqual(paths, [
    'homes/HOME_1',
    'homes/HOME_1/members/UID_X',
    'homes/HOME_1/roles/admin',
    'homes/HOME_1/roles/child',
    'homes/HOME_1/roles/member',
    'homes/HOME_1/roles/owner',
    'homes/HOME_1/roles/viewer',
    'homes/HOME_1/settings/general',
    'users/UID_X',
  ]);
});

test('home, membership and user are bound to the authenticated uid', () => {
  const w = plan();
  const home = at(w, 'homes/HOME_1').data;
  assert.equal(home.createdBy, 'UID_X');
  assert.equal(home.updatedBy, 'UID_X');
  assert.deepEqual([home.currency, home.timezone, home.language], ['EGP', 'Africa/Cairo', 'ar']);
  const member = at(w, 'homes/HOME_1/members/UID_X').data;
  assert.equal(member.uid, 'UID_X');
  assert.equal(member.roleId, 'owner');
  assert.equal(member.status, 'active');
  assert.equal(member.displayName, 'Abdo Adel', 'name is normalised');
  const user = at(w, 'users/UID_X');
  assert.equal(user.mode, 'set');
  assert.equal(user.data.defaultHomeId, 'HOME_1');
  assert.equal(user.data.email, 'x@example.com');
});

test('document keys match the exact key sets the rules require', () => {
  const w = plan();
  const keys = (p) => Object.keys(at(w, p).data).sort();
  assert.deepEqual(keys('homes/HOME_1'), ['createdAt', 'createdBy', 'currency', 'language', 'name', 'schemaVersion', 'timezone', 'updatedAt', 'updatedBy']);
  assert.deepEqual(keys('homes/HOME_1/members/UID_X'), ['addedBy', 'createdAt', 'displayName', 'email', 'joinedAt', 'roleId', 'status', 'uid', 'updatedAt']);
  assert.deepEqual(keys('homes/HOME_1/roles/owner'), ['createdAt', 'name', 'permissions', 'rank', 'system', 'templateVersion', 'updatedAt']);
  assert.deepEqual(keys('homes/HOME_1/settings/general'), ['createdAt', 'schemaVersion', 'updatedAt', 'updatedBy', 'weekStartsOn']);
  assert.deepEqual(keys('users/UID_X'), ['createdAt', 'defaultHomeId', 'displayName', 'email', 'language', 'schemaVersion', 'theme', 'updatedAt']);
});

test('existing profile is UPDATED (only displayName, defaultHomeId, updatedAt)', () => {
  const user = at(plan({ existingProfile: { displayName: 'Old' } }), 'users/UID_X');
  assert.equal(user.mode, 'update');
  assert.deepEqual(Object.keys(user.data).sort(), ['defaultHomeId', 'displayName', 'updatedAt']);
});

test('validation: empty names are rejected before any write', () => {
  assert.throws(() => plan({ displayName: '   ' }), (e) => e.code === ErrorCode.VALIDATION);
  assert.throws(() => plan({ homeName: '' }), (e) => e.code === ErrorCode.VALIDATION);
  assert.throws(() => plan({ homeName: 'x'.repeat(81) }), (e) => e.code === ErrorCode.VALIDATION);
});
