/**
 * Phase 5.1 — legacy Home adoption: eligibility, partial states, write set, resolver routing,
 * service idempotency and the full session flow (real controller/resolver/store/state machine).
 * Rule-level enforcement is covered by the emulator suite (L1–L20).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLegacyHome, buildAdoptionWrites, normalizeHome, LegacyState } from '../../src/core/home/legacy-adoption.js';
import { resolveHomeContext, detectLegacyHome, ContextResult } from '../../src/core/home/context-resolver.js';
import { createStore } from '../../src/core/state/store.js';
import { AppState as S } from '../../src/core/state/app-machine.js';
import { createSessionController } from '../../src/core/lifecycle/session-controller.js';
import { paths } from '../../src/core/firebase/paths.js';
import { AppError, ErrorCode } from '../../src/core/errors/app-error.js';
import { defaultRoles } from '../../src/modules/index.js';
import { ROLE_TEMPLATE_VERSION, SYSTEM_ROLE_IDS } from '../../src/core/permissions/roles.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const UID = 'creator'; const HOME = 'legacyHome';
const USER = { uid: UID, email: 'owner@example.com', displayName: '' };

/** In-memory Firestore + a writer applying ops exactly like atomicWrite. */
function makeDb({ creator = UID, roles = [], member = null, defaultHomeId = HOME, denyHomeRead = false, home = {} } = {}) {
  const docs = new Map(); const key = (s) => s.join('/');
  docs.set(key(paths.user(UID)), { email: USER.email, displayName: 'Abdo', defaultHomeId, language: 'ar', theme: 'system' });
  docs.set(key(paths.home(HOME)), { name: 'Old Adel Home', createdBy: creator, createdAt: 'OLD', ...home });
  for (const [id, data] of roles) docs.set(key(paths.role(HOME, id)), data);
  if (member) docs.set(key(paths.member(HOME, UID)), member);
  // Business data that must never be touched.
  docs.set(key(['homes', HOME, 'devices', 'd1']), { name: 'Fridge', category: 'kitchen' });
  docs.set(key(['homes', HOME, 'expenses', 'e1']), { amountMinor: 45000, category: 'groceries' });
  docs.set(key(['homes', HOME, 'savingsAssets', 's1']), { name: 'Gold', type: 'gold' });
  docs.set(key(['homes', HOME, 'settings', 'general']), { weekStartsOn: 6 });
  const read = async (s) => { const d = docs.get(key(s)); return d ? { id: s.at(-1), ...d } : null; };
  const repo = {
    readProfile: (uid) => read(paths.user(uid)),
    readMembership: (h, uid) => read(paths.member(h, uid)),
    readHome: async (h) => { if (denyHomeRead) throw new AppError(ErrorCode.PERMISSION_DENIED); return read(paths.home(h)); },
    readRole: (h, r) => read(paths.role(h, r)),
    readGeneralSettings: (h) => read(paths.setting(h, 'general')),
  };
  const writes = [];
  const write = async (fn) => {
    const batch = [];
    fn({ set: (p, d) => batch.push({ p, d }), update: (p, d) => batch.push({ p, d, u: true }) });
    for (const { p } of batch) if (docs.has(key(p))) throw Object.assign(new Error('exists'), { code: 'permission-denied' }); // create-only, like the rules
    for (const { p, d } of batch) docs.set(key(p), d);
    writes.push(batch.map((b) => key(b.p)));
  };
  return { docs, key, repo, write, writes };
}
const snapshotExcept = (db, prefixes) => JSON.stringify([...db.docs.entries()].filter(([k]) => !prefixes.some((p) => k.startsWith(p))).sort());

