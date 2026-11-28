// V6.5 Phase 02 — Pantry stock: exact integer arithmetic, limits, Arabic digits, units, whole pieces, unrecorded vs known
// zero, no-ops, correction reasons, presence transitions, threshold equality, independent masks, the movement document
// shape, the store's confirmed-write / reconcile protocol (lost ack, conflict, stale, archive / dimension races, cached /
// pending / offline gating, duplicate submit, disposal), role template v10 and static guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuantity, MAX_BASE_MILLI } from '../../src/modules/inventory/units.js';
import { createDoc, editPatch, validateProduct, EDITABLE } from '../../src/modules/inventory/product-model.js';
import { computeStock, planStock, stockStatus, movementId, movementMatches, newOperationId, amountText, deltaText, STOCK_TYPES, PRESENCE_VALUES,
  MOVEMENT_KEYS, STOCK_MASK, NEUTRAL_FUTURE, MAX_STEP_MILLI, HISTORY_LIMIT, OP_ID_RE, STATUS_FILTERS } from '../../src/modules/inventory/stock-model.js';
import { createInventoryStore } from '../../src/modules/inventory/inventory-store.js';
import * as registry from '../../src/modules/inventory/pending-ops.js';
import { ROLE_TEMPLATE_VERSION, TEMPLATE_CHANGES, ADDITIVE_VERSIONS, ADDED_GRANTS, upgradeRolePermissions } from '../../src/core/permissions/roles.js';
import { defaultRoles } from '../../src/modules/index.js';
import en from '../../src/core/i18n/locales/en.js';
import ar from '../../src/core/i18n/locales/ar.js';

const err = (fn) => { try { fn(); } catch (e) { return e.detail; } return null; };
const OP = 'opAAAAAAAAAAAAAAAAAAAA01';
const P = (x = {}) => ({ id: 'pnEggs01', ...createDoc(validateProduct({ nameEn: 'Eggs', category: 'dairy', location: 'fridge', trackMode: 'quantity', dimension: 'count', displayUnit: 'piece', minQty: '6' }).value, { uid: 'u1', now: 'T' }), ...x });
const RICE = (x = {}) => P({ id: 'pnRice01', dimension: 'mass', displayUnit: 'kg', minMilli: 1000000, ...x });
const SOAP = (x = {}) => P({ id: 'pnSoap01', trackMode: 'presence', dimension: null, displayUnit: null, minMilli: null, stockMilli: null, presence: null, ...x });

// ------------------------------------------------------------------------------------------------ arithmetic
test('P02 arithmetic: add / remove are exact signed integer deltas; requested = |delta|; unfulfilled 0; no overdraft or clipping', () => {
  const p = P({ stockMilli: 12000, stockRev: 3 });
  assert.deepEqual(pick(computeStock(p, { type: 'add', amount: '2', unit: 'piece' })), [12000, 2000, 14000, 2000, 0]);
  assert.deepEqual(pick(computeStock(p, { type: 'remove', amount: '12', unit: 'piece' })), [12000, -12000, 0, 12000, 0], 'remove to exactly zero');
  assert.equal(err(() => computeStock(p, { type: 'remove', amount: '13', unit: 'piece' })), 'pantry.err.overdraft', 'never clipped to zero');
  const r = RICE({ stockMilli: 1500000, stockRev: 1 });
  assert.equal(computeStock(r, { type: 'add', amount: '0.1', unit: 'kg' }).afterMilli, 1600000);
  assert.equal(computeStock(r, { type: 'remove', amount: '250', unit: 'g' }).afterMilli, 1250000, 'same-dimension unit (g on a kg product)');
  assert.equal(computeStock(r, { type: 'add', amount: '١٫٢٥', unit: 'kg' }).afterMilli, 2750000, 'Arabic-Indic digits + Arabic decimal mark');
  // 0.1 + 0.2 never drifts: three adds of 0.1 kg land on exactly 0.3 kg
  let q = RICE({ stockMilli: 0, stockRev: 1 });
  for (let i = 0; i < 3; i++) q = { ...q, stockMilli: computeStock(q, { type: 'add', amount: '0.1', unit: 'kg' }).afterMilli };
  assert.equal(q.stockMilli, parseQuantity('0.3', 'kg'));
});
const pick = (r) => [r.beforeMilli, r.deltaMilli, r.afterMilli, r.requestedMilli, r.unfulfilledMilli];

