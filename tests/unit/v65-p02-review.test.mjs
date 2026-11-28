// V6.5 Phase 02 — regression tests for the independent review findings:
//   R1 uncertain operation recovery across reload, sign-out, Home switch and store disposal (pending-ops registry)
//   R2 duplicate logical operations: operationId never reused; explicit confirmation for an immediate identical repeat
//   R3 one product per batch is an APPLICATION constraint (client builds exactly one pair; rules validate each pair)
//   R4 the normal AND strict Firestore emulator suites stay mandatory CI gates
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDoc, validateProduct } from '../../src/modules/inventory/product-model.js';
import { planStock, newOperationId, MOVEMENT_KEYS } from '../../src/modules/inventory/stock-model.js';
import { createInventoryStore } from '../../src/modules/inventory/inventory-store.js';
import * as registry from '../../src/modules/inventory/pending-ops.js';

const P = (x = {}) => ({ id: 'pnEggs01', ...createDoc(validateProduct({ nameEn: 'Eggs', category: 'dairy', location: 'fridge', trackMode: 'quantity', dimension: 'count', displayUnit: 'piece', minQty: '6' }).value, { uid: 'u1', now: 'T' }), ...x });
const tick = () => new Promise((r) => setTimeout(r, 0));
const ctxOf = (p, x = {}) => ({ baseStockRev: p.stockRev, dimension: p.dimension ?? null, trackMode: p.trackMode, operationId: newOperationId(), ...x });
/** A Storage-like object; `fail` makes every call throw (private mode / blocked site data). */
function memStorage(init = {}) {
  const m = new Map(Object.entries(init)); const s = { fail: false, map: m };
  s.getItem = (k) => { if (s.fail) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; };
  s.setItem = (k, v) => { if (s.fail) throw new Error('blocked'); m.set(k, String(v)); };
  s.removeItem = (k) => { if (s.fail) throw new Error('blocked'); m.delete(k); };
  return s;
}
function fakeRepo() {
  let on = null; const commits = [];
  const server = { movements: {}, products: {} };
  const r = {
    commits, server, behaviour: 'ok', serverDown: false, reads: 0,
    now: () => 'NOW', newId: () => 'pnNew0001',
    watchProducts: (h, cb) => { on = cb; return () => {}; },
    push: (docs, meta = { fromCache: false, hasPendingWrites: false, pendingIds: [] }) => on(docs, meta),
    readArchived: async () => [], read: async () => null, commit: async () => {}, readHistory: async () => [],
    async commitStock(h, pid, patch, id, movement) {
      commits.push({ pid, patch, id, movement });
      if (r.behaviour === 'hang') return new Promise((res, rej) => { r.release = () => { server.movements[id] = { ...movement, at: 'SERVER' }; res(); }; r.reject = rej; });
      if (r.behaviour === 'network') throw Object.assign(new Error('x'), { code: 'NETWORK' });
      server.movements[id] = { ...movement, at: 'SERVER' };
    },
    async readMovementServer(h, id) { r.reads += 1; if (r.serverDown) throw Object.assign(new Error('x'), { code: 'NETWORK' }); return server.movements[id] || null; },
    async readProductServer(h, id) { if (r.serverDown) throw Object.assign(new Error('x'), { code: 'NETWORK' }); return server.products[id] || null; },
  };
  return r;
}
const fresh = (storage = null) => { registry._setStorage(storage); registry._resetAll(); };

