import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateCode, isCode, normalizeCode, formatCode, inviteState, buildInvite, buildAcceptWrites, canInviteRole, CODE_LENGTH, MEMBER_TYPES } from '../../src/core/family/invite-model.js';
import { normalizeMember, createDirectory, memberActions, assignableRoles, familySummary } from '../../src/core/family/member-model.js';
import { loadInvite, acceptInvite } from '../../src/core/family/join-service.js';
import { createFamilyStore } from '../../src/core/family/family-store.js';
import { createContextScope } from '../../src/core/lifecycle/context-scope.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';
import { defaultRoles } from '../../src/modules/index.js';
import { createPermissionSet } from '../../src/core/permissions/resolver.js';
import { upgradeRolePermissions, ROLE_TEMPLATE_VERSION, TEMPLATE_CHANGES } from '../../src/core/permissions/roles.js';
import { filterHistory, sortHistory } from '../../src/modules/expenses/ledger.js';

const rb = (n) => [...randomBytes(n)];
const HOME = { id: 'H1', name: 'بيت ابو تميم' };
const NOW = 1_800_000_000_000;

test('invite codes: secure alphabet, fixed length, unique, normalisable', () => {
  const codes = new Set(Array.from({ length: 2000 }, () => generateCode(rb)));
  assert.equal(codes.size, 2000);
  for (const c of codes) assert.ok(isCode(c) && c.length === CODE_LENGTH && !/[01ILOU]/.test(c));
  const c = [...codes][0];
  assert.equal(normalizeCode(formatCode(c).toLowerCase()), c);
  assert.throws(() => generateCode(() => new Uint8Array(24).fill(255)), /unusable/, 'never loops forever');
});

test('invite state: ok / expired / used / cancelled / invalid / already member', () => {
  const inv = { status: 'pending', expiresAtMillis: NOW + 1000 };
  assert.equal(inviteState(inv, { nowMillis: NOW }), 'ok');
  assert.equal(inviteState(inv, { nowMillis: NOW + 1000 }), 'expired');
  assert.equal(inviteState({ ...inv, status: 'accepted' }, { nowMillis: NOW }), 'used');
  assert.equal(inviteState({ ...inv, status: 'cancelled' }, { nowMillis: NOW }), 'cancelled');
  assert.equal(inviteState(null, { nowMillis: NOW }), 'invalid');
  assert.equal(inviteState(inv, { nowMillis: NOW, isMemberOfHome: true }), 'alreadyMember');
});

test('buildInvite: member types map to roles; child needs guardians; expiry bounded', () => {
  const adult = buildInvite({ home: HOME, uid: 'ahmed', type: 'adult', nowMillis: NOW, now: 'N' });
  assert.deepEqual([adult.roleId, adult.relationship, adult.guardianUids, adult.status, adult.createdBy, adult.homeName], ['member', 'adult', [], 'pending', 'ahmed', HOME.name]);
  assert.equal(adult.expiresAtMillis, NOW + 7 * 86400000);
  const child = buildInvite({ home: HOME, uid: 'ahmed', type: 'child', guardianUids: ['sara', 'ahmed'], nowMillis: NOW, now: 'N' });
  assert.deepEqual([child.roleId, child.relationship, child.guardianUids], ['child', 'child', ['ahmed', 'sara']]);
  assert.throws(() => buildInvite({ home: HOME, uid: 'ahmed', type: 'child', guardianUids: [], nowMillis: NOW, now: 'N' }), (e) => e.detail === 'family.validation.guardians');
  assert.throws(() => buildInvite({ home: HOME, uid: 'ahmed', type: 'owner', nowMillis: NOW, now: 'N' }), (e) => e.code === ErrorCode.VALIDATION, 'no owner invites');
  assert.throws(() => buildInvite({ home: HOME, uid: 'ahmed', type: 'adult', ttlDays: 30, nowMillis: NOW, now: 'N' }));
  assert.ok(!Object.values(MEMBER_TYPES).some((t) => t.roleId === 'owner'));
});

test('role escalation by invite: admin can invite below its rank only; nobody invites owner', () => {
  assert.equal(canInviteRole({ myRoleId: 'owner', myRank: 100, targetRank: 80, targetRoleId: 'admin' }), true);
  assert.equal(canInviteRole({ myRoleId: 'admin', myRank: 80, targetRank: 80, targetRoleId: 'admin' }), false);
  assert.equal(canInviteRole({ myRoleId: 'admin', myRank: 80, targetRank: 50, targetRoleId: 'member' }), true);
  assert.equal(canInviteRole({ myRoleId: 'owner', myRank: 100, targetRank: 100, targetRoleId: 'owner' }), false);
});