test('P02 limits + validation: ≤ 10^9 per add / remove, ≤ 10^12 per product, whole pieces, positive amounts, no cross-dimension units', () => {
  const p = P({ stockMilli: 0, stockRev: 1 });
  assert.equal(computeStock(p, { type: 'add', amount: '1000000', unit: 'piece' }).deltaMilli, MAX_STEP_MILLI, 'exactly the step bound');
  assert.equal(err(() => computeStock(p, { type: 'add', amount: '1000001', unit: 'piece' })), 'pantry.err.stepTooLarge');
  assert.equal(err(() => computeStock(RICE({ stockMilli: MAX_BASE_MILLI - 1, stockRev: 2 }), { type: 'add', amount: '0.000002', unit: 'kg' })), 'pantry.err.tooLarge', 'product max');
  assert.equal(computeStock(RICE({ stockMilli: MAX_BASE_MILLI - 1, stockRev: 2 }), { type: 'add', amount: '0.000001', unit: 'kg' }).afterMilli, MAX_BASE_MILLI);
  assert.equal(computeStock(RICE({ stockMilli: 5, stockRev: 2 }), { type: 'correction', amount: '1000000', unit: 'kg', note: 'Audit' }).afterMilli, MAX_BASE_MILLI, 'a correction may set up to the product max');
  assert.equal(err(() => computeStock(p, { type: 'add', amount: '1.5', unit: 'piece' })), 'pantry.err.wholePieces');
  assert.equal(err(() => computeStock(p, { type: 'add', amount: '0', unit: 'piece' })), 'pantry.err.positive');
  assert.equal(err(() => computeStock(p, { type: 'add', amount: '-1', unit: 'piece' })), 'pantry.err.amount');
  assert.equal(err(() => computeStock(p, { type: 'add', amount: '1', unit: 'kg' })), 'pantry.err.dimension', 'piece product + kg');
  assert.equal(err(() => computeStock(RICE({ stockRev: 1 }), { type: 'add', amount: '1', unit: 'l' })), 'pantry.err.dimension', 'mass product + litres');
  assert.equal(err(() => computeStock(p, { type: 'teleport', amount: '1' })), 'pantry.err.stockType');
  for (const future of ['consumption', 'purchase', 'cook', 'initial']) assert.equal(err(() => computeStock(p, { type: future, amount: '1' })), 'pantry.err.stockType', future);
  assert.equal(err(() => computeStock(P({ archived: true, stockRev: 1 }), { type: 'add', amount: '1' })), 'pantry.err.archived');
  assert.equal(err(() => computeStock(P({ stockMilli: 1500, stockRev: 1 }), { type: 'add', amount: '1' })), 'pantry.err.corrupt', 'stored fractional pieces are refused, not repaired');
  assert.deepEqual(STOCK_TYPES, ['add', 'remove', 'correction', 'presence']);
});

test('P02 unrecorded vs known zero: stockRev 0 is "not recorded"; first count of 0 needs a reason; later same-value corrections are no-ops', () => {
  const fresh = P();                                           // Phase 01 shape: stockMilli 0, stockRev 0
  assert.equal(stockStatus(fresh), 'unrecorded', 'stored 0 with stockRev 0 is NOT "out"');
  assert.equal(err(() => computeStock(fresh, { type: 'correction', amount: '0', unit: 'piece' })), 'pantry.err.reason');
  assert.equal(err(() => computeStock(fresh, { type: 'correction', amount: '0', unit: 'piece', note: '   ' })), 'pantry.err.reason', 'blank reason');
  const first = computeStock(fresh, { type: 'correction', amount: '0', unit: 'piece', note: 'Checked the fridge' });
  assert.deepEqual([first.deltaMilli, first.afterMilli, first.requestedMilli, first.note], [0, 0, 0, 'Checked the fridge'], 'explicit first zero count');
  assert.equal(stockStatus(P({ stockMilli: 0, stockRev: 1 })), 'out', 'known empty after a recorded movement');
  assert.equal(err(() => computeStock(P({ stockMilli: 0, stockRev: 1 }), { type: 'correction', amount: '0', unit: 'piece', note: 'again' })), 'pantry.err.noChange');
  assert.equal(err(() => computeStock(P({ stockMilli: 4000, stockRev: 2 }), { type: 'correction', amount: '4', unit: 'piece', note: 'same' })), 'pantry.err.noChange');
  assert.equal(computeStock(P({ stockMilli: 4000, stockRev: 2 }), { type: 'correction', amount: '3', unit: 'piece', note: 'Counted' }).deltaMilli, -1000);
  assert.equal(err(() => computeStock(P({ stockRev: 2 }), { type: 'correction', amount: '3', unit: 'piece', note: 'x'.repeat(201) })), 'pantry.err.reasonTooLong');
  assert.equal(computeStock(P({ stockRev: 2 }), { type: 'correction', amount: '3', unit: 'piece', note: ` ${'x'.repeat(200)} ` }).note.length, 200, 'trimmed before the bound');
  assert.equal(computeStock(P({ stockRev: 2 }), { type: 'add', amount: '1', unit: 'piece', note: '' }).note, null, 'optional note → null');
});