// ------------------------------------------------------------------------------------------------ R1 registry
test('R1 registry: records the exact intent, persists to storage, drops malformed records, survives blocked storage, caps per user + Home', () => {
  const st = memStorage(); fresh(st);
  const p = P({ stockMilli: 2000, stockRev: 1 }); const op = newOperationId();
  const plan = planStock(p, { type: 'add', amount: '1' }, { uid: 'u1', now: { sentinel: true }, operationId: op, baseStockRev: 1 });
  registry.addOp('u1', 'H', { productId: p.id, operationId: op, movementId: plan.id, expected: plan.movement, baseStockRev: 1, trackMode: 'quantity' });
  const stored = JSON.parse(st.getItem('homehub.pantry.pendingStock.v1.u1.H'));
  assert.equal(stored.length, 1); assert.equal(stored[0].expected.at, null, 'server timestamp not serialised');
  assert.deepEqual(Object.keys(stored[0].expected).sort(), [...MOVEMENT_KEYS].sort());
  assert.equal(registry.listOps('u1', 'H')[0].settled, false, 'same page, commit not finished');
  assert.deepEqual(registry.listOps('u2', 'H'), [], 'another user sees nothing'); assert.deepEqual(registry.listOps('u1', 'H2'), [], 'another Home sees nothing');
  // "reload": a new page reads the stored record; the old page's write queue is gone → settled
  const reloaded = memStorage({ 'homehub.pantry.pendingStock.v1.u1.H': JSON.stringify([{ ...stored[0], pageId: 'earlierpage' }, { junk: true }, { ...stored[0], operationId: 'bad id' }]) });
  fresh(reloaded);
  const recs = registry.listOps('u1', 'H');
  assert.equal(recs.length, 1, 'malformed records dropped'); assert.equal(recs[0].settled, true, 'record from an earlier page load is settled');
  registry.removeOp('u1', 'H', op); assert.equal(reloaded.getItem('homehub.pantry.pendingStock.v1.u1.H'), null, 'removed when resolved');
  // blocked storage: everything still works in memory
  const blocked = memStorage(); blocked.fail = true; fresh(blocked);
  const op2 = newOperationId(); const plan2 = planStock(p, { type: 'add', amount: '1' }, { uid: 'u1', now: 'N', operationId: op2, baseStockRev: 1 });
  registry.addOp('u1', 'H', { productId: p.id, operationId: op2, movementId: plan2.id, expected: plan2.movement, baseStockRev: 1, trackMode: 'quantity' });
  assert.equal(registry.listOps('u1', 'H').length, 1);
  fresh(null);
  for (let i = 0; i < registry.MAX_RECORDS + 5; i++) {
    const o = newOperationId(); const pl = planStock(p, { type: 'add', amount: '1' }, { uid: 'u1', now: 'N', operationId: o, baseStockRev: 1 });
    registry.addOp('u1', 'H', { productId: p.id, operationId: o, movementId: pl.id, expected: pl.movement, baseStockRev: 1, trackMode: 'quantity' });
  }
  assert.equal(registry.listOps('u1', 'H').length, registry.MAX_RECORDS, 'capped');
  assert.throws(() => registry.addOp('u1', 'H', { productId: p.id, operationId: newOperationId(), movementId: 'pnEggs01_s9', expected: plan.movement, baseStockRev: 1, trackMode: 'quantity' }), /opId/, 'inconsistent record refused');
});

test('R1 Home switch / store disposal while a commit is pending: the next store for that Home recovers it, never calls it "not applied" while it may still land, then confirms it by a server read', async () => {
  fresh(memStorage());
  const repo = fakeRepo(); const p = P({ stockMilli: 2000, stockRev: 1 });
  const a = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  repo.push([p]); repo.behaviour = 'hang';
  const pending = a.submitStock(p.id, { type: 'add', amount: '1' }, ctxOf(p)); await tick();
  a.dispose();                                                     // Home switch / sign-out / unmount
  const b = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  assert.equal(b.getSnapshot().operations.length, 1); assert.equal(b.getSnapshot().operations[0].recovered, true);
  repo.push([p]); await tick();                                    // first server-confirmed snapshot → one read-only check
  assert.equal(b.stockBlock(p.id), 'pantry.err.reviewFirst', 'blocked until resolved');
  assert.deepEqual(await b.review(p.id), { status: 'pending' }, 'still queued in this page → not "not applied"');
  repo.release(); assert.equal((await pending).status, 'confirmed');
  assert.deepEqual(registry.listOps('u1', 'H'), [], 'the finished commit removed its record');
  const r = await b.review(p.id);
  assert.deepEqual([r.status, r.recovered], ['confirmed', true], 'server read finds OUR movement');
  assert.deepEqual(b.getSnapshot().notices.map((n) => n.status), ['confirmed']);
  b.dismissNotice(b.getSnapshot().notices[0].operationId); assert.equal(b.getSnapshot().notices.length, 0);
  assert.equal(b.stockBlock(p.id), null); assert.equal(repo.commits.length, 1, 'never resent');
});

