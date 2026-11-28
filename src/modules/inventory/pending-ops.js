/**
 * Pantry (V6.5 P02) — registry of UNRESOLVED stock operations, per device, keyed by (uid, homeId).
 *
 * Why: a stock write whose outcome is unknown must stay visible and reviewable even after the store that sent it is
 * disposed (Home switch, sign-out, page unmount) or the page is reloaded. The registry holds the exact submitted
 * intent (the expected movement at its deterministic id), so a later SERVER read can decide: our movement is there
 * (confirmed), another movement is there (conflict) or nothing is there (not applied). It never triggers a write.
 *
 * Storage: an in-memory map (survives store disposal within the page) mirrored to localStorage (survives reload).
 * localStorage can be unavailable or throw (private mode, blocked site data): every access is guarded and the
 * in-memory copy still works for the page's lifetime. A record is removed as soon as its outcome is known.
 *
 * "settled": the commit promise has finished (resolved or rejected). A record written by an EARLIER page load is
 * treated as settled — that page's Firestore instance (memory cache only, no persistence) and its write queue are
 * gone. Limitation: another OPEN tab of the same user may still hold a queued write for that record; the
 * deterministic id + stockRev precondition keep the data correct, only the reported verdict could be early.
 *
 * Privacy: a record contains the product id, amounts and the optional note of the user's OWN pending change on THIS
 * device. It is deleted when resolved; records are capped per (uid, home) and dropped when malformed.
 */
import { MOVEMENT_KEYS, OP_ID_RE, movementId as movId } from './stock-model.js';
import { ID_RE } from './product-model.js';

const PREFIX = 'homehub.pantry.pendingStock.v1';
export const MAX_RECORDS = 50;
/** A random id for this page load (module instance). */
export const PAGE_ID = (() => { try { const b = new Uint8Array(8); globalThis.crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); } catch { return String(Math.random()).slice(2); } })();

const memory = new Map();                       // key → Map(operationId → record)
const usedOperationIds = new Set();             // every operationId submitted from this page (never reused)
const key = (uid, homeId) => `${PREFIX}.${uid}.${homeId}`;
let store = (() => { try { return globalThis.localStorage || null; } catch { return null; } })();
/** Tests: swap the backing storage (null = memory only). */
export function _setStorage(s) { store = s; memory.clear(); }

function valid(r) {
  if (!r || typeof r !== 'object') return false;
  const m = r.expected;
  return typeof r.productId === 'string' && ID_RE.test(r.productId) && typeof r.operationId === 'string' && OP_ID_RE.test(r.operationId)
    && m && typeof m === 'object' && MOVEMENT_KEYS.every((k) => k in m) && Object.keys(m).length === MOVEMENT_KEYS.length
    && m.productId === r.productId && m.operationId === r.operationId && Number.isInteger(m.stockRev) && m.stockRev >= 1
    && r.movementId === movId(r.productId, m.stockRev) && Number.isInteger(r.baseStockRev) && r.baseStockRev === m.stockRev - 1
    && typeof r.pageId === 'string';
}
function readStorage(k) {
  if (!store) return [];
  try { const v = JSON.parse(store.getItem(k) || '[]'); return Array.isArray(v) ? v.filter(valid) : []; } catch { return []; }
}
function writeStorage(k, list) {
  if (!store) return;
  try { if (list.length) store.setItem(k, JSON.stringify(list)); else store.removeItem(k); } catch { /* quota / blocked: memory copy remains */ }
}
function bucket(uid, homeId) {
  const k = key(uid, homeId);
  if (!memory.has(k)) {
    const m = new Map();
    for (const r of readStorage(k)) m.set(r.operationId, r);
    memory.set(k, m);
  }
  return memory.get(k);
}
const persist = (uid, homeId) => writeStorage(key(uid, homeId), [...bucket(uid, homeId).values()]);

/** All unresolved records for (uid, home); records of an earlier page load are reported as settled. */
export function listOps(uid, homeId) {
  if (!uid || !homeId) return [];
  return [...bucket(uid, homeId).values()].map((r) => ({ ...r, settled: r.settled || r.pageId !== PAGE_ID }));
}
export function getOp(uid, homeId, operationId) {
  return listOps(uid, homeId).find((r) => r.operationId === operationId) || null;
}
/** Record an operation BEFORE its commit is sent. The server timestamp is not serialisable: `at` is stored as null. */
export function addOp(uid, homeId, { productId, operationId, movementId, expected, baseStockRev, trackMode }) {
  const b = bucket(uid, homeId);
  const rec = { productId, operationId, movementId, expected: { ...expected, at: null }, baseStockRev, trackMode, settled: false, pageId: PAGE_ID, createdAt: Date.now() };
  if (!valid(rec)) throw Object.assign(new Error('pantry.err.opId'), { code: 'validation', detail: 'pantry.err.opId' });
  b.set(operationId, rec);
  while (b.size > MAX_RECORDS) b.delete(b.keys().next().value);   // oldest first
  usedOperationIds.add(operationId);
  persist(uid, homeId);
  return rec;
}
export function markSettled(uid, homeId, operationId) {
  const r = bucket(uid, homeId).get(operationId);
  if (r && !r.settled) { r.settled = true; persist(uid, homeId); }
}
export function removeOp(uid, homeId, operationId) {
  if (bucket(uid, homeId).delete(operationId)) persist(uid, homeId);
}
/** True if this operationId was ever submitted from this page or is still recorded for this user / Home. */
export function isUsedOperationId(uid, homeId, operationId) {
  return usedOperationIds.has(operationId) || bucket(uid, homeId).has(operationId);
}

// ------------------------------------------------------------------- recently CONFIRMED changes (repeat guard)
// A repeated identical change (same product, type and amount / target) within REPEAT_WINDOW_MS needs an explicit
// "record it again" confirmation. Memory only (per page). This is a usability guard, not a security control.
export const REPEAT_WINDOW_MS = 120000;
const recent = new Map();                       // key → [{ productId, sig, at }]
/** add / remove → same signed amount; correction → same counted target; presence type → same target state. */
export const intentSig = (m) => (m.type === 'add' || m.type === 'remove' ? `${m.type}|${m.deltaMilli}`
  : m.type === 'correction' ? `correction|${m.afterMilli}` : `presence|${m.afterPresence}`);
export function noteConfirmed(uid, homeId, movement, now = Date.now()) {
  const k = key(uid, homeId); const list = (recent.get(k) || []).filter((r) => now - r.at < REPEAT_WINDOW_MS);
  list.push({ productId: movement.productId, sig: intentSig(movement), at: now });
  recent.set(k, list.slice(-50));
}
export function isRecentRepeat(uid, homeId, productId, movementLike, now = Date.now()) {
  const sig = intentSig(movementLike);
  return (recent.get(key(uid, homeId)) || []).some((r) => r.productId === productId && r.sig === sig && now - r.at < REPEAT_WINDOW_MS);
}
/** Tests only. */
export function _resetAll() { memory.clear(); usedOperationIds.clear(); recent.clear(); }