test('P02 presence: null (unrecorded) → in / low / out; same-state no-op refused; mode mismatch refused', () => {
  assert.equal(stockStatus(SOAP()), 'unrecorded');
  const r = computeStock(SOAP(), { type: 'presence', state: 'out' });
  assert.deepEqual([r.beforePresence, r.afterPresence, r.beforeMilli, r.deltaMilli, r.afterMilli, r.requestedMilli, r.unfulfilledMilli, r.dimension], [null, 'out', null, null, null, null, null, null]);
  assert.equal(err(() => computeStock(SOAP({ presence: 'low', stockRev: 1 }), { type: 'presence', state: 'low' })), 'pantry.err.noChange');
  assert.equal(err(() => computeStock(SOAP(), { type: 'presence', state: 'empty' })), 'pantry.err.presence');
  assert.equal(err(() => computeStock(SOAP(), { type: 'add', amount: '1' })), 'pantry.err.mode');
  assert.equal(err(() => computeStock(P(), { type: 'presence', state: 'in' })), 'pantry.err.mode');
  for (const v of PRESENCE_VALUES) assert.equal(stockStatus(SOAP({ presence: v, stockRev: 1 })), v);
});

test('P02 thresholds: low is STRICTLY below minMilli (equality is not low); no threshold → never low', () => {
  assert.equal(stockStatus(P({ stockMilli: 6000, stockRev: 1, minMilli: 6000 })), 'in', 'equal to the threshold');
  assert.equal(stockStatus(P({ stockMilli: 5000, stockRev: 1, minMilli: 6000 })), 'low');
  assert.equal(stockStatus(P({ stockMilli: 1000, stockRev: 1, minMilli: null })), 'in');
  assert.equal(stockStatus(P({ stockMilli: 0, stockRev: 1, minMilli: 6000 })), 'out', 'zero is out, not low');
  assert.deepEqual(STATUS_FILTERS, ['all', 'unrecorded', 'out', 'low', 'in']);
});

