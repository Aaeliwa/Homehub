/**
 * Pantry stock (V6.5 Phase 02) — PURE model. Mirrors the pantryProducts stock branch and the pantryMovements rules.
 *
 * A stock change is ONE atomic batch for ONE product:
 *   product update  — mask stockMilli | presence, stockRev (+1), updatedBy, updatedAt.  `rev` (catalog) is untouched.
 *   movement create — homes/{h}/pantryMovements/{productId}_s{stockRev}, immutable, exact keys (MOVEMENT_KEYS).
 * The deterministic id + "stockRev must be stored + 1" is the concurrency precondition: of two writers that read the
 * same stockRev, only the first commit can succeed (the second movement id already exists; the product moved on).
 *
 * Stock state semantics (Phase 01 documents are used exactly as stored — nothing is rewritten):
 *   quantity product, stockRev 0  → UNRECORDED (its stored 0 is "never counted", not "verified empty").
 *   presence product, presence null → UNRECORDED.
 * The first movement establishes a known state; a correction with reason may record a first count of zero.
 * Operations: add / remove (positive amount, ≤ MAX_STEP_MILLI, no overdraft, no clipping), correction (absolute counted
 * amount, mandatory reason, no no-op except the first count), presence (in / low / out, no same-state no-op).
 * All arithmetic is on integer milli base units (units.js); there is no floating point and no cross-dimension conversion.
 */
import { parseQuantity, formatQuantity, convertible, isBaseMilli, MAX_BASE_MILLI } from './units.js';

export const STOCK_TYPES = Object.freeze(['add', 'remove', 'correction', 'presence']);
export const PRESENCE_VALUES = Object.freeze(['in', 'low', 'out']);
/** Roadmap bound for one add / remove: 10^9 milli base (1,000 kg / l, 1,000,000 pieces). Corrections are bounded by MAX_BASE_MILLI. */
export const MAX_STEP_MILLI = 1000000000;
export const NOTE_MAX = 200;
/** On-demand "recent history": newest first, this many movements (index productId ASC, stockRev DESC). */
export const HISTORY_LIMIT = 50;
/** Product fields a stock write may change (rules: changed().hasOnly(STOCK_MASK)). */
export const STOCK_MASK = Object.freeze(['stockMilli', 'presence', 'stockRev', 'updatedBy', 'updatedAt']);
/** Every key of a movement document (rules: exactKeys). Phase 00 D.2 + beforePresence / afterPresence / dimension / operationId. */
export const MOVEMENT_KEYS = Object.freeze(['productId', 'stockRev', 'type', 'beforeMilli', 'deltaMilli', 'afterMilli', 'requestedMilli', 'unfulfilledMilli', 'note',
  'ruleRev', 'segment', 'occFrom', 'occTo', 'coveredMilli', 'tripId', 'line', 'cookId', 'actorUid', 'at', 'schemaVersion',
  'beforePresence', 'afterPresence', 'dimension', 'operationId']);
/** Future provenance fields (consumption / purchase / cook) and their NEUTRAL values in Phase 02 (D.2: coveredMilli 0, the rest null). */
export const NEUTRAL_FUTURE = Object.freeze({ ruleRev: null, segment: null, occFrom: null, occTo: null, coveredMilli: 0, tripId: null, line: null, cookId: null });
export const OP_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const fail = (detail) => Object.assign(new Error(detail), { code: 'validation', detail });
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s) => (typeof s === 'string' ? s.replace(CTRL, '').replace(/\s+/g, ' ').trim() : '');

export const movementId = (productId, stockRev) => `${productId}_s${stockRev}`;
export const isQuantity = (p) => !!(p && p.trackMode === 'quantity');
export const isRecorded = (p) => !!(p && Number.isInteger(p.stockRev) && p.stockRev > 0);

/**
 * Display status of a product's stock:
 *   quantity: 'unrecorded' (stockRev 0) | 'out' (known 0) | 'low' (positive and STRICTLY below the threshold — equality is
 *             not low, matching the "low below …" label) | 'in'.
 *   presence: 'unrecorded' (null) | 'in' | 'low' | 'out'.
 */
export function stockStatus(p) {
  if (!p) return 'unrecorded';
  if (p.trackMode === 'presence') return PRESENCE_VALUES.includes(p.presence) ? p.presence : 'unrecorded';
  if (!isRecorded(p) || !Number.isSafeInteger(p.stockMilli)) return 'unrecorded';
  if (p.stockMilli === 0) return 'out';
  if (Number.isSafeInteger(p.minMilli) && p.minMilli > 0 && p.stockMilli < p.minMilli) return 'low';
  return 'in';
}
export const STATUS_FILTERS = Object.freeze(['all', 'unrecorded', 'out', 'low', 'in']);

/** A random operation id (24 base64url chars, 144 random bits). Retry safety only — NOT a global uniqueness guarantee. */
export function newOperationId(rng = globalThis.crypto) {
  const b = new Uint8Array(24); rng.getRandomValues(b);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let s = ''; for (const x of b) s += A[x & 63];
  return s;
}

/**
 * computeStock(product, intent) → the resulting numbers, or throws a validation error (detail = i18n key).
 * intent: { type, amount (text in `unit`), unit, note, state (presence: in | low | out) }.
 */
