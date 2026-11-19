/**
 * The one authentication service. Wraps Firebase Auth (modular SDK).
 *
 * - observe(cb): the single onAuthStateChanged subscription used by the session
 *   controller. Firebase restores the session from its own persistence on refresh.
 * - Credentials are passed straight to Firebase and never stored, cached or logged.
 */
import * as sdk from '../firebase/sdk.js';
import { getFirebase } from '../firebase/firebase.js';
import { toAppError, AppError, ErrorCode } from '../errors/app-error.js';

const auth = () => getFirebase().auth;

/** Minimal identity snapshot — the only auth data the rest of the app sees. */
export function toIdentity(user) {
  if (!user) return null;
  return Object.freeze({
    uid: user.uid,
    email: user.email || '',
    displayName: user.displayName || '',
  });
}

export function observeAuth(callback) {
  return sdk.onAuthStateChanged(auth(), (user) => callback(toIdentity(user)));
}

export async function signIn(email, password) {
  if (!email || !password) throw new AppError(ErrorCode.INVALID_CREDENTIALS);
  try {
    await sdk.signInWithEmailAndPassword(auth(), email.trim(), password);
  } catch (err) {
    throw toAppError(err, ErrorCode.AUTH_FAILED);
  }
}

/**
 * Phase 4A: create an email/password account (each person has their own identity).
 * The existing onAuthStateChanged observer then continues the normal lifecycle.
 */
export async function createAccount(email, password) {
  if (!email || !password) throw new AppError(ErrorCode.INVALID_CREDENTIALS);
  try {
    await sdk.createUserWithEmailAndPassword(auth(), email.trim(), password);
  } catch (err) {
    throw toAppError(err, ErrorCode.AUTH_FAILED);
  }
}

export async function signOutUser() {
  try {
    await sdk.signOut(auth());
  } catch (err) {
    throw toAppError(err, ErrorCode.AUTH_FAILED);
  }
}

/**
 * Sends a password-reset email. Resolves the same way whether or not the address has an
 * account, so the UI cannot be used to discover which emails are registered.
 */
export async function requestPasswordReset(email) {
  try {
    await sdk.sendPasswordResetEmail(auth(), email.trim());
  } catch (err) {
    const e = toAppError(err, ErrorCode.AUTH_FAILED);
    if (e.code === ErrorCode.NETWORK || e.code === ErrorCode.TOO_MANY_ATTEMPTS) throw e;
  }
}