// ------------------------------------------------------------------------------------------------ documents / masks
test('P02 documents: deterministic id, exact movement keys, neutral future fields, independent masks (stock never bumps rev; catalog never touches stock)', () => {
  const p = P({ stockMilli: 2000, stockRev: 7, rev: 4 });
  const plan = planStock(p, { type: 'remove', amount: '2', unit: 'piece', note: 'Breakfast' }, { uid: 'u2', now: 'NOW', operationId: OP, baseStockRev: 7 });
  assert.equal(plan.id, 'pnEggs01_s8'); assert.equal(movementId('abc_s1', 2), 'abc_s1_s2');
  assert.deepEqual(Object.keys(plan.movement).sort(), [...MOVEMENT_KEYS].sort()); assert.equal(MOVEMENT_KEYS.length, 24);
  for (const [k, v] of Object.entries(NEUTRAL_FUTURE)) assert.equal(plan.movement[k], v, k);
  assert.deepEqual(NEUTRAL_FUTURE, { ruleRev: null, segment: null, occFrom: null, occTo: null, coveredMilli: 0, tripId: null, line: null, cookId: null });
  assert.deepEqual(plan.movement, { productId: 'pnEggs01', stockRev: 8, type: 'remove', beforeMilli: 2000, deltaMilli: -2000, afterMilli: 0, requestedMilli: 2000, unfulfilledMilli: 0,
    note: 'Breakfast', ...NEUTRAL_FUTURE, actorUid: 'u2', at: 'NOW', schemaVersion: 1, beforePresence: null, afterPresence: null, dimension: 'count', operationId: OP });
  assert.deepEqual(plan.patch, { stockMilli: 0, stockRev: 8, updatedBy: 'u2', updatedAt: 'NOW' }, 'rev is NOT in the stock mask');
  assert.ok(Object.keys(plan.patch).every((k) => STOCK_MASK.includes(k)));
  const pres = planStock(SOAP({ presence: 'in', stockRev: 2 }), { type: 'presence', state: 'low' }, { uid: 'u2', now: 'NOW', operationId: OP, baseStockRev: 2 });
  assert.deepEqual(pres.patch, { presence: 'low', stockRev: 3, updatedBy: 'u2', updatedAt: 'NOW' });
  assert.deepEqual([pres.movement.beforePresence, pres.movement.afterPresence, pres.movement.beforeMilli, pres.movement.coveredMilli, pres.movement.dimension], ['in', 'low', null, 0, null]);
  // catalog edits never carry stock fields; stock plans never carry catalog fields
  const e = editPatch(p, { ...validateProduct({ ...p, minMilli: 12000 }, { current: p }).value }, { uid: 'u1', now: 'NOW' });
  assert.ok(e && !['stockMilli', 'presence', 'stockRev'].some((k) => k in e) && e.rev === 5);
  assert.ok(!EDITABLE.some((k) => k in plan.patch));
  assert.equal(err(() => planStock(p, { type: 'add', amount: '1' }, { uid: 'u2', now: 'N', operationId: OP, baseStockRev: 6 })), 'pantry.err.stale', 'never rebased onto a newer stockRev');
  assert.equal(err(() => planStock(p, { type: 'add', amount: '1' }, { uid: 'u2', now: 'N', operationId: 'short', baseStockRev: 7 })), 'pantry.err.opId');
  assert.equal(err(() => planStock(p, { type: 'add', amount: '1' }, { uid: '', now: 'N', operationId: OP, baseStockRev: 7 })), 'pantry.err.notSignedIn');
});

test('P02 operation ids + reconciliation matching: random base64url ids; a stored movement matches ONLY when operationId, actor and every value agree', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newOperationId()));
  assert.equal(ids.size, 200); for (const id of ids) assert.ok(OP_ID_RE.test(id) && id.length === 24, id);
  const { movement } = planStock(P({ stockMilli: 3000, stockRev: 1 }), { type: 'add', amount: '1' }, { uid: 'u1', now: 'SENTINEL', operationId: OP, baseStockRev: 1 });
  const stored = { ...movement, at: { seconds: 1 } };
  assert.equal(movementMatches(stored, movement), true, 'server timestamp differs — ignored');
  for (const [k, v] of [['operationId', 'opBBBBBBBBBBBBBBBBBBBB02'], ['actorUid', 'u9'], ['deltaMilli', 2000], ['afterMilli', 5000], ['note', 'x'], ['type', 'correction'], ['dimension', 'mass']])
    assert.equal(movementMatches({ ...stored, [k]: v }, movement), false, `different ${k}`);
  assert.equal(movementMatches(null, movement), false);
  assert.equal(amountText(1500000, 'kg'), '1.5'); assert.equal(deltaText(-2000, 'piece'), '−2'); assert.equal(deltaText(500, 'g'), '+0.5');
});

