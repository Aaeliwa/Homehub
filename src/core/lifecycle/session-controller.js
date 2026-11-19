/**
 * The single authoritative session lifecycle.
 *
 *   onAuthStateChanged ──► signed out ─► AUTH_REQUIRED (context wiped)
 *                     └──► signed in ─► RESOLVING_CONTEXT ─► SETUP_REQUIRED | READY | ERROR
 *
 * Race safety: every auth change increments `generation`. Async work captures the
 * generation it started under and drops its result if a newer auth event (or sign-out)
 * happened meanwhile. There is exactly one onAuthStateChanged subscription.
 *
 * While READY, the membership, role and home documents are watched live, so a role
 * change, a deactivated membership or a home rename takes effect without a reload.
 */
import { AppState } from '../state/app-machine.js';
import { EMPTY_SESSION } from '../state/store.js';
import { resolveHomeContext, ContextResult } from '../home/context-resolver.js';
import { resolvePermissions } from '../permissions/resolver.js';
import { AppError, ErrorCode, toAppError, describeError } from '../errors/app-error.js';
import { log } from '../utils/logger.js';

export function createSessionController({ store, auth, repo, setup, watch, paths, applyPreferences, join = null, adoption = null }) {
  let generation = 0;
  let unsubscribeAuth = null;
  let watchers = [];

  const isCurrent = (gen) => gen === generation;
  const S = AppState;

  function stopWatchers() {
    for (const off of watchers) { try { off(); } catch { /* ignore */ } }
    watchers = [];
  }

  function fail(gen, err) {
    if (!isCurrent(gen)) return;
    const e = toAppError(err);
    log.warn('Context failed:', describeError(e));
    stopWatchers();
    store.transition(S.ERROR, {
      error: e,
      profile: e.profile !== undefined ? e.profile : store.get().profile,
      home: null,
      homeSettings: null,
      membership: null,
      role: null,
      permissions: EMPTY_SESSION.permissions,
    });
  }

  async function resolve(gen) {
    const { identity } = store.get();
    if (!identity) return;
    try {
      const result = await resolveHomeContext(identity, repo);
      if (!isCurrent(gen)) return;
      if (result.kind === ContextResult.SETUP) {
        store.transition(S.SETUP_REQUIRED, { ...EMPTY_SESSION, identity, profile: result.profile });
        return;
      }
      applyPreferences({ language: result.profile.language, theme: result.profile.theme });
      store.transition(S.READY, {
        profile: result.profile,
        home: result.home,
        homeSettings: result.homeSettings,
        membership: result.membership,
        role: result.role,
        permissions: result.permissions,
        error: null,
        formError: null,
      });
      log.info('Context ready');
      startWatchers(gen);
    } catch (err) {
      fail(gen, err);
    }
  }

  function startWatchers(gen) {
    stopWatchers();
    const { home, identity, membership } = store.get();
    const homeId = home.id;
    let roleOff = null;

    const onWatchError = (err) => {
      if (!isCurrent(gen)) return;
      log.warn('Live context listener failed:', describeError(err));
      // Re-run full resolution: it reports the precise reason (inactive, missing, …).
      store.transition(S.RESOLVING_CONTEXT, {});
      resolve(gen);
    };

    const watchRole = (roleId) => {
      if (roleOff) roleOff();
      roleOff = watch(paths.role(homeId, roleId), (role) => {
        if (!isCurrent(gen) || store.get().status !== S.READY) return;
        if (!role) return fail(gen, new AppError(ErrorCode.ROLE_MISSING));
        const permissions = resolvePermissions({ membership: store.get().membership, role });
        store.patch({ role, permissions });
      }, onWatchError);
    };

    watchers.push(watch(paths.member(homeId, identity.uid), (m) => {
      if (!isCurrent(gen) || store.get().status !== S.READY) return;
      if (!m) return fail(gen, new AppError(ErrorCode.MEMBERSHIP_MISSING));
      if (m.status !== 'active') return fail(gen, new AppError(ErrorCode.MEMBERSHIP_INACTIVE));
      const prevRoleId = store.get().membership.roleId;
      store.patch({ membership: m });
      if (m.roleId !== prevRoleId) watchRole(m.roleId);
    }, onWatchError));

    watchers.push(watch(paths.home(homeId), (h) => {
      if (!isCurrent(gen) || store.get().status !== S.READY) return;
      if (!h) return fail(gen, new AppError(ErrorCode.HOME_NOT_FOUND));
      store.patch({ home: h });
    }, onWatchError));

    watchRole(membership.roleId);
    watchers.push(() => roleOff && roleOff());
  }

  function handleAuth(identity) {
    const gen = ++generation;
    stopWatchers();
    if (!identity) {
      store.transition(S.AUTH_REQUIRED, { ...EMPTY_SESSION, formError: store.get().formError, notice: null });
      log.info('Signed out state');
      return;
    }
    log.info('Authenticated');
    store.transition(S.RESOLVING_CONTEXT, { ...EMPTY_SESSION, identity });
    resolve(gen);
  }

  return Object.freeze({
    start() {
      if (unsubscribeAuth) return;
      unsubscribeAuth = auth.observeAuth(handleAuth);
    },

    async signIn(email, password) {
      if (!store.transition(S.AUTHENTICATING, { formError: null, notice: null })) return;
      try {
        await auth.signIn(email, password);
        // onAuthStateChanged continues the flow.
      } catch (err) {
        if (store.get().status === S.AUTHENTICATING) {
          store.transition(S.AUTH_REQUIRED, { formError: toAppError(err) });
        }
      }
    },

    /** Phase 4A: create an account; the single auth observer continues the lifecycle. */
    async createAccount(email, password) {
      if (!store.transition(S.AUTHENTICATING, { formError: null, notice: null })) return;
      try {
        await auth.createAccount(email, password);
      } catch (err) {
        if (store.get().status === S.AUTHENTICATING) store.transition(S.AUTH_REQUIRED, { formError: toAppError(err) });
      }
    },

    /**
     * Phase 4A: accept an invitation. From first-time setup (no profile) this creates the
     * profile + membership and resolves into the joined home. From READY it joins without
     * changing the current home unless `makeDefault` (explicit switch) is requested.
     * Returns { homeId, homeName, switched } or throws an AppError.
     */
    async acceptInvite({ code, displayName, makeDefault = false, language, theme }) {
      const { identity, profile, status } = store.get();
      if (!identity || !join) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
      const fromSetup = status === S.SETUP_REQUIRED;
      if (fromSetup && !store.transition(S.SETTING_UP, { formError: null })) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
      const gen = generation;
      let result;
      try {
        result = await join.accept({ code, identity, displayName, profile, makeDefault, nowMillis: Date.now(), language, theme });
      } catch (err) {
        if (fromSetup && isCurrent(gen)) store.transition(S.SETUP_REQUIRED, { formError: toAppError(err, ErrorCode.SETUP_FAILED) });
        throw toAppError(err);
      }
      if (isCurrent(gen) && (fromSetup || result.switched)) {
        stopWatchers();
        store.transition(S.RESOLVING_CONTEXT, { formError: null });
        resolve(gen);
      }
      return result;
    },

    /** Phase 4A: make another home (where I am an active member) my default and load it. */
    async switchHome(homeId) {
      const { identity } = store.get();
      if (!identity || !join) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
      await join.setDefaultHome(identity.uid, homeId);
      const gen = ++generation;
      stopWatchers();
      store.transition(S.RESOLVING_CONTEXT, {});
      resolve(gen);
    },

    async requestPasswordReset(email) {
      try {
        await auth.requestPasswordReset(email);
        store.patch({ formError: null, notice: 'login.resetSent' });
      } catch (err) {
        store.patch({ formError: toAppError(err), notice: null });
      }
    },

    async signOut() {
      generation += 1; // invalidate any in-flight resolution immediately
      stopWatchers();
      try {
        await auth.signOutUser();
      } catch (err) {
        log.warn('Sign-out failed:', describeError(err));
      }
      // Clear runtime context even if Firebase was unreachable.
      store.transition(S.AUTH_REQUIRED, { ...EMPTY_SESSION });
    },

    async completeSetup({ displayName, homeName, language, theme }) {
      const { identity, profile } = store.get();
      if (!identity || !store.transition(S.SETTING_UP, { formError: null })) return;
      const gen = generation;
      try {
        await setup.createHome({
          identity, existingProfile: profile, displayName, homeName, language, theme,
        });
      } catch (err) {
        if (isCurrent(gen)) store.transition(S.SETUP_REQUIRED, { formError: toAppError(err, ErrorCode.SETUP_FAILED) });
        return;
      }
      if (!isCurrent(gen)) return;
      store.transition(S.RESOLVING_CONTEXT, { formError: null });
      resolve(gen);
    },

    /**
     * Phase 5.1: one-time upgrade of the creator's own pre-membership Home, then automatic
     * re-resolution (users → defaultHomeId → members → home → roles/owner → READY).
     * Same Home id, same defaultHomeId, no business data written.
     */
    async adoptLegacyHome() {
      const { identity, profile, error } = store.get();
      if (!identity || !profile || !adoption) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
      if (!error || error.code !== ErrorCode.LEGACY_HOME_ADOPTION_REQUIRED) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
      const gen = generation;
      // ERROR → RESOLVING_CONTEXT first (ERROR → ERROR is not a valid transition, so a failure
      // must come from RESOLVING_CONTEXT to be shown).
      if (!store.transition(S.RESOLVING_CONTEXT, { error: null })) return;
      try {
        await adoption.adopt({ identity, profile });
      } catch (err) {
        fail(gen, err);
        return;
      }
      if (isCurrent(gen)) resolve(gen);
    },

    retry() {
      const gen = generation;
      if (store.transition(S.RESOLVING_CONTEXT, { error: null })) resolve(gen);
    },

    /** From ERROR (e.g. default home deleted): start setup for a new home. */
    startNewHome() {
      const { identity, profile } = store.get();
      if (!identity) return;
      store.transition(S.SETUP_REQUIRED, { ...EMPTY_SESSION, identity, profile });
    },

    /** Apply a local profile change (after a successful write) without re-resolving. */
    updateProfile(patch) {
      const { profile, membership } = store.get();
      const next = { profile: { ...profile, ...patch } };
      if (patch.displayName && membership) next.membership = { ...membership, displayName: patch.displayName };
      store.patch(next);
    },

    updateHomeSettings(homeSettings) {
      store.patch({ homeSettings: { ...store.get().homeSettings, ...homeSettings } });
    },
  });
}
