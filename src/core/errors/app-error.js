/**
 * One error vocabulary for the whole app. Services throw AppError; UI maps `code` to a
 * translated message (i18n key `error.<code>.title` / `.body`). Raw Firebase messages are
 * never shown to the user; they are kept in `cause` for development logging only.
 */
export const ErrorCode = Object.freeze({
  FIREBASE_INIT_FAILED: 'FIREBASE_INIT_FAILED',
  NETWORK: 'NETWORK',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  USER_DISABLED: 'USER_DISABLED',
  AUTH_FAILED: 'AUTH_FAILED',
  DEFAULT_HOME_MISSING: 'DEFAULT_HOME_MISSING',
  HOME_NOT_FOUND: 'HOME_NOT_FOUND',
  MEMBERSHIP_MISSING: 'MEMBERSHIP_MISSING',
  MEMBERSHIP_INACTIVE: 'MEMBERSHIP_INACTIVE',
  ROLE_MISSING: 'ROLE_MISSING',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SETUP_FAILED: 'SETUP_FAILED',
  /** A Home-scoped operation was attempted without a resolved Home (or after it ended). */
  CONTEXT_UNAVAILABLE: 'CONTEXT_UNAVAILABLE',
  /** Phase 5.1: the creator's own pre-membership Home — a one-time upgrade is available. */
  LEGACY_HOME_ADOPTION_REQUIRED: 'LEGACY_HOME_ADOPTION_REQUIRED',
  /** Phase 5.1: the creator's Home cannot be upgraded automatically (e.g. an Owner role already exists). */
  LEGACY_HOME_ADOPTION_BLOCKED: 'LEGACY_HOME_ADOPTION_BLOCKED',
  /** Phase 4A: account creation. */
  EMAIL_IN_USE: 'EMAIL_IN_USE',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  VALIDATION: 'VALIDATION',
  UNKNOWN: 'UNKNOWN',
});

export class AppError extends Error {
  constructor(code, { cause, detail } = {}) {
    super(code);
    this.name = 'AppError';
    this.code = ErrorCode[code] ? code : ErrorCode.UNKNOWN;
    this.cause = cause;
    /** Optional non-sensitive detail for logs (e.g. which step failed). */
    this.detail = detail;
  }
}

const AUTH_CODE_MAP = {
  'auth/email-already-in-use': ErrorCode.EMAIL_IN_USE,
  'auth/weak-password': ErrorCode.WEAK_PASSWORD,
  'auth/invalid-credential': ErrorCode.INVALID_CREDENTIALS,
  'auth/invalid-login-credentials': ErrorCode.INVALID_CREDENTIALS,
  'auth/wrong-password': ErrorCode.INVALID_CREDENTIALS,
  'auth/user-not-found': ErrorCode.INVALID_CREDENTIALS,
  'auth/invalid-email': ErrorCode.INVALID_CREDENTIALS,
  'auth/missing-password': ErrorCode.INVALID_CREDENTIALS,
  'auth/too-many-requests': ErrorCode.TOO_MANY_ATTEMPTS,
  'auth/user-disabled': ErrorCode.USER_DISABLED,
  'auth/network-request-failed': ErrorCode.NETWORK,
};

const FIRESTORE_CODE_MAP = {
  'permission-denied': ErrorCode.PERMISSION_DENIED,
  'unavailable': ErrorCode.NETWORK,
  'deadline-exceeded': ErrorCode.NETWORK,
};

/** Normalise any thrown value (Firebase error, AppError, anything) into an AppError. */
export function toAppError(err, fallback = ErrorCode.UNKNOWN) {
  if (err instanceof AppError) return err;
  const raw = err && typeof err.code === 'string' ? err.code : '';
  const code = AUTH_CODE_MAP[raw]
    || FIRESTORE_CODE_MAP[raw.replace(/^firestore\//, '')]
    || (raw.startsWith('auth/') ? ErrorCode.AUTH_FAILED : null)
    || (typeof navigator !== 'undefined' && navigator.onLine === false ? ErrorCode.NETWORK : null)
    || fallback;
  return new AppError(code, { cause: err });
}

/** Safe summary for logs: code + Firebase code, never the full error object payload. */
export function describeError(err) {
  const e = toAppError(err);
  const inner = e.cause && e.cause.code ? ` (${e.cause.code})` : '';
  return `${e.code}${inner}${e.detail ? ` — ${e.detail}` : ''}`;
}