// ------------------------------------------------------------------------------------------------ store protocol
function fakeRepo() {
  let on = null; let onErr = null; const commits = []; let stopped = 0;
  const server = { movements: {}, products: {} };
  const r = {
    commits, server, behaviour: 'ok', serverDown: false, history: [],
    now: () => 'NOW', newId: () => 'pnNew0001',
    watchProducts: (h, cb, eb) => { on = cb; onErr = eb; return () => { stopped += 1; }; },
    push: (docs, meta = { fromCache: false, hasPendingWrites: false, pendingIds: [] }) => on(docs, meta),
    fail: (e) => onErr(e), stopped: () => stopped,
    readArchived: async () => [], read: async (h, id) => server.products[id] || null, commit: async () => {},
    async commitStock(h, pid, patch, id, movement) {
      commits.push({ pid, patch, id, movement });
      if (r.behaviour === 'hang') return new Promise((res, rej) => { r.release = res; r.reject = rej; });
      if (r.behaviour === 'lostAck') { server.movements[id] = { ...movement, at: 'SERVER' }; throw Object.assign(new Error('x'), { code: 'PERMISSION_DENIED' }); }
      if (r.behaviour === 'denied') throw Object.assign(new Error('x'), { code: 'PERMISSION_DENIED' });
      if (r.behaviour === 'network') throw Object.assign(new Error('x'), { code: 'NETWORK' });
      server.movements[id] = { ...movement, at: 'SERVER' };
    },
    async readMovementServer(h, id) { if (r.serverDown) throw Object.assign(new Error('x'), { code: 'NETWORK' }); return server.movements[id] || null; },
    async readProductServer(h, id) { if (r.serverDown) throw Object.assign(new Error('x'), { code: 'NETWORK' }); return server.products[id] || null; },
    readHistory: async () => r.history,
  };
  return r;
}
// Review update: every submission needs a NEVER-USED operationId (store rejects reuse), and these protocol tests submit
// the same change repeatedly on purpose → explicit confirmRepeat. The guards themselves are tested in the "review" tests.
const ctxOf = (p, x = {}) => ({ baseStockRev: p.stockRev, dimension: p.dimension ?? null, trackMode: p.trackMode, operationId: newOperationId(), confirmRepeat: true, ...x });

test('P02 store: confirmed only after the commit resolves; ONE batch (product mask + movement); submission bound to the captured revision / dimension; no automatic retry', async () => {
  registry._setStorage(null); const repo = fakeRepo(); const s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  const p = P({ stockMilli: 2000, stockRev: 1 });
  repo.push([p]);
  repo.behaviour = 'hang';
  const pending = s.submitStock(p.id, { type: 'add', amount: '3', unit: 'piece' }, ctxOf(p));
  await tick();
  assert.equal(s.operation(p.id).status, 'submitting', 'not confirmed while the server has not acknowledged');
  assert.equal(s.stockBlock(p.id), 'pantry.err.inFlight', 'duplicate submission blocked');
  await assert.rejects(s.submitStock(p.id, { type: 'add', amount: '3', unit: 'piece' }, ctxOf(p)), (e) => e.detail === 'pantry.err.inFlight');
  repo.release();
  assert.deepEqual(await pending, { status: 'confirmed', movementId: 'pnEggs01_s2' });
  assert.equal(repo.commits.length, 1, 'exactly one commit (no retry)');
  assert.deepEqual(repo.commits[0].patch, { stockMilli: 5000, stockRev: 2, updatedBy: 'u1', updatedAt: 'NOW' });
  assert.equal(s.operation(p.id), null);
  // stale dialog: listener moved on (another device) → refused before anything is sent
  repo.behaviour = 'ok'; repo.push([{ ...p, stockMilli: 9000, stockRev: 2 }]);
  await assert.rejects(s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p)), (e) => e.detail === 'pantry.err.stale');
  // dimension changed underneath (stockRev still 0) → refused
  const q = P({ id: 'pnQ00001', stockRev: 0 }); repo.push([{ ...q, dimension: 'mass', displayUnit: 'g' }]);
  await assert.rejects(s.submitStock(q.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(q)), (e) => e.detail === 'pantry.err.stale');
  assert.equal(repo.commits.length, 1);
});
const tick = () => new Promise((r) => setTimeout(r, 0));

test('P02 store gating: cached snapshot, pending writes on the product, offline browser, archived / missing product → no submission', async () => {
  let online = true;
  registry._setStorage(null); const repo = fakeRepo(); const s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true, isOnline: () => online });
  const p = P({ stockMilli: 2000, stockRev: 1 });
  assert.equal(s.stockBlock(p.id), 'pantry.err.notConfirmed', 'before the first snapshot');
  repo.push([p], { fromCache: true, hasPendingWrites: false, pendingIds: [] });
  assert.equal(s.stockBlock(p.id), 'pantry.err.notConfirmed', 'cache-only snapshot');
  assert.equal(s.getSnapshot().fromCache, true);
  repo.push([p], { fromCache: false, hasPendingWrites: true, pendingIds: [p.id] });
  assert.equal(s.stockBlock(p.id), 'pantry.err.notConfirmed', 'pending local write on this product');
  repo.push([p, P({ id: 'pnOther01', stockRev: 1 })], { fromCache: false, hasPendingWrites: true, pendingIds: ['pnOther01'] });
  assert.equal(s.stockBlock(p.id), null, 'pending writes on ANOTHER product do not block this one');
  online = false; assert.equal(s.stockBlock(p.id), 'pantry.err.offline');
  online = true; assert.equal(s.stockBlock('nope'), 'pantry.err.notFound');
  await assert.rejects(s.submitStock(p.id, { type: 'remove', amount: '9', unit: 'piece' }, ctxOf(p)), (e) => e.detail === 'pantry.err.overdraft', 'validation before any write');
  assert.equal(repo.commits.length, 0);
});

