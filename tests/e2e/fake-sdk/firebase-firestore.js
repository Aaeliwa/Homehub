// TEST DOUBLE for firebase-firestore.js. In-memory documents with a MINIMAL membership
// check on home/role reads (so error states can be exercised). It is NOT the real rules
// engine; security rules are tested separately against the Firestore emulator.
import { state, persist, notify, currentUser } from './store.js';

const SENTINEL = '__serverTimestamp__';
const err = (code) => Object.assign(new Error(code), { code });
const join = (segs) => segs.join('/');
let autoId = 0;

export function getFirestore() { return { kind: 'fake-db' }; }
export function serverTimestamp() { return SENTINEL; }
export function collection(db, ...segs) { return { type: 'collection', path: join(segs) }; }
// Phase 4: single-constraint queries (== and array-contains), as used by the finance store.
export function where(field, op, value) { return { field, op, value }; }
// V6.4 B: query(col, where?, limit?) — constraints in any order (contacts use where + limit).
export function limit(n) { return { limit: n }; }
// V6.5 P02: orderBy (pantry history: productId == + stockRev desc + limit).
export function orderBy(field, dir = 'asc') { return { orderBy: field, dir }; }
export function query(col, ...cs) {
  return { type: 'query', path: col.path, where: cs.find((c) => c && 'field' in c), limit: (cs.find((c) => c && 'limit' in c) || {}).limit, order: cs.find((c) => c && 'orderBy' in c) || null };
}
function matchesWhere(d, w) {
  if (!w) return true;
  const v = d[w.field]; // like Firestore: a missing field never matches
  if (w.op === '==') return v === w.value;
  if (w.op === 'array-contains') return Array.isArray(v) && v.includes(w.value);
  // Phase 5.3: single-field range queries (cleaning occurrences window).
  // Phase 5.4a: Date values (audit-log `at` ranges) compare as instants; the fake stores ISO strings.
  if (w.value instanceof Date) { const ms = Date.parse(v); const at = w.value.getTime(); if (Number.isNaN(ms)) return false;
    return w.op === '>=' ? ms >= at : w.op === '<=' ? ms <= at : w.op === '>' ? ms > at : w.op === '<' ? ms < at : false; }
  if (w.op === '>=') return v !== undefined && v >= w.value;
  if (w.op === '<=') return v !== undefined && v <= w.value;
  if (w.op === '>') return v !== undefined && v > w.value;
  if (w.op === '<') return v !== undefined && v < w.value;
  throw new Error(`fake: unsupported op ${w.op}`);
}
export function doc(first, ...segs) {
  if (first && first.type === 'collection' && segs.length === 0) {
    autoId += 1;
    return { type: 'doc', path: `${first.path}/AUTO${Date.now().toString(36)}${autoId}`, get id() { return this.path.split('/').pop(); } };
  }
  const path = join(segs);
  return { type: 'doc', path, id: path.split('/').pop() };
}

function resolveTs(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === SENTINEL ? new Date().toISOString() : v;
  return out;
}
// V6.5 P02: local (not yet acknowledged) writes made while "offline" live in state.pending and are shown with
// metadata.hasPendingWrites, like the real SDK's latency compensation; state.db stays the SERVER truth.
function view(path) { return state.pending && path in state.pending ? state.pending[path] : state.db[path]; }
function snap(path, { server = false } = {}) {
  const d = server ? state.db[path] : view(path);
  return { id: path.split('/').pop(), exists: () => d !== undefined, data: () => (d ? { ...d } : undefined),
    metadata: { hasPendingWrites: !server && !!(state.pending && path in state.pending), fromCache: !server && !!state.offline } };
}
function checkRead(path) {
  const user = currentUser();
  if (!user) throw err('permission-denied');
  const p = path.split('/');
  if (p[0] === 'users' && p[1] !== user.uid) throw err('permission-denied');
  if (p[0] === 'homes') {
    const ownMember = p[2] === 'members' && p[3] === user.uid;
    const m = state.db[`homes/${p[1]}/members/${user.uid}`];
    // Phase 5.1 (mirrors firestore.rules): the STORED creator of a home may get the home doc and
    // individual role docs while having no membership there (legacy adoption detection).
    const home = state.db[`homes/${p[1]}`];
    const creatorDetect = !m && home && home.createdBy === user.uid && (p.length === 2 || (p[2] === 'roles' && p.length === 4));
    if (!ownMember && !creatorDetect && !(m && m.status === 'active')) throw err('permission-denied');
  }
}