test('classify: fresh / partial roles eligible; owner role → BLOCKED; not creator / not default / member → NOT_LEGACY', () => {
  const profile = { defaultHomeId: HOME }; const home = { id: HOME, createdBy: UID };
  assert.deepEqual(classifyLegacyHome({ uid: UID, profile, home, membershipExists: false, existingRoleIds: [] }), { state: LegacyState.ELIGIBLE, reason: 'fresh' });
  assert.equal(classifyLegacyHome({ uid: UID, profile, home, membershipExists: false, existingRoleIds: ['admin'] }).reason, 'partialRoles');
  assert.equal(classifyLegacyHome({ uid: UID, profile, home, membershipExists: false, existingRoleIds: ['owner'] }).state, LegacyState.BLOCKED);
  assert.equal(classifyLegacyHome({ uid: 'attacker', profile, home, membershipExists: false }).reason, 'notCreator');
  assert.equal(classifyLegacyHome({ uid: UID, profile: { defaultHomeId: 'other' }, home, membershipExists: false }).reason, 'notDefaultHome');
  assert.equal(classifyLegacyHome({ uid: UID, profile, home, membershipExists: true }).reason, 'membershipExists');
  assert.equal(classifyLegacyHome({ uid: UID, profile, home: null }).state, LegacyState.NOT_LEGACY);
});

test('write set: own active Owner membership + five CURRENT system roles; owner ["*"] rank 100 v6', () => {
  const w = buildAdoptionWrites({ identity: USER, profile: { displayName: 'Abdo' }, homeId: HOME, existingRoleIds: [], roles: defaultRoles(), now: 'NOW' });
  assert.equal(w[0].path.join('/'), `homes/${HOME}/members/${UID}`);
  assert.deepEqual(w[0].data, { uid: UID, email: USER.email, displayName: 'Abdo', roleId: 'owner', status: 'active', addedBy: UID, joinedAt: 'NOW', createdAt: 'NOW', updatedAt: 'NOW', legacyAdoption: true });
  const roles = Object.fromEntries(w.slice(1).map((x) => [x.path.at(-1), x.data]));
  assert.deepEqual(Object.keys(roles).sort(), [...SYSTEM_ROLE_IDS].sort());
  assert.deepEqual(Object.keys(roles).sort(), ['admin', 'child', 'member', 'owner', 'viewer']);
  assert.deepEqual([roles.owner.permissions, roles.owner.rank, roles.owner.system, roles.owner.templateVersion], [['*'], 100, true, ROLE_TEMPLATE_VERSION]);
  assert.equal(ROLE_TEMPLATE_VERSION, 8);   // v8: V6.2 (+ calendar.*, additive)
  for (const r of ['admin', 'member', 'viewer', 'child']) { assert.ok(roles[r].rank < 100); assert.ok(!roles[r].permissions.includes('*')); }
  assert.ok(!w.some((x) => /devices|expenses|savings|settings|users/.test(x.path.join('/'))), 'no business/profile writes');
  assert.ok(!w.some((x) => x.path.join('/') === `homes/${HOME}`), 'home document never written');
});

test('partial state: existing (possibly customised) roles are NEVER rewritten', () => {
  const w = buildAdoptionWrites({ identity: USER, profile: {}, homeId: HOME, existingRoleIds: ['admin', 'viewer'], roles: defaultRoles(), now: 'NOW' });
  assert.deepEqual(w.slice(1).map((x) => x.path.at(-1)).sort(), ['child', 'member', 'owner']);
});

test('normalizeHome: in-memory defaults for older documents; original object untouched', () => {
  const old = { createdBy: UID };
  const n = normalizeHome(old, { homeName: 'HomeHub', currency: 'EGP', timezone: 'Africa/Cairo', language: 'ar' });
  assert.deepEqual([n.name, n.currency, n.timezone, n.language], ['HomeHub', 'EGP', 'Africa/Cairo', 'ar']);
  assert.deepEqual(n.legacyMissingFields, ['name', 'currency', 'timezone', 'language']);
  assert.deepEqual(old, { createdBy: UID });
  const full = { name: 'A', currency: 'USD', timezone: 'UTC', language: 'en' };
  assert.equal(normalizeHome(full, {}), full);
});

test('resolver: own legacy home → LEGACY_HOME_ADOPTION_REQUIRED (not PERMISSION_DENIED)', async () => {
  const db = makeDb();
  await assert.rejects(resolveHomeContext(USER, db.repo), (e) => e.code === ErrorCode.LEGACY_HOME_ADOPTION_REQUIRED
    && e.adoption.homeId === HOME && e.adoption.homeName === 'Old Adel Home' && e.adoption.existingRoleIds.length === 0 && !!e.profile);
});