test('P02 store reconciliation: lost acknowledgement → confirmed by server read; foreign movement → conflict; rejected + advanced product → stale; archived meanwhile; server unreachable → unknown until reviewed', async () => {
  registry._setStorage(null); const repo = fakeRepo(); const s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  const p = P({ stockMilli: 2000, stockRev: 1 }); repo.push([p]);
  // lost ack: the write landed, the SDK reported a failure
  repo.behaviour = 'lostAck';
  assert.deepEqual(await s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p)), { status: 'confirmed', movementId: 'pnEggs01_s2', recovered: true });
  // conflict: someone else's movement occupies our deterministic id
  repo.server.movements = { pnEggs01_s2: { ...repo.server.movements.pnEggs01_s2, operationId: 'opOTHERxxxxxxxxxxxxxxxx', actorUid: 'u7' } };
  repo.behaviour = 'denied';
  const c = await s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p));
  assert.deepEqual([c.status, c.error.detail], ['conflict', 'pantry.err.conflict']);
  // rejected, nothing at the id, the product advanced on the server → stale (not applied)
  repo.server.movements = {}; repo.server.products[p.id] = { ...p, stockRev: 4 };
  const st = await s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p));
  assert.deepEqual([st.status, st.error.detail], ['rejected', 'pantry.err.stale']);
  // archive race
  repo.server.products[p.id] = { ...p, archived: true };
  const ar1 = await s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p));
  assert.deepEqual([ar1.status, ar1.error.detail], ['rejected', 'pantry.err.archivedNow']);
  // dimension race (product still stockRev 1 on the server but now mass)
  repo.server.products[p.id] = { ...p, dimension: 'mass', displayUnit: 'g' };
  assert.equal((await s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p))).error.detail, 'pantry.err.stale');
  // unknown: commit failed AND the server cannot be reached → product blocked until an explicit review
  repo.behaviour = 'network'; repo.serverDown = true;
  const u = await s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p));
  assert.equal(u.status, 'unknown');
  assert.equal(s.stockBlock(p.id), 'pantry.err.reviewFirst');
  assert.equal(s.getSnapshot().operations[0].status, 'unknown');
  assert.equal((await s.review(p.id)).status, 'unknown', 'still unreachable');
  repo.serverDown = false; repo.server.movements.pnEggs01_s2 = { ...repo.commits.at(-1).movement, at: 'SERVER' };   // it HAD landed
  assert.deepEqual(await s.review(p.id), { status: 'confirmed', movementId: 'pnEggs01_s2', recovered: true });
  assert.equal(s.stockBlock(p.id), null);
  const before = repo.commits.length;
  repo.behaviour = 'network'; repo.serverDown = true; await s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p));
  repo.serverDown = false; repo.server.movements = {};
  const na = await s.review(p.id);
  assert.equal(na.status, 'rejected', 'review: nothing landed → not applied');
  assert.equal(repo.commits.length, before + 1, 'reviews never write and never retry');
});

