import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionSet, resolvePermissions, NO_PERMISSIONS } from '../../src/core/permissions/resolver.js';
import { isPermissionId, isGrant } from '../../src/core/permissions/permission-format.js';
import { buildSystemRoles, SYSTEM_ROLE_IDS, ROLE_TEMPLATE_VERSION } from '../../src/core/permissions/roles.js';
import { defaultRoles, permissionCatalog } from '../../src/modules/index.js';

test('permission id format is exactly namespace.action', () => {
  assert.ok(isPermissionId('expenses.view'));
  assert.ok(isPermissionId('mealPlanner.create'));
  assert.ok(!isPermissionId('expenses'));
  assert.ok(!isPermissionId('expenses.*'));
  assert.ok(!isPermissionId('a.b.c'));
  assert.ok(!isPermissionId('*'));
  assert.ok(isGrant('*') && isGrant('expenses.*') && isGrant('expenses.view'));
  assert.ok(!isGrant('*.view') && !isGrant('expenses.view.extra'));
});

test('can(): exact, namespace wildcard and global wildcard', () => {
  const p = createPermissionSet(['expenses.view', 'cleaning.*']);
  assert.equal(p.can('expenses.view'), true);
  assert.equal(p.can('expenses.create'), false);
  assert.equal(p.can('cleaning.complete'), true);
  assert.equal(p.can('maintenance.edit'), false);
  assert.equal(createPermissionSet(['*']).can('maintenance.edit'), true);
});

test('can() rejects malformed checks and ignores malformed grants', () => {
  const p = createPermissionSet(['*.view', 'expenses', 'expenses.view']);
  assert.deepEqual(p.grants, ['expenses.view']);
  assert.equal(p.can('expenses'), false);
  assert.equal(p.can(''), false);
  assert.equal(p.can(undefined), false);
});

test('canAny / canAll', () => {
  const p = createPermissionSet(['expenses.view']);
  assert.equal(p.canAny(['chef.view', 'expenses.view']), true);
  assert.equal(p.canAll(['chef.view', 'expenses.view']), false);
  assert.equal(p.canAll([]), false);
});

test('resolvePermissions requires active membership pointing at that role', () => {
  const role = { id: 'member', permissions: ['expenses.view'] };
  assert.equal(resolvePermissions({ membership: { roleId: 'member', status: 'active' }, role }).can('expenses.view'), true);
  assert.equal(resolvePermissions({ membership: { roleId: 'member', status: 'suspended' }, role }), NO_PERMISSIONS);
  assert.equal(resolvePermissions({ membership: { roleId: 'admin', status: 'active' }, role }), NO_PERMISSIONS);
  assert.equal(resolvePermissions({ membership: null, role }), NO_PERMISSIONS);
  assert.equal(resolvePermissions({ membership: { roleId: 'member', status: 'active' }, role: null }), NO_PERMISSIONS);
});

test('seeded roles: owner has *, ranks strictly ordered, all system', () => {
  const roles = defaultRoles();
  assert.deepEqual(roles.map((r) => r.id), [...SYSTEM_ROLE_IDS]);
  assert.deepEqual(roles.find((r) => r.id === 'owner').permissions, ['*']);
  assert.equal(roles.find((r) => r.id === 'owner').rank, 100);
  for (let i = 1; i < roles.length; i++) assert.ok(roles[i].rank < roles[i - 1].rank);
  for (const r of roles) {
    assert.equal(r.system, true);
    assert.equal(r.templateVersion, ROLE_TEMPLATE_VERSION);
    assert.ok(r.permissions.length <= 200, 'rules cap permissions at 200');
  }
});

test('seeded roles: expected capability boundaries', () => {
  const perms = Object.fromEntries(defaultRoles().map((r) => [r.id, createPermissionSet(r.permissions)]));
  // owner
  assert.ok(perms.owner.can('roles.edit') && perms.owner.can('anything.atAll'));
  // admin
  assert.ok(perms.admin.can('home.edit') && perms.admin.can('members.edit') && perms.admin.can('expenses.delete'));
  assert.ok(!perms.admin.can('roles.edit'), 'only the owner edits roles by default');
  // member
  assert.ok(perms.member.can('expenses.create') && perms.member.can('cleaning.complete'));
  assert.ok(!perms.member.can('expenses.delete') && !perms.member.can('home.edit') && !perms.member.can('members.edit'));
  // viewer
  assert.ok(perms.viewer.can('expenses.view') && !perms.viewer.can('expenses.create') && !perms.viewer.can('cleaning.complete'));
  // child
  assert.ok(perms.child.can('cleaning.view') && perms.child.can('cleaning.complete') && perms.child.can('shopping.complete'));
  assert.ok(!perms.child.can('expenses.view') && !perms.child.can('members.view') && !perms.child.can('maintenance.view'));
  // nobody but owner gets wildcards
  for (const id of ['admin', 'member', 'viewer', 'child']) {
    assert.ok(perms[id].grants.every((g) => !g.includes('*')), `${id} has no wildcard grants`);
  }
});

test('catalog has no duplicate permission ids', () => {
  const ids = permissionCatalog().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('buildSystemRoles rejects owner in defaultRoles and unknown roles', () => {
  assert.throws(() => buildSystemRoles([{ id: 'x.view', defaultRoles: ['owner'] }]));
  assert.throws(() => buildSystemRoles([{ id: 'x.view', defaultRoles: ['ghost'] }]));
  assert.throws(() => buildSystemRoles([{ id: 'bad', defaultRoles: [] }]));
});
