// TEST DOUBLE for firebase-auth.js. Email/password only.
import { state, persist, currentUser, USERS, persistUsers } from './store.js';

const err = (code) => Object.assign(new Error(code), { code });
export function getAuth() { return { kind: 'fake-auth' }; }
export function onAuthStateChanged(auth, cb) {
  state.authListeners.add(cb);
  setTimeout(() => cb(currentUser()), 30); // async, like the real SDK restoring a session
  return () => state.authListeners.delete(cb);
}
function emit() { for (const cb of state.authListeners) cb(currentUser()); }
export async function signInWithEmailAndPassword(auth, email, password) {
  await new Promise((r) => setTimeout(r, 150));
  const u = USERS[email];
  if (!u || u.password !== password) throw err('auth/invalid-credential');
  state.authUid = u.uid; persist(); emit();
  return { user: currentUser() };
}
export async function createUserWithEmailAndPassword(auth, email, password) {
  await new Promise((r) => setTimeout(r, 120));
  if (USERS[email]) throw err('auth/email-already-in-use');
  if (!password || password.length < 6) throw err('auth/weak-password');
  USERS[email] = { uid: `UID_${email.split('@')[0].toUpperCase()}`, password, displayName: '' };
  persistUsers();
  state.authUid = USERS[email].uid; persist(); emit();
  return { user: currentUser() };
}
export async function signOut() { state.authUid = null; persist(); emit(); }
export async function sendPasswordResetEmail() { await new Promise((r) => setTimeout(r, 50)); }