test('accept writes: new account → invite + membership + profile in ONE batch, copied from invite', () => {
  const invite = buildInvite({ home: HOME, uid: 'ahmed', type: 'adult', nowMillis: NOW, now: 'N' });
  const w = buildAcceptWrites({ code: 'C'.repeat(24), invite, identity: { uid: 'sara', email: 's@x' }, displayName: ' Sara ', existingMember: null, profile: null, now: 'N' });
  assert.deepEqual(w.map((x) => `${x.mode}:${x.path.join('/')}`), ['update:invites/' + 'C'.repeat(24), 'set:homes/H1/members/sara', 'set:users/sara']);
  assert.deepEqual(w[0].data, { status: 'accepted', acceptedBy: 'sara', acceptedAt: 'N' });
  const m = w[1].data;
  assert.deepEqual([m.uid, m.roleId, m.status, m.relationship, m.addedBy, m.displayName, m.inviteCode], ['sara', 'member', 'active', 'adult', 'ahmed', 'Sara', 'C'.repeat(24)]);
  assert.equal(w[2].data.defaultHomeId, 'H1');
});

test('accept writes: existing user keeps their default home unless they choose to switch', () => {
  const invite = buildInvite({ home: HOME, uid: 'ahmed', type: 'viewer', nowMillis: NOW, now: 'N' });
  const base = { code: 'C'.repeat(24), invite, identity: { uid: 'sara', email: 's@x' }, displayName: 'Sara', existingMember: null, now: 'N' };
  assert.equal(buildAcceptWrites({ ...base, profile: { defaultHomeId: 'OTHER' } }).length, 2, 'no user write');
  const sw = buildAcceptWrites({ ...base, profile: { defaultHomeId: 'OTHER' }, makeDefault: true });
  assert.deepEqual(sw[2].data, { defaultHomeId: 'H1', updatedAt: 'N' });
  const rejoin = buildAcceptWrites({ ...base, profile: { defaultHomeId: 'H1' }, existingMember: { status: 'removed' } });
  assert.equal(rejoin[1].mode, 'update', 're-join updates the old membership (history kept)');
});

function fakeJoinRepo({ invite, member }) {
  const commits = [];
  return { commits, now: () => 'N', readInvite: async () => invite, readMember: async () => member, commit: async (ops) => commits.push(ops) };
}

test('join service: invalid / expired / used / already-member rejected before any write; valid accepted once', async () => {
  const code = generateCode(rb);
  const pending = { ...buildInvite({ home: HOME, uid: 'ahmed', type: 'adult', nowMillis: NOW, now: 'N' }), id: code };
  const id = { uid: 'sara', email: 's@x' };
  assert.equal((await loadInvite(fakeJoinRepo({ invite: pending }), 'not-a-code', { uid: 'sara', nowMillis: NOW })).state, 'invalid');
  for (const [repo, state] of [[fakeJoinRepo({ invite: pending }), 'ok'], [fakeJoinRepo({ invite: { ...pending, status: 'accepted' } }), 'used'],
    [fakeJoinRepo({ invite: pending, member: { status: 'active' } }), 'alreadyMember'], [fakeJoinRepo({ invite: null }), 'invalid']]) {
    assert.equal((await loadInvite(repo, formatCode(code), { uid: 'sara', nowMillis: NOW })).state, state);
  }
  const expired = fakeJoinRepo({ invite: pending });
  await assert.rejects(acceptInvite(expired, { code, identity: id, displayName: 'Sara', profile: null, nowMillis: pending.expiresAtMillis }), (e) => e.detail === 'family.invite.state.expired');
  assert.equal(expired.commits.length, 0);
  const ok = fakeJoinRepo({ invite: pending });
  const res = await acceptInvite(ok, { code, identity: id, displayName: 'Sara', profile: null, nowMillis: NOW });
  assert.deepEqual([res.homeId, res.switched, ok.commits.length, ok.commits[0].length], ['H1', true, 1, 3]);
  const removed = fakeJoinRepo({ invite: pending, member: { status: 'removed' } });
  assert.equal((await loadInvite(removed, code, { uid: 'sara', nowMillis: NOW })).state, 'ok', 'removed members may come back with a NEW invite');
});

const M = (uid, roleId, extra = {}) => normalizeMember({ uid, roleId, displayName: uid, status: 'active', ...extra });
const RANK = { owner: 100, admin: 80, member: 50, viewer: 20, child: 10 };
const perms = (roleId) => createPermissionSet(defaultRoles().find((r) => r.id === roleId).permissions);