test('R1 reload: a settled record from an earlier page is checked automatically by READ only on the first server-confirmed snapshot; absent → "not saved" notice; present → confirmed; unreachable → stays blocked', async () => {
  const p = P({ stockMilli: 2000, stockRev: 1 });
  const mk = (op) => { const pl = planStock(p, { type: 'add', amount: '3' }, { uid: 'u1', now: 'N', operationId: op, baseStockRev: 1 }); return { productId: p.id, operationId: op, movementId: pl.id, expected: { ...pl.movement, at: null }, baseStockRev: 1, trackMode: 'quantity', settled: false, pageId: 'earlierpage', createdAt: 1 }; };
  // absent → rejected (not applied)
  const op1 = newOperationId(); fresh(memStorage({ 'homehub.pantry.pendingStock.v1.u1.H': JSON.stringify([mk(op1)]) }));
  let repo = fakeRepo(); repo.server.products[p.id] = p;
  let s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  repo.push([p], { fromCache: true, hasPendingWrites: false, pendingIds: [] }); await tick();
  assert.equal(repo.reads, 0, 'no check from a cached snapshot');
  repo.push([p]); await tick(); await tick(); await tick();
  assert.equal(repo.reads, 1, 'exactly one server read');
  assert.deepEqual(s.getSnapshot().notices.map((n) => n.status), ['rejected']);
  assert.equal(s.stockBlock(p.id), null); assert.equal(repo.commits.length, 0, 'no write, no retry');
  assert.deepEqual(registry.listOps('u1', 'H'), []);
  // present → confirmed
  const op2 = newOperationId(); const rec2 = mk(op2); fresh(memStorage({ 'homehub.pantry.pendingStock.v1.u1.H': JSON.stringify([rec2]) }));
  repo = fakeRepo(); repo.server.movements[rec2.movementId] = { ...rec2.expected, at: 'SERVER' };
  s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  repo.push([{ ...p, stockMilli: 5000, stockRev: 2 }]); await tick(); await tick();
  assert.deepEqual(s.getSnapshot().notices.map((n) => n.status), ['confirmed']);
  // unreachable → unknown, blocked, banner-able; explicit reviewAll later resolves it
  const op3 = newOperationId(); fresh(memStorage({ 'homehub.pantry.pendingStock.v1.u1.H': JSON.stringify([mk(op3)]) }));
  repo = fakeRepo(); repo.serverDown = true;
  s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  repo.push([p]); await tick(); await tick();
  assert.equal(s.getSnapshot().operations[0].status, 'unknown'); assert.equal(s.stockBlock(p.id), 'pantry.err.reviewFirst');
  repo.serverDown = false; repo.server.products[p.id] = p;
  const out = await s.reviewAll(); assert.deepEqual(out.map((o) => o.status), ['rejected']);
  assert.equal(s.stockBlock(p.id), null);
});

test('R1 sign-out / other user: records are per uid + Home; the same user signing in again recovers them; a commit that fails after disposal is recovered and resolved', async () => {
  fresh(memStorage());
  const repo = fakeRepo(); const p = P({ stockMilli: 2000, stockRev: 1 });
  const a = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  repo.push([p]); repo.behaviour = 'hang';
  const pending = a.submitStock(p.id, { type: 'remove', amount: '1' }, ctxOf(p)); await tick();
  a.dispose();
  repo.reject(Object.assign(new Error('x'), { code: 'NETWORK' })); assert.equal((await pending).status, 'unknown');
  assert.equal(registry.listOps('u1', 'H')[0].settled, true, 'marked settled even after disposal');
  const other = createInventoryStore({ homeId: 'H', uid: 'u2', repo, canView: true });
  assert.equal(other.getSnapshot().operations.length, 0, 'another user never sees it');
  const back = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  assert.equal(back.getSnapshot().operations.length, 1);
  repo.server.products[p.id] = p;
  assert.equal((await back.review(p.id)).status, 'rejected', 'settled + nothing on the server → not applied');
  assert.equal(repo.commits.length, 1);
});

