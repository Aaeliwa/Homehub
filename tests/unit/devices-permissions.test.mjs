import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRoles } from '../../src/modules/index.js';
import { createPermissionSet } from '../../src/core/permissions/resolver.js';
import { ROLE_TEMPLATE_VERSION, TEMPLATE_CHANGES, namespacesChangedSince, upgradeRolePermissions } from '../../src/core/permissions/roles.js';

const tpl = Object.fromEntries(defaultRoles().map((r) => [r.id, r]));
const perms = Object.fromEntries(Object.values(tpl).map((r) => [r.id, createPermissionSet(r.permissions)]));
const ACTIONS = ['view', 'create', 'edit', 'delete', 'restore'];
const matrix = (role) => ACTIONS.filter((a) => perms[role].can(`devices.${a}`));

test('devices permission matrix per seeded role', () => {
  assert.deepEqual(matrix('owner'), ACTIONS);
  assert.deepEqual(matrix('admin'), ACTIONS);
  for (const r of ['member', 'viewer', 'child']) assert.deepEqual(matrix(r), ['view'], r);
  assert.equal(perms.admin.can('devices.purge'), false, 'no hard-delete permission');
});

test('template history records which namespaces changed (v3 devices; Phase 4 adds v4 expenses)', () => {
  assert.ok(ROLE_TEMPLATE_VERSION >= 3);
  assert.deepEqual(TEMPLATE_CHANGES[3], ['devices']);
  // Phase 4A: v5 adds 'members'. Namespaces changed after v2 = every later version's list.
  const after2 = Object.entries(TEMPLATE_CHANGES).filter(([v]) => Number(v) > 2).flatMap(([, ns]) => ns);
  assert.deepEqual(namespacesChangedSince(2), [...new Set(after2)].sort());
  assert.deepEqual(namespacesChangedSince(ROLE_TEMPLATE_VERSION), []);
});

test('upgrade v2 → v3 replaces only devices grants and keeps customisations', () => {
  const liveMemberV2 = ['devices.create', 'devices.edit', 'devices.view', 'home.view', 'rooms.view', 'expenses.view', 'expenses.create', 'custom.extra'];
  const next = upgradeRolePermissions({ current: liveMemberV2, template: tpl.member.permissions, from: 2 });
  assert.ok(next.includes('devices.view'));
  assert.ok(!next.includes('devices.create') && !next.includes('devices.edit'));
  for (const kept of ['home.view', 'rooms.view', 'expenses.view', 'expenses.create', 'custom.extra']) assert.ok(next.includes(kept), kept);
});

test('upgrade v1 → v3 re-templates rooms AND devices only', () => {
  const v1Member = ['rooms.create', 'rooms.view', 'devices.create', 'devices.view', 'chef.view'];
  const next = upgradeRolePermissions({ current: v1Member, template: tpl.member.permissions, from: 1 });
  assert.ok(!next.includes('rooms.create') && !next.includes('devices.create'));
  assert.ok(next.includes('rooms.view') && next.includes('devices.view') && next.includes('chef.view'));
});

test('admin upgrade gains devices.restore; owner stays ["*"]; already-current role unchanged', () => {
  const adminV2 = tpl.admin.permissions.filter((p) => p !== 'devices.restore');
  assert.ok(upgradeRolePermissions({ current: adminV2, template: tpl.admin.permissions, from: 2 }).includes('devices.restore'));
  assert.deepEqual(upgradeRolePermissions({ current: ['*'], template: ['*'], from: 1 }), ['*']);
  const cur = [...tpl.viewer.permissions, 'custom.x'];
  assert.deepEqual(upgradeRolePermissions({ current: cur, template: tpl.viewer.permissions, from: 3 }), [...cur].sort());
});