test('member actions: no self-promotion, owner protected (last owner), ranks respected', () => {
  const owner = M('ahmed', 'owner'); const admin = M('adm', 'admin'); const wife = M('sara', 'member'); const kid = M('omar', 'child', { relationship: 'child' });
  const act = (me, target) => memberActions({ me, myRank: RANK[me.roleId], target, targetRank: RANK[target.roleId], can: perms(me.roleId).can });
  assert.deepEqual(Object.values(act(owner, owner)).filter(Boolean), [], 'owner cannot leave/demote/remove themselves');
  assert.equal(act(wife, wife).changeRole, false, 'member cannot self-promote');
  assert.equal(act(wife, wife).leave, true);
  assert.equal(act(admin, owner).remove, false, 'nobody removes the owner');
  assert.equal(act(admin, owner).changeRole, false);
  assert.equal(act(admin, wife).remove, true);
  assert.equal(act(admin, M('adm2', 'admin')).changeRole, false, 'admin cannot manage another admin');
  assert.equal(act(owner, admin).changeRole, true);
  assert.equal(act(wife, kid).remove, false, 'members cannot remove');
  assert.equal(act(owner, kid).guardians, true);
  assert.equal(act(admin, wife).guardians, false, 'guardians only for children');
  assert.deepEqual(assignableRoles(Object.entries(RANK).map(([id, rank]) => ({ id, rank })), { myRoleId: 'admin', myRank: 80 }).map((r) => r.id), ['member', 'viewer', 'child']);
  assert.ok(!assignableRoles(Object.entries(RANK).map(([id, rank]) => ({ id, rank })), { myRoleId: 'owner', myRank: 100 }).some((r) => r.id === 'owner'));
});

test('default roles: family permissions; child has no admin or household-finance access', () => {
  const p = (r) => ['view', 'invite', 'edit', 'remove', 'manageChildren'].filter((a) => perms(r).can(`members.${a}`));
  assert.deepEqual(p('owner'), ['view', 'invite', 'edit', 'remove', 'manageChildren']);
  assert.deepEqual(p('admin'), ['view', 'invite', 'edit', 'remove', 'manageChildren']);
  assert.deepEqual(p('member'), ['view']);
  assert.deepEqual(p('viewer'), ['view']);
  assert.deepEqual(p('child'), []);
  const c = perms('child');
  for (const x of ['expenses.view', 'expenses.viewFinancialTotals', 'roles.edit', 'home.edit', 'expenses.import']) assert.equal(c.can(x), false, x);
  assert.equal(perms('viewer').can('expenses.create'), false, 'viewer read-only');
});

test('template v5 upgrade: adds members.manageChildren, preserves custom + other namespaces', () => {
  assert.ok(ROLE_TEMPLATE_VERSION >= 5, 'v5 introduced members; Phase 5 is v6');
  assert.deepEqual(TEMPLATE_CHANGES[5], ['members']);
  const adminV4 = ['custom.thing', 'devices.view', 'expenses.import', 'expenses.view', 'home.edit', 'members.edit', 'members.invite', 'members.remove', 'members.view', 'rooms.view'];
  const tpl = defaultRoles().find((r) => r.id === 'admin').permissions;
  const up = upgradeRolePermissions({ current: adminV4, template: tpl, from: 4 });
  for (const keep of ['custom.thing', 'expenses.import', 'devices.view', 'rooms.view', 'home.edit']) assert.ok(up.includes(keep), keep);
  assert.ok(up.includes('members.manageChildren'));
  const memberCustom = ['members.invite', 'members.view', 'expenses.view'];
  const upM = upgradeRolePermissions({ current: memberCustom, template: defaultRoles().find((r) => r.id === 'member').permissions, from: 4 });
  assert.ok(upM.includes('members.invite'), 'v5 is ADDITIVE: a custom members grant survives');
  assert.ok(upM.includes('expenses.view'), 'finance untouched');
});

test('directory: names for active AND former members (history never shows undefined)', () => {
  const dir = createDirectory([{ uid: 'sara', displayName: 'Sara', roleId: 'member', status: 'removed' }, { id: 'omar', displayName: 'Omar', roleId: 'child', guardianUids: ['ahmed', 'sara'] }],
    { selfUid: 'ahmed', selfName: 'Ahmed' });
  assert.equal(dir.nameOf('sara'), 'Sara', 'removed member still named');
  assert.equal(dir.nameOf('ahmed'), 'Ahmed');
  assert.equal(dir.nameOf('ghost', 'Former member'), 'Former member');
  assert.deepEqual(dir.active().map((m) => m.uid), ['omar']);
  assert.deepEqual(dir.guardiansOf('omar'), ['ahmed', 'sara']);
  assert.deepEqual(dir.childrenOf('sara').map((m) => m.uid), ['omar']);
  assert.deepEqual(familySummary([{ status: 'active' }, { status: 'active', roleId: 'child' }, { status: 'removed' }], [{ status: 'pending', expiresAtMillis: NOW + 1 }, { status: 'pending', expiresAtMillis: NOW - 1 }], NOW),
    { active: 2, children: 1, pendingInvites: 1 });
});