function contactPerms(path) {
  const user = currentUser(); const home = path.split('/')[1]; const m = state.db[`homes/${home}/members/${user.uid}`];
  return ((m && state.db[`homes/${home}/roles/${m.roleId}`]) || {}).permissions || [];
}
export async function getDoc(ref) {
  await new Promise((r) => setTimeout(r, 20));
  checkRead(ref.path);
  // V6.4 B rev 2 (mirrors firestore.rules): a soft-deleted contact is readable with contacts.delete only
  if (/^homes\/[^/]+\/contacts\/[^/]+$/.test(ref.path) && state.db[ref.path] && state.db[ref.path].deleted === true) {
    const perms = contactPerms(ref.path);
    if (!(perms.includes('*') || perms.includes('contacts.*') || perms.includes('contacts.delete'))) throw err('permission-denied');
  }
  return snap(ref.path);
}
/** V6.5 P02: server-confirmed read — never from the cache; rejects while offline (like the real SDK). */
export async function getDocFromServer(ref) {
  await new Promise((r) => setTimeout(r, 20));
  if (state.offline || window.__fakeServerDown) throw err('unavailable');
  checkRead(ref.path);
  return snap(ref.path, { server: true });
}
export async function getDocs(col) {
  checkRead(col.path + '/x');
  if (col.type === 'query') { checkQuery(col); return collectionSnap(col.path, col.where, col.limit, col.order); }
  if (/\/(contacts|contactCategories)$/.test(col.path)) checkQuery({ path: col.path, where: null });
  const depth = col.path.split('/').length + 1;
  const docs = Object.keys(state.db).filter((p) => p.startsWith(col.path + '/') && p.split('/').length === depth).map(snap);
  return { docs };
}
function collectionSnap(path, w, max, order = null) {
  const depth = path.split('/').length + 1;
  const keys = [...new Set([...Object.keys(state.db), ...Object.keys(state.pending || {})])];
  let paths = keys.filter((p) => p.startsWith(path + '/') && p.split('/').length === depth && view(p) !== undefined && matchesWhere(view(p), w)).sort();
  if (order) { const f = order.orderBy; const sgn = order.dir === 'desc' ? -1 : 1; paths = paths.sort((a, b) => sgn * ((view(a)[f] > view(b)[f]) - (view(a)[f] < view(b)[f]))); }
  const docs = paths.map((p) => snap(p));
  const out = Number.isInteger(max) ? docs.slice(0, max) : docs;
  return { docs: out, metadata: { fromCache: !!state.offline, hasPendingWrites: out.some((d) => d.metadata.hasPendingWrites) } };
}
/**
 * Query privacy, mirroring what firestore.rules allow for finance listeners, so the E2E
 * privacy checks are meaningful (the real enforcement is tested in the emulator suite):
 *   readers array-contains X → only for X == the signed-in uid
 *   audience/visibility == 'household' → only if the caller's role grants expenses.view
 */
