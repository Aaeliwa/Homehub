/**
 * Application lifecycle state machine. Exactly one state at a time; transitions not in
 * the table are rejected. The Dashboard is only rendered in READY, which the session
 * controller enters only after auth, profile, home, membership, role and permissions
 * have all resolved.
 */
export const AppState = Object.freeze({
  BOOTING: 'BOOTING',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTHENTICATING: 'AUTHENTICATING',
  RESOLVING_CONTEXT: 'RESOLVING_CONTEXT',
  SETUP_REQUIRED: 'SETUP_REQUIRED',
  SETTING_UP: 'SETTING_UP',
  READY: 'READY',
  ERROR: 'ERROR',
});

const S = AppState;

/** from -> allowed targets. AUTH_REQUIRED is reachable from anywhere, including itself
 *  (sign-out, or the auth observer confirming a sign-out that already cleared the UI). */
const TRANSITIONS = Object.freeze({
  [S.BOOTING]: [S.AUTH_REQUIRED, S.RESOLVING_CONTEXT, S.ERROR],
  [S.AUTH_REQUIRED]: [S.AUTHENTICATING, S.RESOLVING_CONTEXT, S.ERROR],
  [S.AUTHENTICATING]: [S.AUTH_REQUIRED, S.RESOLVING_CONTEXT, S.ERROR],
  [S.RESOLVING_CONTEXT]: [S.READY, S.SETUP_REQUIRED, S.ERROR, S.AUTH_REQUIRED, S.RESOLVING_CONTEXT],
  [S.SETUP_REQUIRED]: [S.SETTING_UP, S.AUTH_REQUIRED, S.RESOLVING_CONTEXT],
  [S.SETTING_UP]: [S.RESOLVING_CONTEXT, S.SETUP_REQUIRED, S.AUTH_REQUIRED],
  [S.READY]: [S.RESOLVING_CONTEXT, S.ERROR, S.AUTH_REQUIRED],
  [S.ERROR]: [S.RESOLVING_CONTEXT, S.SETUP_REQUIRED, S.AUTH_REQUIRED],
});

export function canTransition(from, to) {
  if (to === S.AUTH_REQUIRED) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

export function allStates() { return Object.values(S); }