// ------------------------------------------------------------------------------------------------ R2 duplicates
test('R2 duplicates: an operationId is never submitted twice (also across stores); an identical change right after a confirmed one needs explicit confirmation; different amounts / products do not', async () => {
  fresh(null);
  const repo = fakeRepo(); const p = P({ stockMilli: 2000, stockRev: 1 });
  const s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  repo.push([p, P({ id: 'pnMilk01', stockMilli: 1000, stockRev: 1 })]);
  const first = ctxOf(p);
  assert.equal((await s.submitStock(p.id, { type: 'add', amount: '2' }, first)).status, 'confirmed');
  const p2 = { ...p, stockMilli: 4000, stockRev: 2 }; repo.push([p2, P({ id: 'pnMilk01', stockMilli: 1000, stockRev: 1 })]);
  await assert.rejects(s.submitStock(p.id, { type: 'add', amount: '2' }, { ...ctxOf(p2), operationId: first.operationId }), (e) => e.detail === 'pantry.err.opReused');
  const s2 = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true }); repo.push([p2]);
  await assert.rejects(s2.submitStock(p.id, { type: 'add', amount: '2' }, { ...ctxOf(p2), operationId: first.operationId }), (e) => e.detail === 'pantry.err.opReused', 'not even from a new store');
  assert.equal(s2.isRepeat(p.id, { type: 'add', amount: '2' }), true);
  await assert.rejects(s2.submitStock(p.id, { type: 'add', amount: '2' }, ctxOf(p2)), (e) => e.detail === 'pantry.err.repeatConfirm');
  assert.equal(repo.commits.length, 1, 'nothing sent without the confirmation');
  assert.equal(s2.isRepeat(p.id, { type: 'add', amount: '3' }), false, 'different amount');
  assert.equal(s2.isRepeat(p.id, { type: 'remove', amount: '2' }), false, 'different type');
  assert.equal((await s2.submitStock(p.id, { type: 'add', amount: '2' }, ctxOf(p2, { confirmRepeat: true }))).status, 'confirmed', 'explicitly confirmed second change');
  assert.equal(repo.commits.length, 2);
  assert.ok(registry.REPEAT_WINDOW_MS >= 60000);
  assert.equal(registry.isRecentRepeat('u1', 'H', p.id, { type: 'add', deltaMilli: 2000 }, Date.now() + registry.REPEAT_WINDOW_MS + 1), false, 'window expires');
});

// ------------------------------------------------------------------------------------------------ R3 / R4 static
const read = (f) => readFileSync(f, 'utf8');
test('R3 one product per batch: the client builds exactly ONE product update + ONE movement per batch; documented as an application constraint, rules tested per pair', () => {
  const repo = read('src/modules/inventory/inventory-repository.js');
  const body = repo.slice(repo.indexOf('commitStock:'), repo.indexOf('}),', repo.indexOf('commitStock:')));
  assert.equal((body.match(/w\.update\(/g) || []).length, 1); assert.equal((body.match(/w\.set\(/g) || []).length, 1);
  assert.ok(!/for\s*\(|\.map\(|\.forEach\(/.test(body), 'no loop over products');
  assert.match(read('src/modules/inventory/inventory-store.js'), /One product per\s+\*?\s*batch is an APPLICATION constraint/);
  assert.match(read('SECURITY.md'), /one product per batch.*application constraint/i);
  const rules = read('tests/rules/rules.test.mjs');
  assert.match(rules, /V65P02-7 multi-product batch/, 'emulator test documents per-pair validation');
});

test('R4 CI keeps the mandatory gates: unit, smoke, cost, NORMAL emulator + limits, STRICT emulator + limits, E2E — no continue-on-error, every step pipefail', () => {
  const wf = read('.github/workflows/verify.yml');
  assert.ok(!/continue-on-error/.test(wf), 'no step may be optional');
  const steps = [...wf.matchAll(/- name: ([^\n]+)\n\s+run: \|\n\s+set -o pipefail\n\s+([^\n]+)/g)].map((m) => [m[1].trim(), m[2].trim()]);
  const names = steps.map(([n]) => n);
  for (const n of ['Unit and static tests', 'Rules smoke tests', 'Rules cost', 'Normal Firestore emulator', 'Normal rules limits', 'Strict Firestore emulator', 'Strict rules limits', 'Browser E2E tests']) assert.ok(names.includes(n), `gate: ${n}`);
  assert.ok(names.indexOf('Normal Firestore emulator') < names.indexOf('Strict Firestore emulator') && names.indexOf('Strict rules limits') < names.indexOf('Browser E2E tests'));
  assert.match(Object.fromEntries(steps)['Normal Firestore emulator'], /^npm run test:rules 2>&1/);
  assert.match(Object.fromEntries(steps)['Strict Firestore emulator'], /^npm run test:rules:strict 2>&1/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['test:rules:strict'], 'node tools/run-strict.mjs');
  assert.match(read('tools/run-strict.mjs'), /STRICT_DENIALS: '1'/);
  assert.match(read('tests/rules/rules.test.mjs'), /const assertFails = process\.env\.STRICT_DENIALS \? assertDenied : _assertFails;/);
  for (const t of ['V65P02-1', 'V65P02-2', 'V65P02-3', 'V65P02-4', 'V65P02-5', 'V65P02-6', 'V65P02-7']) assert.match(read('tests/rules/rules.test.mjs'), new RegExp(`test\\('${t} `), `${t} runs in both emulator modes`);
});
