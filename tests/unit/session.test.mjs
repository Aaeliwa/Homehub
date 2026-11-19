/**
 * Session lifecycle tests with in-memory fakes for auth, repository and watchers.
 * Exercises the real session controller, context resolver, store and state machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/core/state/store.js';
import { AppState as S } from '../../src/core/state/app-machine.js';
import { createSessionController } from '../../src/core/lifecycle/session-controller.js';
import { paths } from '../../src/core/firebase/paths.js';
import { AppError, ErrorCode } from '../../src/core/errors/app-error.js';
import { defaultRoles } from '../../src/modules/index.js';
import { buildSetupWrites } from '../../src/core/home/setup-plan.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 10; i++) await tick(); };

function makeEnv({ delay = 0 } = {}) {
  const docs = new Map();
  const key = (segs) => segs.join('/');
  const read = async (segs) => { if (delay) await new Promise((r) => setTimeout(r, delay)); const d = docs.get(key(segs)); return d ? { id: segs.at(-1), ...d } : null; };
  const repo = {
    readProfile: (uid) => read(paths.user(uid)),
    readMembership: (h, uid) => read(paths.member(h, uid)),
    readHome: (h) => read(paths.home(h)),
    readRole: (h, r) => read(paths.role(h, r)),
    readGeneralSettings: (h) => read(paths.setting(h, 'general')),
  };
  const watchers = new Map();
  const watch = (segs, onValue, onError) => {
    const k = key(segs);
    watchers.set(k, { onValue, onError });
    return () => watchers.delete(k);
  };
  let authCb = null;
  const auth = {
    observeAuth: (cb) => { authCb = cb; return () => {}; },
    signIn: async (email, pw) => { if (pw !== 'right') throw new AppError(ErrorCode.INVALID_CREDENTIALS); authCb({ uid: 'u1', email, displayName: '' }); },
    signOutUser: async () => { authCb(null); },
    requestPasswordReset: async () => {},
  };
  let setupCalls = 0;
  const setup = {
    createHome: async (input) => {
      setupCalls++;
      const writes = buildSetupWrites({ ...input, homeId: 'h1', roles: defaultRoles(), now: 'NOW' });
      for (const w of writes) docs.set(key(w.path), w.mode === 'update' ? { ...docs.get(key(w.path)), ...w.data } : w.data);
      return 'h1';
    },
  };
  const store = createStore();
  const session = createSessionController({ store, auth, repo, setup, watch, paths, applyPreferences: () => {} });
  return { docs, key, store, session, auth, watchers, emitAuth: (u) => authCb(u), setupCalls: () => setupCalls };
}

function seedHome(env, { status = 'active', roleId = 'owner', withRole = true, withHome = true, defaultHomeId = 'h1' } = {}) {
  const { docs, key } = env;
  docs.set(key(paths.user('u1')), { email: 'a@b.c', displayName: 'Abdo', defaultHomeId, language: 'ar', theme: 'system' });
  if (withHome) docs.set(key(paths.home('h1')), { name: 'Adel Home', currency: 'EGP', timezone: 'Africa/Cairo', language: 'ar' });
  docs.set(key(paths.member('h1', 'u1')), { uid: 'u1', roleId, status });
  if (withRole) for (const r of defaultRoles()) docs.set(key(paths.role('h1', r.id)), r);
  docs.set(key(paths.setting('h1', 'general')), { weekStartsOn: 6 });
}

const USER = { uid: 'u1', email: 'a@b.c', displayName: '' };

test('signed out at start -> AUTH_REQUIRED with empty context', async () => {
  const env = makeEnv();
  env.session.start();
  env.emitAuth(null);
  assert.equal(env.store.get().status, S.AUTH_REQUIRED);
  assert.equal(env.store.get().home, null);
});

test('TEST A model: new user -> SETUP_REQUIRED -> setup -> READY as owner', async () => {
  const env = makeEnv();
  env.session.start();
  env.emitAuth(USER);
  assert.equal(env.store.get().status, S.RESOLVING_CONTEXT);
  await flush();
  assert.equal(env.store.get().status, S.SETUP_REQUIRED, 'missing profile is not an error');
  await env.session.completeSetup({ displayName: 'Abdo', homeName: 'Adel Home', language: 'ar', theme: 'system' });
  await flush();
  const s = env.store.get();
  assert.equal(s.status, S.READY);
  assert.equal(s.home.name, 'Adel Home');
  assert.equal(s.membership.roleId, 'owner');
  assert.equal(s.permissions.can('roles.edit'), true);
  assert.equal(env.setupCalls(), 1);
  assert.equal(env.watchers.size, 3, 'member, home and role are watched live');
});

test('TEST B model: returning user resolves straight to READY, no setup', async () => {
  const env = makeEnv();
  seedHome(env);
  env.session.start();
  env.emitAuth(USER);
  await flush();
  assert.equal(env.store.get().status, S.READY);
  assert.equal(env.setupCalls(), 0);
});

test('TEST C model: sign-out clears context and watchers; sign-in loads same home', async () => {
  const env = makeEnv();
  seedHome(env);
  env.session.start();
  env.emitAuth(USER);
  await flush();
  await env.session.signOut();
  const s = env.store.get();
  assert.equal(s.status, S.AUTH_REQUIRED);
  assert.equal(s.home, null);
  assert.equal(s.membership, null);
  assert.equal(s.role, null);
  assert.equal(s.permissions.can('home.view'), false);
  assert.equal(env.watchers.size, 0);
  await env.session.signIn('a@b.c', 'right');
  await flush();
  assert.equal(env.store.get().status, S.READY);
  assert.equal(env.store.get().home.id, 'h1');
});

test('wrong password -> AUTH_REQUIRED with INVALID_CREDENTIALS form error', async () => {
  const env = makeEnv();
  env.session.start();
  env.emitAuth(null);
  await env.session.signIn('a@b.c', 'wrong');
  assert.equal(env.store.get().status, S.AUTH_REQUIRED);
  assert.equal(env.store.get().formError.code, ErrorCode.INVALID_CREDENTIALS);
});

for (const [name, opts, code] of [
  ['default home missing', { defaultHomeId: null }, ErrorCode.DEFAULT_HOME_MISSING],
  ['membership inactive', { status: 'suspended' }, ErrorCode.MEMBERSHIP_INACTIVE],
  ['home not found', { withHome: false }, ErrorCode.HOME_NOT_FOUND],
  ['role missing', { withRole: false }, ErrorCode.ROLE_MISSING],
]) {
  test(`context error: ${name} -> ERROR ${code}`, async () => {
    const env = makeEnv();
    seedHome(env, opts);
    env.session.start();
    env.emitAuth(USER);
    await flush();
    assert.equal(env.store.get().status, S.ERROR);
    assert.equal(env.store.get().error.code, code);
  });
}

test('context error: membership missing', async () => {
  const env = makeEnv();
  seedHome(env);
  env.docs.delete(env.key(paths.member('h1', 'u1')));
  env.session.start();
  env.emitAuth(USER);
  await flush();
  assert.equal(env.store.get().error.code, ErrorCode.MEMBERSHIP_MISSING);
});

test('race: sign-out during slow resolution drops the stale result', async () => {
  const env = makeEnv({ delay: 20 });
  seedHome(env);
  env.session.start();
  env.emitAuth(USER);
  await env.session.signOut();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(env.store.get().status, S.AUTH_REQUIRED);
  assert.equal(env.store.get().home, null);
});

test('race: a second auth event supersedes the first resolution', async () => {
  const env = makeEnv({ delay: 20 });
  seedHome(env);
  env.session.start();
  env.emitAuth(USER);
  env.emitAuth(null);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(env.store.get().status, S.AUTH_REQUIRED);
});

test('live: membership suspended while READY -> ERROR MEMBERSHIP_INACTIVE', async () => {
  const env = makeEnv();
  seedHome(env);
  env.session.start();
  env.emitAuth(USER);
  await flush();
  env.watchers.get('homes/h1/members/u1').onValue({ id: 'u1', uid: 'u1', roleId: 'owner', status: 'suspended' });
  assert.equal(env.store.get().status, S.ERROR);
  assert.equal(env.store.get().error.code, ErrorCode.MEMBERSHIP_INACTIVE);
  assert.equal(env.store.get().permissions.can('home.view'), false);
});

test('live: role change re-resolves permissions without reload', async () => {
  const env = makeEnv();
  seedHome(env);
  env.session.start();
  env.emitAuth(USER);
  await flush();
  assert.equal(env.store.get().permissions.can('roles.edit'), true);
  env.watchers.get('homes/h1/members/u1').onValue({ id: 'u1', uid: 'u1', roleId: 'viewer', status: 'active' });
  const viewer = defaultRoles().find((r) => r.id === 'viewer');
  env.watchers.get('homes/h1/roles/viewer').onValue({ ...viewer });
  const s = env.store.get();
  assert.equal(s.status, S.READY);
  assert.equal(s.permissions.can('roles.edit'), false);
  assert.equal(s.permissions.can('expenses.view'), true);
});

test('live: home renamed elsewhere updates context', async () => {
  const env = makeEnv();
  seedHome(env);
  env.session.start();
  env.emitAuth(USER);
  await flush();
  env.watchers.get('homes/h1').onValue({ id: 'h1', name: 'Renamed', currency: 'EGP', timezone: 'Africa/Cairo', language: 'ar' });
  assert.equal(env.store.get().home.name, 'Renamed');
});

test('setup failure returns to SETUP_REQUIRED with SETUP_FAILED and nothing READY', async () => {
  const env = makeEnv();
  env.session.start();
  env.emitAuth(USER);
  await flush();
  const store = env.store;
  const failing = createSessionController({
    store, auth: env.auth, repo: {}, watch: () => () => {}, paths, applyPreferences: () => {},
    setup: { createHome: async () => { throw new AppError(ErrorCode.SETUP_FAILED); } },
  });
  await failing.completeSetup({ displayName: 'A', homeName: 'B' });
  assert.equal(store.get().status, S.SETUP_REQUIRED);
  assert.equal(store.get().formError.code, ErrorCode.SETUP_FAILED);
});

test('error recovery: create a new home after DEFAULT_HOME_MISSING keeps the profile', async () => {
  const env = makeEnv();
  seedHome(env, { defaultHomeId: null });
  env.session.start();
  env.emitAuth(USER);
  await flush();
  assert.equal(env.store.get().status, S.ERROR);
  env.session.startNewHome();
  assert.equal(env.store.get().status, S.SETUP_REQUIRED);
  assert.ok(env.store.get().profile, 'existing profile kept so setup UPDATES users/{uid}');
  await env.session.completeSetup({ displayName: 'Abdo', homeName: 'New', language: 'ar', theme: 'system' });
  await flush();
  assert.equal(env.store.get().status, S.READY);
});
