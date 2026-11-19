import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRoles } from '../../src/modules/index.js';
import { createPermissionSet } from '../../src/core/permissions/resolver.js';
import { ROLE_TEMPLATE_VERSION } from '../../src/core/permissions/roles.js';

const perms = Object.fromEntries(defaultRoles().map((r) => [r.id, createPermissionSet(r.permissions)]));
const ACTIONS = ['view', 'create', 'edit', 'delete', 'restore'];
const matrix = (role) => ACTIONS.filter((a) => perms[role].can(`rooms.${a}`));

test('rooms permission matrix per seeded role', () => {
  assert.deepEqual(matrix('owner'), ACTIONS, 'owner: full (via *)');
  assert.deepEqual(matrix('admin'), ACTIONS);
  assert.deepEqual(matrix('member'), ['view']);
  assert.deepEqual(matrix('viewer'), ['view']);
  assert.deepEqual(matrix('child'), ['view']);
});

test('unknown/unauthorised actions are blocked', () => {
  assert.equal(perms.member.can('rooms.create'), false);
  assert.equal(perms.child.can('rooms.delete'), false);
  assert.equal(createPermissionSet([]).can('rooms.view'), false);
  assert.equal(perms.admin.can('rooms.purge'), false, 'no hard-delete permission exists');
});

test('role template version is current (Phase 2 introduced 2; Phase 3 is 3)', () => {
  assert.ok(ROLE_TEMPLATE_VERSION >= 2);
  assert.ok(defaultRoles().every((r) => r.templateVersion === ROLE_TEMPLATE_VERSION));
});