function checkQuery(q) {
  const user = currentUser();
  // V6.5 P01 / P02 (mirrors firestore.rules): the Pantry catalog and stock history need inventory.view in THIS home.
  if (/\/(pantryProducts|pantryMovements)$/.test(q.path)) {
    const home = q.path.split('/')[1]; const m = state.db[`homes/${home}/members/${user.uid}`];
    const perms = ((m && m.status === 'active' && state.db[`homes/${home}/roles/${m.roleId}`]) || {}).permissions || [];
    if (!(perms.includes('*') || perms.includes('inventory.*') || perms.includes('inventory.view'))) throw err('permission-denied');
  }
  // V6.4 B (mirrors firestore.rules): shared contacts / categories need contacts.view in THIS home.
  if (/\/(contacts|contactCategories)$/.test(q.path)) {
    const home = q.path.split('/')[1]; const m = state.db[`homes/${home}/members/${user.uid}`];
    const perms = ((m && state.db[`homes/${home}/roles/${m.roleId}`]) || {}).permissions || [];
    if (!(perms.includes('*') || perms.includes('contacts.*') || perms.includes('contacts.view'))) throw err('permission-denied');
    // V6.4 B rev 2: contact queries not constrained to deleted == false need contacts.delete
    const w0 = q.where || {};
    if (/\/contacts$/.test(q.path) && !(w0.field === 'deleted' && w0.op === '==' && w0.value === false)
      && !(perms.includes('*') || perms.includes('contacts.*') || perms.includes('contacts.delete'))) throw err('permission-denied');
  }
  const w = q.where || {};
  if (w.field === 'readers' && (w.op !== 'array-contains' || w.value !== user.uid)) throw err('permission-denied');
  if ((w.field === 'audience' || w.field === 'visibility') && w.value === 'household') {
    const home = q.path.split('/')[1];
    const m = state.db[`homes/${home}/members/${user.uid}`];
    const role = m && state.db[`homes/${home}/roles/${m.roleId}`];
    const perms = (role && role.permissions) || [];
    // Phase 5: savings collections are gated by savings.view; finance ones by expenses.view.
    const ns = /\/(savingsAssets|savingsEvents)$/.test(q.path) ? 'savings' : /\/(calendarEvents|calendarImports)$/.test(q.path) ? 'calendar' : 'expenses';   // V6.4.1 B: calendar.view, as the rules
    if (!(perms.includes('*') || perms.includes(`${ns}.*`) || perms.includes(`${ns}.view`))) throw err('permission-denied');
  }
}
/** Phase 5: rules are not filters — an UNCONSTRAINED listener on a private collection is denied. */
const PRIVATE_COLLECTIONS = /\/(savingsAssets|savingsEvents|zakatRecords|wallets|expenses|walletMovements|spendingCycles|commitments)$/;
function checkCollection(path) { if (PRIVATE_COLLECTIONS.test(path)) throw err('permission-denied'); }
export function onSnapshot(ref, a, b, c) {
  // V6.5 P02: onSnapshot(ref, { includeMetadataChanges }, next, error) as well as onSnapshot(ref, next, error).
  const [next, onError] = typeof a === 'function' ? [a, b] : [b, c];
  const isCol = ref.type === 'collection' || ref.type === 'query';
  const fire = () => {
    try {
      // V6.4.1 B test control: simulate a backend failure for listeners on matching paths (error states)
      if (state.failOn && new RegExp(state.failOn).test(ref.path)) throw err('unavailable');
      checkRead(isCol ? ref.path + '/x' : ref.path);
      if (ref.type === 'query') checkQuery(ref);
      else if (ref.type === 'collection') checkCollection(ref.path);
      next(isCol ? collectionSnap(ref.path, ref.where, ref.limit, ref.order) : snap(ref.path));
    }
    catch (e) { onError && onError(e); }
  };
  if (!state.docListeners.has(ref.path)) state.docListeners.set(ref.path, new Set());
  state.docListeners.get(ref.path).add(fire);
  setTimeout(fire, 0);
  return () => state.docListeners.get(ref.path)?.delete(fire);
}
export async function setDoc(ref, data) {
  await new Promise((r) => setTimeout(r, 40));
  state.db[ref.path] = resolveTs(data);
  state.writes += 1; persist(); notify(ref.path);
}
export async function updateDoc(ref, data) {
  if (!state.db[ref.path]) throw err('not-found');
  state.db[ref.path] = { ...state.db[ref.path], ...resolveTs(data) };
  state.writes += 1; persist(); notify(ref.path);
}
export function writeBatch() {
  const ops = [];
  return {
    set(ref, data) { ops.push(['set', ref.path, data]); },
    update(ref, data) { ops.push(['update', ref.path, data]); },
    delete(ref) { ops.push(['delete', ref.path]); },   // Phase 5.6
    async commit() {
      // V6.5 P02: offline → the write is applied locally as PENDING (listeners see hasPendingWrites) and the promise does
      // not settle until the connection returns; then the server-side checks below run as usual.
      if (state.offline || window.__fakeHoldNextCommit) {
        window.__fakeHoldNextCommit = false;   // test control: "the network dropped right after submit" (released by setOffline(false))
        state.pending = state.pending || {};
        for (const [op, path, data] of ops) if (op !== 'delete') state.pending[path] = op === 'set' ? resolveTs(data) : { ...(view(path) || {}), ...resolveTs(data) };
        for (const [, path] of ops) notify(path);
        await new Promise((res) => { (state.onlineWaiters = state.onlineWaiters || []).push(res); });
        for (const [, path] of ops) { delete state.pending[path]; notify(path); }
      }
      // Phase 5.3.2: emulate the real SDK's OPTIMISTIC local writes — new docs appear in listeners
      // immediately and are ROLLED BACK if the server rejects the request (the visible production symptom).
      const optimistic = window.__fakeOptimistic ? ops.filter(([op, path]) => op === 'set' && !state.db[path]).map(([, path, data]) => path) : [];
      for (const p of optimistic) { state.db[p] = { ...resolveTs(ops.find((o) => o[1] === p)[2]), __pending: true }; notify(p); }
      const rollback = () => { for (const p of optimistic) { delete state.db[p]; notify(p); } };
      await new Promise((r) => setTimeout(r, 120));
      try {
        if (window.__fakeFailNextCommit) { window.__fakeFailNextCommit = false; throw err('permission-denied'); }
        // Per-request rule limits (Firestore evaluates its limits over the WHOLE batch).
        if (Number.isFinite(window.__fakeMaxOpsPerCommit) && ops.length > window.__fakeMaxOpsPerCommit) throw err('permission-denied');
        if ((window.__fakeDenyIds || []).some((id) => ops.some(([, path]) => path.endsWith('/' + id)))) throw err('permission-denied');
      } catch (e) { rollback(); throw e; }
      for (const p of optimistic) delete state.db[p];
      for (const [op, path] of ops) if (op === 'update' && !state.db[path]) throw err('not-found');
      checkAdoption(ops);
      checkPantryStock(ops);
      // Mirrors the rules: an expense id that already exists cannot be "created" again
      // (e.g. paying the same commitment due date twice).
      // Create-only collections (mirrors the rules): re-creating an existing doc is refused.
      for (const [op, path] of ops) if (op === 'set' && /\/(expenses|cleaningTasks|cleaningOccurrences|cleaningLog|budgetAdjustments|contacts|contactCategories)\//.test(path) && state.db[path]) throw err('permission-denied');
      // V6.4 B (mirrors the rules): a contact update must carry rev = stored rev + 1 (stale edits / merges refused).
      for (const [op, path, data] of ops) if (op === 'update' && /\/contacts\//.test(path) && state.db[path] && data.rev !== state.db[path].rev + 1) throw err('permission-denied');
      // Mirrors the rules — deletes are allowed ONLY for owner-only reminder state (5.6), cooking timers (V6.1) and contact categories (V6.4 B).
      for (const [op, path] of ops) if (op === 'delete' && !/\/(reminderStates|reminderPrefs|cookingTimers|contactCategories)\//.test(path)) throw err('permission-denied');
      for (const [op, path, data] of ops) {
        if (op === 'delete') { delete state.db[path]; state.writes += 1; continue; }
        state.db[path] = op === 'set' ? resolveTs(data) : { ...state.db[path], ...resolveTs(data) };
        state.writes += 1;
      }
      persist();
      for (const [, path] of ops) notify(path);
      // V6.5 P02 test control: the server applied the batch but the acknowledgement was lost (the SDK reports a failure).
      if (window.__fakeLoseAckNext) { window.__fakeLoseAckNext = false; throw err('permission-denied'); }
    },
  };
}

/**
 * V6.5 P02 — mirror of the pantry stock rules (the authoritative proof is the emulator suite, V65P02-*): a stock update
 * (stockRev in the mask) must be stockRev + 1 on an ACTIVE product, never change rev, and come with a NEW movement at
 * {pid}_s{stockRev} in the same batch; a movement is never written alone; correction needs inventory.adjust, the other
 * types inventory.edit, all need inventory.view.
 */
function checkPantryStock(ops) {
  const user = currentUser();
  const perms = (home) => { const m = state.db[`homes/${home}/members/${user && user.uid}`]; return ((m && m.status === 'active' && state.db[`homes/${home}/roles/${m.roleId}`]) || {}).permissions || []; };
  const can = (home, a) => { const p = perms(home); return p.includes('*') || p.includes('inventory.*') || p.includes(`inventory.${a}`); };
  for (const [op, path, data] of ops) {
    const mp = /^homes\/([^/]+)\/pantryProducts\/([^/]+)$/.exec(path);
    if (mp && op === 'update' && data && 'stockRev' in data) {
      const cur = state.db[path]; const movPath = `homes/${mp[1]}/pantryMovements/${mp[2]}_s${data.stockRev}`;
      const mov = ops.find(([o, p]) => o === 'set' && p === movPath);
      const ok = cur && cur.archived === false && data.stockRev === cur.stockRev + 1 && !('rev' in data) && mov && !state.db[movPath]
        && Object.keys(data).every((k) => ['stockMilli', 'presence', 'stockRev', 'updatedBy', 'updatedAt'].includes(k))
        && mov[2].beforeMilli === (cur.trackMode === 'quantity' ? cur.stockMilli : null) && mov[2].actorUid === user.uid
        && can(mp[1], 'view') && can(mp[1], mov[2].type === 'correction' ? 'adjust' : 'edit');
      if (!ok) throw err('permission-denied');
    }
    const mm = /^homes\/([^/]+)\/pantryMovements\/(.+)_s(\d+)$/.exec(path);
    if (/\/pantryMovements\//.test(path)) {
      if (op !== 'set' || !mm || state.db[path]) throw err('permission-denied');
      const pPath = `homes/${mm[1]}/pantryProducts/${mm[2]}`;
      if (!ops.some(([o, p, d]) => o === 'update' && p === pPath && d && d.stockRev === Number(mm[3]))) throw err('permission-denied');
    }
  }
}

/**
 * Phase 5.1 — mirror of the legacy-adoption rule invariants, so the browser attacker/idempotency
 * flows are meaningful here (the authoritative proof is the emulator suite, L1–L20).
 */
function checkAdoption(ops) {
  const adopt = ops.find(([op, path, data]) => op === 'set' && /^homes\/[^/]+\/members\/[^/]+$/.test(path) && data && data.legacyAdoption === true);
  if (!adopt) return;
  const user = currentUser();
  const [, mPath, m] = adopt;
  const homeId = mPath.split('/')[1];
  const home = state.db[`homes/${homeId}`];
  const profile = user && state.db[`users/${user.uid}`];
  const ok = user && home && home.createdBy === user.uid && mPath.endsWith(`/members/${user.uid}`)
    && m.uid === user.uid && m.roleId === 'owner' && m.status === 'active' && m.addedBy === user.uid
    && profile && profile.defaultHomeId === homeId
    && !state.db[mPath] && !state.db[`homes/${homeId}/roles/owner`]
    && ops.some(([, p]) => p === `homes/${homeId}/roles/owner`)
    && ops.every(([op, p]) => op === 'set' && (p === mPath || p.startsWith(`homes/${homeId}/roles/`)) && !state.db[p]);
  if (!ok) throw err('permission-denied');
}
