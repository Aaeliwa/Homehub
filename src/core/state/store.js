/**
 * Minimal observable store holding the runtime session context. It is the single source
 * of truth for "who is signed in, which home, which role, which permissions".
 *
 * State is replaced immutably; subscribers get (state, previous).
 */
import { AppState, canTransition } from './app-machine.js';
import { NO_PERMISSIONS } from '../permissions/resolver.js';
import { log } from '../utils/logger.js';

/** Everything that must be wiped on sign-out. */
export const EMPTY_SESSION = Object.freeze({
  identity: null,      // { uid, email, displayName } from Firebase Auth
  profile: null,       // users/{uid}
  home: null,          // homes/{homeId}
  homeSettings: null,  // homes/{homeId}/settings/general
  membership: null,    // homes/{homeId}/members/{uid}
  role: null,          // homes/{homeId}/roles/{roleId}
  permissions: NO_PERMISSIONS,
  error: null,         // AppError for ERROR state
  formError: null,     // AppError shown inline on login/setup forms
  notice: null,        // non-error message for forms (e.g. reset email sent)
});

export function createStore() {
  let state = Object.freeze({ status: AppState.BOOTING, ...EMPTY_SESSION });
  const listeners = new Set();

  function emit(prev) {
    for (const fn of listeners) {
      try { fn(state, prev); } catch (err) { log.error('Store listener failed', err); }
    }
  }

  return Object.freeze({
    get: () => state,

    /** Change lifecycle state (validated) and merge a patch in one step. */
    transition(to, patch = {}) {
      const prev = state;
      if (!canTransition(prev.status, to)) {
        log.warn(`Ignored invalid transition ${prev.status} -> ${to}`);
        return false;
      }
      state = Object.freeze({ ...prev, ...patch, status: to });
      if (prev.status !== to) log.debug(`State ${prev.status} -> ${to}`);
      emit(prev);
      return true;
    },

    /** Merge data without changing lifecycle state (e.g. live home rename). */
    patch(patch) {
      const prev = state;
      state = Object.freeze({ ...prev, ...patch });
      emit(prev);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}
