/**
 * Phase 5.3.2 hotfix regressions: the exact production symptom ("tasks appear, then stop, then
 * 'someone else set this up'") came from ONE batched write of every task, rejected as a whole by
 * Firestore's per-request rule limits, with the SDK rolling back its optimistic copies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCleaningStore } from '../../src/modules/cleaning/cleaning-store.js';
import { buildSetupPlan, planWrites, generatedPayloadProblems } from '../../src/modules/cleaning/cleaning-integration.js';

const rooms = [['k', 'kitchen'], ['b1', 'bathroom'], ['b2', 'bathroom'], ['m', 'master_bedroom'], ['br', 'bedroom'], ['kids', 'kids_room'], ['lv', 'living_room'], ['hall', 'hallway'], ['bal', 'balcony'], ['gar', 'garage']]
  .map(([id, type], i) => ({ id: `R${i}${id}`, name: id, type, active: true }));
const devices = [['fr', 'refrigerator'], ['dw', 'dishwasher'], ['mw', 'microwave'], ['ov', 'oven'], ['af', 'air_fryer'], ['vc', 'vacuum_cleaner'], ['ac1', 'split_ac']]
  .map(([id, subtype], i) => ({ id: `D${i}${id}`, name: id, subtype, roomId: 'R0k', active: true }));
// Phase 5.4b: 125 = the v5.7.2 97 + 16 AC (seasonal) + 12 usage-triggered device tasks.
const TOTAL = 125;
const realisticWrites = (lang, tasks = []) => {
  const plan = buildSetupPlan({ rooms, devices, tasks });
  return planWrites({ plan, accepted: new Set(plan.pending.flatMap((g) => g.add.map((a) => a.id))), lang, uid: 'U', now: 'NOW', today: '2026-10-15' });
};

/** Firestore-like fake: commits resolve only after a server ack; optional per-request op limit. */
function fakeRepo({ maxOpsPerCommit = Infinity, denyIds = new Set(), raceIds = new Set(), networkFailAfter = Infinity } = {}) {
  const data = new Map(); const ws = new Set(); const commits = []; let n = 0;
  const fire = () => { for (const w of ws) w(); };
  return { data, commits,
    now: () => 'NOW', newId: () => `t${++n}`,
    watchTasks(h, onValue) { const w = () => onValue([...data.entries()].filter(([k]) => k.startsWith('cleaningTasks/')).map(([k, d]) => ({ id: k.split('/')[1], ...d }))); ws.add(w); queueMicrotask(w); return () => ws.delete(w); },
    watchOccurrences(h, f, onValue) { queueMicrotask(() => onValue([])); return () => {}; },
    readLog: async () => [],
    taskExists: async (h, id) => data.has(`cleaningTasks/${id}`),
    async commit(h, ops) {
      await new Promise((r) => setTimeout(r, 1));                                     // server round-trip
      commits.push(ops.length);
      if (commits.length > networkFailAfter) throw Object.assign(new Error('offline'), { code: 'unavailable' });
      if (ops.length > maxOpsPerCommit) throw Object.assign(new Error('rules limit'), { code: 'permission-denied' });
      for (const o of ops) {
        if (raceIds.has(o.id)) { data.set(`${o.name}/${o.id}`, { ...o.data, createdBy: 'someoneElse' }); throw Object.assign(new Error('exists'), { code: 'permission-denied' }); }
        if (denyIds.has(o.id) || data.has(`${o.name}/${o.id}`)) throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      }
      for (const o of ops) data.set(`${o.name}/${o.id}`, { ...o.data });
      fire();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function store(repo) { const s = createCleaningStore({ homeId: 'H', uid: 'U', repo, today: () => '2026-10-15' }); s.ensure({ canView: true }); s.subscribe(() => {}); await tick(); return s; }

test('real payloads: every Arabic and English generated task passes the rules mirror (incl. the 83-char stove title)', () => {
  for (const lang of ['ar', 'en']) {
    const w = realisticWrites(lang);
    assert.equal(w.length, TOTAL);
    assert.deepEqual(w.map((x) => [x.id, generatedPayloadProblems(x)]).filter(([, p]) => p.length), [], lang);
  }
  assert.ok(realisticWrites('en').some((x) => x.data.title.length === 83));
});

test('exact production failure: even if the server accepts only ONE operation per request, all 97 are saved (one write per task)', async () => {
  const repo = fakeRepo({ maxOpsPerCommit: 1 }); const s = await store(repo);
  const r = await s.applySetup(realisticWrites('ar'));
  assert.deepEqual([r.saved, r.failed.length, r.alreadyExisted, r.remaining], [TOTAL, 0, 0, 0]);
  assert.ok(repo.commits.every((n) => n === 1), 'never a multi-task batch');
});

test('progress counts CONFIRMED saves only: monotonic, and never ahead of the server', async () => {
  const repo = fakeRepo(); const s = await store(repo); const seen = [];
  await s.applySetup(realisticWrites('ar'), { onProgress: (p) => seen.push([p.saved, [...repo.data.keys()].filter((k) => k.startsWith('cleaningTasks/')).length]) });
  assert.ok(seen.every(([saved, stored]) => saved <= stored), 'saved count never exceeds what the server holds');
  assert.ok(seen.every(([saved], i) => i === 0 || saved >= seen[i - 1][0]), 'never moves backwards');
  assert.equal(seen.at(-1)[0], TOTAL);
});

test('a failed task never removes saved ones; partial result reports saved / failed / remaining', async () => {
  const bad = realisticWrites('ar')[10].id;
  const repo = fakeRepo({ denyIds: new Set([bad]) }); const s = await store(repo);
  const r = await s.applySetup(realisticWrites('ar'));
  assert.deepEqual([r.total, r.saved, r.failed.map((f) => [f.id, f.reason]), r.remaining], [TOTAL, TOTAL - 1, [[bad, 'denied']], 0]);
  await tick();
  assert.equal(s.getSnapshot().tasks.length, TOTAL - 1, 'the saved tasks stay');
  // Retry (fixed rule / second attempt): only the missing one is written; no duplicates.
  const again = realisticWrites('ar', s.getSnapshot().tasks);
  assert.deepEqual(again.map((w) => w.id), [bad], 'the review now offers only the missing task');
});

test('rejected because someone else created it meanwhile → "already added", not a failure', async () => {
  const raced = realisticWrites('ar')[3].id;
  const repo = fakeRepo({ raceIds: new Set([raced]) }); const s = await store(repo);
  const r = await s.applySetup(realisticWrites('ar'));
  assert.deepEqual([r.saved, r.alreadyExisted, r.failed.length], [TOTAL - 1, 1, 0]);
});

test('network drop: stops new attempts; reports saved, failed and not-attempted; retry completes without duplicates', async () => {
  const repo = fakeRepo({ networkFailAfter: 20 }); const s = await store(repo);
  const r = await s.applySetup(realisticWrites('ar'), { concurrency: 1 });
  assert.equal(r.saved, 20); assert.deepEqual(r.failed.map((f) => f.reason), ['network']); assert.equal(r.remaining, TOTAL - 21);
  await tick();
  const repo2 = fakeRepo(); for (const [k, v] of repo.data) repo2.data.set(k, v);
  const s2 = await store(repo2);
  const retry = realisticWrites('ar', s2.getSnapshot().tasks);
  assert.equal(retry.length, TOTAL - 20, 'only the unsaved tasks are planned again');
  const r2 = await s2.applySetup(retry);
  assert.deepEqual([r2.saved, r2.failed.length], [TOTAL - 20, 0]);
  assert.equal([...repo2.data.keys()].filter((k) => k.startsWith('cleaningTasks/')).length, TOTAL, 'exactly TOTAL — no duplicates');
});

test('invalid payloads are never sent; already-present tasks are skipped without a write', async () => {
  const repo = fakeRepo(); const s = await store(repo);
  const w = realisticWrites('en').slice(0, 3);
  w[0] = { ...w[0], data: { ...w[0].data, title: 'x'.repeat(121) } };
  const r = await s.applySetup(w);
  assert.deepEqual(r.failed.map((f) => f.reason), ['invalid']); assert.equal(r.saved, 2);
  const r2 = await s.applySetup(w.slice(1));
  assert.deepEqual([r2.saved, r2.alreadyExisted], [0, 2]); assert.equal(repo.commits.length, 2, 'no extra writes');
});