test('resolver: another person\'s home / unreadable home → normal MEMBERSHIP_MISSING (nothing revealed)', async () => {
  await assert.rejects(resolveHomeContext(USER, makeDb({ creator: 'someoneElse' }).repo), (e) => e.code === ErrorCode.MEMBERSHIP_MISSING);
  await assert.rejects(resolveHomeContext(USER, makeDb({ denyHomeRead: true }).repo), (e) => e.code === ErrorCode.MEMBERSHIP_MISSING);
});

test('resolver: owner role already present (partial state C) → LEGACY_HOME_ADOPTION_BLOCKED, no repair', async () => {
  const db = makeDb({ roles: [['owner', { permissions: ['*'], rank: 100 }]] });
  await assert.rejects(resolveHomeContext(USER, db.repo), (e) => e.code === ErrorCode.LEGACY_HOME_ADOPTION_BLOCKED);
});

test('resolver: initialised home (state E) behaves exactly as before → READY', async () => {
  const db = makeDb({ member: { uid: UID, roleId: 'owner', status: 'active' }, roles: defaultRoles().map((r) => [r.id, r]), home: { currency: 'EGP', timezone: 'Africa/Cairo', language: 'ar' } });
  const r = await resolveHomeContext(USER, db.repo);
  assert.equal(r.kind, ContextResult.READY); assert.ok(r.permissions.can('savings.zakat') && r.permissions.can('devices.edit'));
  assert.equal(r.home.legacyMissingFields, undefined, 'complete home not flagged');
});

test('service: adopts once (member + 5 roles), business data/home/profile untouched; retry is a no-op', async () => {
  const { adoptLegacyHome } = await import('../../src/core/home/legacy-adoption-service.js');
  const db = makeDb();
  const before = snapshotExcept(db, [`homes/${HOME}/members/`, `homes/${HOME}/roles/`]);
  const r = await adoptLegacyHome({ identity: USER, profile: { defaultHomeId: HOME, displayName: 'Abdo' }, repo: db.repo, write: db.write, now: () => 'NOW' });
  assert.deepEqual(r, { adopted: true, homeId: HOME, createdRoles: 5 });
  assert.equal(db.writes.length, 1, 'ONE atomic batch');
  assert.equal(snapshotExcept(db, [`homes/${HOME}/members/`, `homes/${HOME}/roles/`]), before, 'home, profile, devices, expenses, savings, settings unchanged');
  const again = await adoptLegacyHome({ identity: USER, profile: { defaultHomeId: HOME }, repo: db.repo, write: db.write, now: () => 'NOW' });
  assert.deepEqual(again, { adopted: false, reason: 'alreadyMember' });
  assert.equal(db.writes.length, 1, 'retry writes nothing');
});

test('service: partial roles kept verbatim (custom permissions survive); custom role ids untouched', async () => {
  const { adoptLegacyHome } = await import('../../src/core/home/legacy-adoption-service.js');
  const customAdmin = { name: 'Admin', rank: 80, permissions: ['rooms.view', 'custom.grant'], system: true, templateVersion: 2 };
  const db = makeDb({ roles: [['admin', customAdmin], ['grandma', { name: 'Grandma', rank: 30, permissions: ['rooms.view'], system: false }]] });
  await adoptLegacyHome({ identity: USER, profile: { defaultHomeId: HOME }, repo: db.repo, write: db.write, now: () => 'NOW' });
  assert.deepEqual(db.docs.get(`homes/${HOME}/roles/admin`), customAdmin);
  assert.equal(db.docs.get(`homes/${HOME}/roles/grandma`).name, 'Grandma');
  assert.deepEqual(db.writes[0].filter((k) => k.includes('/roles/')).map((k) => k.split('/').pop()).sort(), ['child', 'member', 'owner', 'viewer']);
});

