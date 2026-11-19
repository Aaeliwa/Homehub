/**
 * THE ONLY FILE IN HOMEHUB THAT IMPORTS THE FIREBASE SDK.
 *
 * Everything else imports from here (or, better, from the shared services built on top).
 * Pinning the version in one place keeps app/auth/firestore in lock-step and lets tests
 * substitute the SDK by intercepting these three URLs.
 */
export { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';

export {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

export {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  limit,
  setDoc,
  updateDoc,
  writeBatch,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