test('P02 store: review of a still-pending write never declares it "not applied"; disposal suppresses late results; history is bounded, filtered and newest first', async () => {
  registry._setStorage(null); const repo = fakeRepo(); const s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  const p = P({ stockMilli: 2000, stockRev: 1 }); repo.push([p]);
  repo.behaviour = 'hang';
  const pend = s.submitStock(p.id, { type: 'add', amount: '1', unit: 'piece' }, ctxOf(p)); await tick();
  assert.deepEqual(await s.review(p.id), { status: 'pending' });
  assert.equal(s.operation(p.id).status, 'submitting');
  repo.history = [{ productId: p.id, stockRev: 1 }, { productId: p.id, stockRev: 3 }, { productId: 'other', stockRev: 9 }, { productId: p.id, stockRev: 2 }];
  assert.deepEqual((await s.history(p.id)).items.map((m) => m.stockRev), [3, 2, 1]);
  repo.history = Array.from({ length: 60 }, (_, i) => ({ productId: p.id, stockRev: i + 1 }));
  const hst = await s.history(p.id); assert.deepEqual([hst.items.length, hst.limited, hst.items[0].stockRev], [HISTORY_LIMIT, true, 60]);
  let emitted = 0; s.subscribe(() => { emitted += 1; }); const e0 = emitted;
  s.dispose(); repo.release(); await pend;
  assert.equal(emitted, e0, 'no emission after Home switch / sign-out');
  assert.equal(repo.stopped(), 1);
  await assert.rejects(s.submitStock(p.id, { type: 'add', amount: '1' }, ctxOf(p)), (e) => e.detail === 'disposed');
});

// ------------------------------------------------------------------------------------------------ roles v10
test('P02 roles: template v10 adds ONLY inventory.adjust (admin / member), additively; revoked defaults stay revoked; custom grants kept; owner "*"; no silent upgrade', () => {
  assert.equal(ROLE_TEMPLATE_VERSION, 10); assert.deepEqual(TEMPLATE_CHANGES[10], ['inventory']); assert.ok(ADDITIVE_VERSIONS.includes(10));
  assert.deepEqual(ADDED_GRANTS[10], ['inventory.adjust']);
  const tpl = Object.fromEntries(defaultRoles().map((r) => [r.id, r.permissions]));
  const member9 = tpl.member.filter((g) => g !== 'inventory.adjust');
  assert.deepEqual(upgradeRolePermissions({ current: member9, template: tpl.member, from: 9 }), [...tpl.member].sort(), 'default member: + adjust');
  const revoked = member9.filter((g) => g !== 'inventory.edit');
  const up = upgradeRolePermissions({ current: revoked, template: tpl.member, from: 9 });
  assert.ok(up.includes('inventory.adjust') && !up.includes('inventory.edit'), 'an owner-revoked inventory.edit is NOT re-granted by v10');
  const child = [...tpl.child, 'inventory.view', 'inventory.adjust', 'custom.x'];
  assert.deepEqual(upgradeRolePermissions({ current: child, template: tpl.child, from: 9 }), [...new Set(child)].sort(), 'custom child grants kept; child gets nothing new');
  assert.deepEqual(upgradeRolePermissions({ current: tpl.viewer, template: tpl.viewer, from: 9 }).filter((g) => g.startsWith('inventory.')), ['inventory.view'], 'viewer: no adjust');
  const noAdjust = tpl.member.filter((g) => g !== 'inventory.adjust');
  assert.deepEqual(upgradeRolePermissions({ current: noAdjust, template: tpl.member, from: 10 }), [...noAdjust].sort(), 'a role already at v10 whose adjust was revoked stays revoked');
  assert.deepEqual(upgradeRolePermissions({ current: ['*'], template: [], from: 1 }), ['*']);
  // older roles: v8 → v10 still applies v9 (contacts, namespace-additive) AND v10 (exact grant)
  const m8 = tpl.member.filter((g) => !g.startsWith('contacts.') && g !== 'inventory.adjust');
  const up8 = upgradeRolePermissions({ current: m8, template: tpl.member, from: 8 });
  assert.ok(up8.includes('inventory.adjust') && up8.includes('contacts.import'));
});