test('service: owner role present / not creator / rules rejection → specific errors, nothing written', async () => {
  const { adoptLegacyHome } = await import('../../src/core/home/legacy-adoption-service.js');
  const blocked = makeDb({ roles: [['owner', { permissions: ['*'] }]] });
  await assert.rejects(adoptLegacyHome({ identity: USER, profile: { defaultHomeId: HOME }, repo: blocked.repo, write: blocked.write, now: () => 'NOW' }), (e) => e.code === ErrorCode.LEGACY_HOME_ADOPTION_BLOCKED);
  const other = makeDb({ creator: 'someoneElse' });
  await assert.rejects(adoptLegacyHome({ identity: USER, profile: { defaultHomeId: HOME }, repo: other.repo, write: other.write, now: () => 'NOW' }), (e) => e.code === ErrorCode.MEMBERSHIP_MISSING);
  const race = makeDb();
  const reject = async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); };
  await assert.rejects(adoptLegacyHome({ identity: USER, profile: { defaultHomeId: HOME }, repo: race.repo, write: reject, now: () => 'NOW' }), (e) => e.code === ErrorCode.LEGACY_HOME_ADOPTION_BLOCKED && e.detail === 'rulesRejected');
  assert.equal(blocked.writes.length + other.writes.length, 0);
  await assert.rejects(adoptLegacyHome({ identity: USER, profile: { defaultHomeId: HOME }, repo: race.repo }), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE, 'missing dependencies are refused, not guessed');
});

test('session: login → upgrade required → adopt → automatic READY with "*", same home & defaultHomeId; refresh stays READY', async () => {
  const { adoptLegacyHome } = await import('../../src/core/home/legacy-adoption-service.js');
  const db = makeDb();
  let authCb = null;
  const auth = { observeAuth: (cb) => { authCb = cb; return () => {}; }, signIn: async () => {}, signOutUser: async () => {}, requestPasswordReset: async () => {} };
  const mk = () => { const store = createStore(); const s = createSessionController({ store, auth, repo: db.repo, setup: {}, watch: () => () => {}, paths, applyPreferences: () => {},
    adoption: { adopt: (args) => adoptLegacyHome({ ...args, repo: db.repo, write: db.write, now: () => 'NOW' }) } }); return { store, s }; };
  const { store, s } = mk();
  s.start(); authCb(USER); await flush();
  assert.equal(store.get().status, S.ERROR);
  assert.equal(store.get().error.code, ErrorCode.LEGACY_HOME_ADOPTION_REQUIRED);
  await s.adoptLegacyHome(); await flush();
  const st = store.get();
  assert.equal(st.status, S.READY);
  assert.equal(st.home.id, HOME, 'same Home');
  assert.equal(st.membership.roleId, 'owner'); assert.ok(st.permissions.can('savings.zakat') && st.permissions.can('devices.edit'));
  assert.equal(db.docs.get(`users/${UID}`).defaultHomeId, HOME, 'defaultHomeId unchanged');
  // "Refresh": a brand-new session resolves straight to READY — no upgrade screen again.
  const second = mk(); second.s.start(); authCb(USER); await flush();
  assert.equal(second.store.get().status, S.READY);
});

test('session: adoptLegacyHome is refused outside the legacy-upgrade state', async () => {
  const store = createStore();
  const s = createSessionController({ store, auth: { observeAuth: () => () => {} }, repo: makeDb().repo, setup: {}, watch: () => () => {}, paths, applyPreferences: () => {}, adoption: { adopt: async () => { throw new Error('must not run'); } } });
  await assert.rejects(s.adoptLegacyHome(), (e) => e.code === ErrorCode.CONTEXT_UNAVAILABLE);
});

test('detectLegacyHome reads only per-id documents (no list) for exactly the system roles', async () => {
  const calls = [];
  const repo = { readHome: async () => ({ createdBy: UID }), readRole: async (h, r) => { calls.push(r); return null; } };
  await detectLegacyHome(UID, { defaultHomeId: HOME }, HOME, repo);
  assert.deepEqual(calls.sort(), [...SYSTEM_ROLE_IDS].sort());
});
