// Shared in-browser state for the fake SDK. Persisted to localStorage so page reloads
// behave like a real persisted Firebase session + database.
const DB_KEY = 'fake:db';
const AUTH_KEY = 'fake:auth';
export const USERS = {
  'owner@example.com': { uid: 'UID_OWNER', password: 'correct-horse', displayName: '' },
  // Phase 4: a second adult for privacy / restricted-role checks.
  'mona@example.com': { uid: 'UID_MONA', password: 'correct-horse', displayName: '' },
};
// Accounts created through the fake sign-up survive reloads (like real Firebase Auth).
try { Object.assign(USERS, JSON.parse(localStorage.getItem('fake:users') || '{}')); } catch { /* ignore */ }
export function persistUsers() {
  const extra = Object.fromEntries(Object.entries(USERS).filter(([e]) => !['owner@example.com', 'mona@example.com'].includes(e)));
  localStorage.setItem('fake:users', JSON.stringify(extra));
}

export const state = {
  db: JSON.parse(localStorage.getItem(DB_KEY) || '{}'),
  authUid: localStorage.getItem(AUTH_KEY) || null,
  docListeners: new Map(),
  authListeners: new Set(),
  writes: 0,
};
export function persist() {
  localStorage.setItem(DB_KEY, JSON.stringify(state.db));
  if (state.authUid) localStorage.setItem(AUTH_KEY, state.authUid); else localStorage.removeItem(AUTH_KEY);
}
export function notify(path) {
  // Notify listeners on the document AND on its parent collection (incl. queries on it).
  const parent = path.split('/').slice(0, -1).join('/');
  for (const [key, ls] of state.docListeners) {
    if (key === path || key === parent || key.startsWith(`${parent}?`)) for (const fn of [...ls]) fn();
  }
}
export function currentUser() {
  if (!state.authUid) return null;
  const [email, u] = Object.entries(USERS).find(([, v]) => v.uid === state.authUid);
  return { uid: u.uid, email, displayName: u.displayName || null };
}
// Test control surface.
window.__fake = {
  dump: () => JSON.parse(JSON.stringify(state.db)),
  paths: () => Object.keys(state.db).sort(),
  writes: () => state.writes,
  listenerCount: (path) => (state.docListeners.get(path) || new Set()).size,
  /** Total listeners on a collection path, including its queries. */
  listenerCountPrefix: (prefix) => [...state.docListeners].filter(([k]) => k === prefix || k.startsWith(`${prefix}?`)).reduce((n, [, v]) => n + v.size, 0),
  set(path, data) { state.db[path] = data; persist(); notify(path); },
  patch(path, data) { state.db[path] = { ...state.db[path], ...data }; persist(); notify(path); },
  totalOf: (prefix) => Object.entries(state.db).filter(([p, d]) => p.startsWith(prefix) && d.status !== 'void').reduce((s, [, d]) => s + (d.amountMinor || 0), 0),
  put(path, data) { state.db[path] = { ...data }; persist(); notify(path); },
  remove(path) { delete state.db[path]; persist(); notify(path); },
  /** V6.4.1 B: listeners on paths matching this regex (string) fail with 'unavailable'; null clears. Re-fires them. */
  failOn(re) { state.failOn = re || null; for (const ls of state.docListeners.values()) for (const fn of [...ls]) fn(); },
  /** V6.5 P02: simulate losing / regaining the connection. Offline: listeners report fromCache, writes stay pending. */
  setOffline(v) {
    state.offline = !!v;
    if (!v) { const ws = state.onlineWaiters || []; state.onlineWaiters = []; for (const w of ws) w(); }
    for (const ls of state.docListeners.values()) for (const fn of [...ls]) fn();
  },
  pendingPaths: () => Object.keys(state.pending || {}),
};