export function computeStock(p, intent = {}) {
  if (!p) throw fail('pantry.err.notFound');
  if (p.archived === true) throw fail('pantry.err.archived');
  const type = intent.type;
  if (!STOCK_TYPES.includes(type)) throw fail('pantry.err.stockType');
  const rawNote = clean(intent.note);
  if (rawNote.length > NOTE_MAX) throw fail('pantry.err.reasonTooLong');
  const note = rawNote || null;
  if (type === 'presence') {
    if (p.trackMode !== 'presence') throw fail('pantry.err.mode');
    if (!PRESENCE_VALUES.includes(intent.state)) throw fail('pantry.err.presence');
    const before = PRESENCE_VALUES.includes(p.presence) ? p.presence : null;
    if (before === intent.state) throw fail('pantry.err.noChange');
    return { type, note, beforeMilli: null, deltaMilli: null, afterMilli: null, requestedMilli: null, unfulfilledMilli: null,
      beforePresence: before, afterPresence: intent.state, dimension: null };
  }
  if (p.trackMode !== 'quantity') throw fail('pantry.err.mode');
  const before = p.stockMilli;
  if (!isBaseMilli(before, p.dimension)) throw fail('pantry.err.corrupt');
  const unit = intent.unit || p.displayUnit;
  if (!convertible(unit, p.displayUnit)) throw fail('pantry.err.dimension');
  let after;
  if (type === 'correction') {
    if (!note) throw fail('pantry.err.reason');
    after = parseQuantity(intent.amount, unit, { allowZero: true });
    if (after === before && isRecorded(p)) throw fail('pantry.err.noChange');   // a FIRST count of the same value (incl. 0) is allowed
  } else {
    const amount = parseQuantity(intent.amount, unit);                           // positive; whole pieces; ≤ MAX_BASE_MILLI
    if (amount > MAX_STEP_MILLI) throw fail('pantry.err.stepTooLarge');
    if (type === 'add') { after = before + amount; if (after > MAX_BASE_MILLI) throw fail('pantry.err.tooLarge'); }
    else { if (amount > before) throw fail('pantry.err.overdraft'); after = before - amount; }
  }
  if (!isBaseMilli(after, p.dimension)) throw fail('pantry.err.amount');
  const delta = after - before;
  return { type, note, beforeMilli: before, deltaMilli: delta, afterMilli: after, requestedMilli: Math.abs(delta), unfulfilledMilli: 0,
    beforePresence: null, afterPresence: null, dimension: p.dimension };
}

/**
 * planStock(product, intent, { uid, now, operationId, baseStockRev }) → { id, patch, movement }.
 * baseStockRev = the stockRev the dialog was opened with; a different stored stockRev → pantry.err.stale (never rebased).
 */
export function planStock(p, intent, { uid, now, operationId, baseStockRev } = {}) {
  if (typeof uid !== 'string' || !uid) throw fail('pantry.err.notSignedIn');
  if (typeof operationId !== 'string' || !OP_ID_RE.test(operationId)) throw fail('pantry.err.opId');
  if (!p || !Number.isInteger(p.stockRev) || p.stockRev < 0) throw fail('pantry.err.notFound');
  if (Number.isInteger(baseStockRev) && p.stockRev !== baseStockRev) throw fail('pantry.err.stale');
  const r = computeStock(p, intent);
  const stockRev = p.stockRev + 1;
  const movement = { productId: p.id, stockRev, type: r.type, beforeMilli: r.beforeMilli, deltaMilli: r.deltaMilli, afterMilli: r.afterMilli,
    requestedMilli: r.requestedMilli, unfulfilledMilli: r.unfulfilledMilli, note: r.note, ...NEUTRAL_FUTURE,
    actorUid: uid, at: now, schemaVersion: 1, beforePresence: r.beforePresence, afterPresence: r.afterPresence, dimension: r.dimension, operationId };
  const patch = r.type === 'presence'
    ? { presence: r.afterPresence, stockRev, updatedBy: uid, updatedAt: now }
    : { stockMilli: r.afterMilli, stockRev, updatedBy: uid, updatedAt: now };
  return { id: movementId(p.id, stockRev), patch, movement };
}

/**
 * Reconciliation after an ambiguous failure: does the movement stored at the deterministic id carry exactly the intent we
 * submitted (same operationId, actor and every value except the server timestamp)? Only then is it "our" write.
 */
export function movementMatches(stored, expected) {
  if (!stored || !expected) return false;
  return MOVEMENT_KEYS.every((k) => k === 'at' || JSON.stringify(stored[k] ?? null) === JSON.stringify(expected[k] ?? null));
}

/** "1.5" in the product's display unit (or another unit of the same dimension). */
export const amountText = (milli, unit) => (Number.isSafeInteger(milli) && milli >= 0 && unit ? formatQuantity(milli, unit) : '');
/** Signed delta text: "+2", "−0.5" (U+2212 minus, so it never reads as a hyphen). */
export const deltaText = (milli, unit) => (Number.isSafeInteger(milli) && unit ? `${milli > 0 ? '+' : milli < 0 ? '−' : '±'}${formatQuantity(Math.abs(milli), unit)}` : '');