// ------------------------------------------------------------------------------------------------ static guards
const read = (p) => readFileSync(p, 'utf8');
test('P02 static: data layer is additive; SDK facade exports getDocFromServer / orderBy; movements are create-only; one index; no delete; no money; no shopping suggestions', () => {
  const fs = read('src/core/data/firestore.js');
  for (const fn of ['readDoc', 'readCollection', 'watchDoc', 'watchCollection', 'watchWhereLimited', 'readWhereLimited', 'watchWhere', 'createDoc', 'patchDoc', 'atomicWrite', 'newDocId', 'serverTime'])
    assert.match(fs, new RegExp(`export (async )?(function|const) ${fn}\\b`), `existing helper kept: ${fn}`);
  for (const fn of ['watchWhereLimitedMeta', 'readWhereOrderedLimited', 'readDocServer']) assert.match(fs, new RegExp(`export (async )?function ${fn}\\b`));
  assert.match(fs, /includeMetadataChanges: true/);
  const sdk = read('src/core/firebase/sdk.js'); assert.match(sdk, /getDocFromServer,/); assert.match(sdk, /orderBy,/);
  assert.ok(!/runTransaction|increment\(|enableIndexedDbPersistence|persistentLocalCache/.test(sdk + fs), 'no transactions / increments / offline persistence');
  const rules = read('firestore.rules');
  const mv = rules.slice(rules.indexOf('match /pantryMovements/{movementId}'), rules.indexOf('match /pantryMovements/{movementId}') + 2000);
  assert.match(mv, /allow update, delete: if false;/); assert.match(mv, /allow get, list: if can\(h, 'inventory', 'view'\);/);
  assert.match(mv, /movementId == incoming\(\)\.productId \+ '_s' \+ string\(incoming\(\)\.stockRev\)/);
  assert.match(rules, /!exists\(mp\) && existsAfter\(mp\)/, 'movement must be NEW in this batch');
  assert.match(rules, /can\(h, 'inventory', M\.type == 'correction' \? 'adjust' : 'edit'\)/); assert.match(rules, /function pnStockCan\(h, M\) \{\s*return can\(h, 'inventory', 'view'\) &&/);
  assert.match(rules, /function adoptionTemplateVersion\(\) \{ return 10; \}/);
  const idx = JSON.parse(read('firestore.indexes.json'));
  assert.deepEqual(idx, { indexes: [{ collectionGroup: 'pantryMovements', queryScope: 'COLLECTION', fields: [{ fieldPath: 'productId', order: 'ASCENDING' }, { fieldPath: 'stockRev', order: 'DESCENDING' }] }], fieldOverrides: [] });
  const repo = read('src/modules/inventory/inventory-repository.js');
  assert.ok(!/\.delete\(|mode:\s*'delete'/.test(repo)); assert.match(repo, /HISTORY_LIMIT/);
  const store = read('src/modules/inventory/inventory-store.js');
  assert.ok(!/setTimeout|setInterval|retry\(/.test(store), 'no automatic retry / timers in the store');
  assert.equal((store.match(/repo\.commitStock\(/g) || []).length, 1, 'one commit call site');
  const ui = read('src/modules/inventory/movement-ui.js') + read('src/modules/inventory/page.js');
  assert.ok(!/shopping|navigator\.onLine/i.test(ui), 'no shopping suggestions; navigator.onLine is not used as confirmation in the UI');
  assert.ok(!/pn-notice|stockNotYet|stockOff/.test(ui), 'obsolete Phase 01 notice removed');
  for (const f of ['stock-model.js', 'movement-ui.js']) assert.ok(!/\b(price|amountMinor|currency|expenseId|wallet)\b/i.test(read(`src/modules/inventory/${f}`)), f);
  for (const v of [read('src/config/app-config.js'), read('sw.js'), read('package.json')]) assert.match(v, /6\.5\.0-p02/);
});

test('P02 i18n: every new Pantry key (incl. dynamic status / presence / type keys) exists in English and Arabic', () => {
  const dyn = [...STATUS_FILTERS.map((s) => `pantry.statusF.${s}`), ...['unrecorded', 'out', 'low', 'in'].map((s) => `pantry.status.q.${s}`),
    ...['unrecorded', 'in', 'low', 'out'].map((s) => `pantry.status.p.${s}`), ...PRESENCE_VALUES.map((v) => `pantry.presence.${v}`), ...STOCK_TYPES.map((v) => `pantry.stock.type.${v}`)];
  const src = ['stock-model.js', 'movement-ui.js', 'inventory-store.js', 'page.js'].map((f) => read(`src/modules/inventory/${f}`)).join('\n');
  const literal = [...src.matchAll(/'(pantry\.[A-Za-z.]+[A-Za-z])'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.'));
  const has = (d, k) => !!(d[k] || d[`${k}.one`] || d[`${k}.other`]);   // tp() plural bases (pantry.count) have .one / .other forms
  for (const k of new Set([...dyn, ...literal])) { assert.ok(has(en, k), `en ${k}`); assert.ok(has(ar, k), `ar ${k}`); }
  assert.ok(!('pantry.stockNotYet' in en) && !('pantry.stockNotYet' in ar), 'obsolete notice key removed in both languages');
});