test('family store: listeners follow permissions; one each; cleanup on dispose; self-actions refused', async () => {
  let watches = 0; let unwatches = 0; const commits = [];
  const repo = { now: () => 'N', commit: async (o) => commits.push(o),
    watchMembers: (h, cb) => { watches++; queueMicrotask(() => cb([{ id: 'ahmed', uid: 'ahmed', displayName: 'Ahmed', roleId: 'owner', status: 'active' }])); return () => unwatches++; },
    watchInvites: (h, cb) => { watches++; queueMicrotask(() => cb([])); return () => unwatches++; } };
  const scope = createContextScope({ uid: 'ahmed', homeId: 'H1' });
  const s = scope.resource('family', () => createFamilyStore({ homeId: 'H1', uid: 'ahmed', repo, randomBytes: rb, nowMillis: () => NOW }));
  s.ensure({ canViewMembers: true, canInvite: true }); s.ensure({ canViewMembers: true, canInvite: true });
  assert.equal(watches, 2, 'no duplicate listeners');
  const code = await s.createInvite({ home: HOME, type: 'adult' });
  assert.ok(isCode(code));
  assert.equal(commits[0][0].path.join('/'), `invites/${code}`);
  await assert.rejects(s.changeRole('ahmed', 'admin'), (e) => e.code === ErrorCode.PERMISSION_DENIED);
  await assert.rejects(s.setStatus('ahmed', 'removed'), (e) => e.code === ErrorCode.PERMISSION_DENIED);
  await s.setStatus('sara', 'removed');
  assert.deepEqual(commits.at(-1)[0].data, { status: 'removed', updatedAt: 'N' }, 'removal is a status change, not a delete');
  scope.dispose();
  assert.equal(unwatches, 2);
  await assert.rejects(s.createInvite({ home: HOME, type: 'adult' }), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE);
});

test('finance attribution: added-by / paid-by filters; imported rows never attributed; newest-first kept', () => {
  const E = (id, date, extra) => ({ id, date, amountMinor: 1, category: 'food', status: 'active', ...extra });
  const list = [E('a', '2026-10-05', { createdBy: 'sara', paidBy: 'sara' }), E('b', '2026-10-06', { createdBy: 'ahmed', paidBy: 'sara' }),
    E('c', '2025-01-01', { createdBy: 'ahmed', source: 'import' }), E('d', '2026-10-04', { createdBy: 'sara', paidBy: null })];
  const ids = (f) => sortHistory(filterHistory(list, f)).map((x) => x.id);
  assert.deepEqual(ids({}), ['b', 'a', 'd', 'c'], 'newest first');
  assert.deepEqual(ids({ createdBy: 'sara' }), ['a', 'd']);
  assert.deepEqual(ids({ createdBy: 'ahmed' }), ['b'], 'imported rows are not "added by" the importer');
  assert.deepEqual(ids({ paidBy: 'sara' }), ['b', 'a'], 'payer ≠ creator');
});

// ---- Phase 4A regression (found by browser test M18): child Quick add had no default wallet.
import { defaultWallet } from '../../src/modules/expenses/expense-form.js';
test('Quick add default: household cash first, else the member\'s OWN personal wallet (child allowance)', () => {
  const store = { cycleFor: () => null };
  const allowance = { id: 'al', scope: 'personal', ownerUid: 'omar', visibility: 'shared', type: 'allowance' };
  const shared = { id: 'sh', scope: 'personal', ownerUid: 'sara', visibility: 'shared', type: 'cash' };
  const cash = { id: 'hc', scope: 'home', visibility: 'household', type: 'cash' };
  assert.equal(defaultWallet(store, [shared, allowance], '2026-10-05', 'omar').id, 'al', 'child gets own allowance');
  assert.equal(defaultWallet(store, [allowance, cash], '2026-10-05', 'ahmed').id, 'hc', 'adults keep household cash');
  assert.equal(defaultWallet(store, [shared], '2026-10-05', 'omar'), null, 'never someone else\'s wallet');
});
