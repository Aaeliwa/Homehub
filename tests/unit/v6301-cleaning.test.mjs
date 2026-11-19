// V6.3.0.1 Cleaning reset concurrency: reset generations. The fake repository applies the SAME generation
// conditions as firestore.rules (occurrence taskGen == task resetGen; resetGen only +1), so stale tabs /
// devices, captured bulk selections and stale retries are refused exactly as on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completableItems, progressResetPlan, restoreDefaultsPlan, genOf } from '../../src/modules/cleaning/cleaning-ops.js';
import { buildAction } from '../../src/modules/cleaning/cleaning-model.js';
import { createCleaningStore } from '../../src/modules/cleaning/cleaning-store.js';

const DAY = '2026-11-18'; const YMD = '20261118';
const T = (id, extra = {}) => ({ id, title: id, active: true, startDate: '2026-11-01', recurrence: { kind: 'days', interval: 1 }, assignMode: 'shared', assigneeUids: [], eligibleUids: [], priority: 'normal', ...extra });
const member = { uid: 'u', can: (p) => p === 'cleaning.view' || p === 'cleaning.complete', isChild: false };
const denied = () => Object.assign(new Error('denied'), { code: 'permission-denied' });

/** Shared "server" + per-device listeners (a device can be frozen = its snapshot goes stale). */
function server() {
  const data = new Map(); const devices = []; const commits = []; let deny = () => false;
  const list = (p) => [...data.entries()].filter(([k]) => k.startsWith(p)).map(([k, d]) => ({ id: k.split('/')[1], ...d }));
  const fire = () => { for (const d of devices) if (!d.frozen) for (const w of d.ws) w(); };
  const ruleOk = (o) => {
    const key = `${o.name}/${o.id}`; const cur = data.get(key); const next = o.mode === 'set' ? o.data : { ...cur, ...o.data };
    if (o.mode === 'set' && cur && /^cleaning/.test(o.name)) return false;   // create-only
    if (o.name === 'cleaningOccurrences') {   // rules: incoming().get('taskGen', 0) == task.get('resetGen', 0)
      const tk = data.get(`cleaningTasks/${next.taskId}`); return !!tk && (next.taskGen ?? 0) === (tk.resetGen ?? 0);
    }
    if (o.name === 'cleaningTasks' && o.mode === 'update' && 'resetGen' in o.data && o.data.resetGen !== (cur.resetGen ?? 0)) return o.data.resetGen === (cur.resetGen ?? 0) + 1;
    return true;
  };
  const srv = { data, commits, setDeny(f) { deny = f; }, fire,
    device() {
      const dev = { ws: new Set(), frozen: false };
      devices.push(dev);
      const repo = { now: () => 'NOW', newId: () => 'tid',
        watchTasks(h, on) { const w = () => on(list('cleaningTasks/')); dev.ws.add(w); queueMicrotask(w); return () => dev.ws.delete(w); },
        watchOccurrences(h, f, on) { const w = () => on(list('cleaningOccurrences/')); dev.ws.add(w); queueMicrotask(w); return () => dev.ws.delete(w); },
        taskExists: async (h, id) => data.has(`cleaningTasks/${id}`),
        async commit(h, ops) {
          await new Promise((r) => setTimeout(r, 1));
          for (const o of ops) if (deny(o) || !ruleOk(o)) throw denied();
          commits.push(...ops.map((o) => `${o.mode}:${o.name}:${o.id}`));
          for (const o of ops) data.set(`${o.name}/${o.id}`, o.mode === 'set' ? { ...o.data } : { ...data.get(`${o.name}/${o.id}`), ...o.data });
          fire();
        } };
      return { dev, repo };
    } };
  return srv;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function store(srv, uid = 'u') {
  const { dev, repo } = srv.device();
  const s = createCleaningStore({ homeId: 'H', uid, repo, today: () => DAY }); s.ensure({ canView: true }); s.subscribe(() => {}); await tick();
  return { s, dev };
}
const occ = (srv, id) => srv.data.get(`cleaningOccurrences/${id}`);
async function seeded(ids = ['a', 'b']) {
  const srv = server(); for (const id of ids) srv.data.set(`cleaningTasks/${id}`, T(id));
  const A = await store(srv); const B = await store(srv); srv.fire(); await tick();
  return { srv, A, B };
}
const resetNow = async (s) => { const snap = s.getSnapshot(); return s.resetProgress(progressResetPlan({ tasks: snap.tasks, occurrences: snap.occurrences, today: DAY })); };

test('V6301-1 occurrence writes carry the generation; generation 0 stays absent (older documents valid)', () => {
  const b0 = buildAction({ task: T('a'), date: DAY, occ: null, action: 'complete', uid: 'u', now: 'N' });
  assert.ok(!('taskGen' in b0.data), 'gen 0 → field absent');
  const b2 = buildAction({ task: T('a', { resetGen: 2 }), date: DAY, occ: null, action: 'complete', uid: 'u', now: 'N' });
  assert.equal(b2.data.taskGen, 2);
  const up = buildAction({ task: T('a', { resetGen: 3 }), date: DAY, occ: { id: `a_${YMD}`, status: 'done', rev: 1, taskGen: 2 }, action: 'reopen', uid: 'u', now: 'N' });
  assert.equal(up.data.taskGen, 3, 'an update states the current generation');
  assert.equal(buildAction({ task: T('a', { resetGen: 3 }), date: DAY, occ: null, action: 'complete', uid: 'u', now: 'N', taskGen: 1 }).data.taskGen, 1, 'a captured generation is sent as captured');
});

test('V6301-2 Mark All Done captured before a reset is never applied after it (client revalidation + rules)', async () => {
  const { srv, A, B } = await seeded();
  const sel = completableItems(['a', 'b'].map((id) => ({ task: T(id), date: DAY, occ: null, occId: null })), member);
  assert.deepEqual(sel.map((x) => x.gen), [0, 0]);
  await resetNow(B.s); await tick();   // another device resets meanwhile
  assert.equal(genOf(srv.data.get('cleaningTasks/a')), 1);
  const r = await A.s.completeSelection(sel, member);
  assert.deepEqual([r.saved, r.skipped, r.failed.length], [0, 2, 0], 'stale selection dropped at commit');
  assert.equal(occ(srv, `a_${YMD}`), undefined, 'nothing written');
  // even if the client check were bypassed (snapshot lagging), the server refuses the old generation
  A.dev.frozen = true;
  await assert.rejects(A.s.act('a', DAY, 'complete', null, { taskGen: 0 }), (e) => e.detail === 'cleaning.validation.conflict');
});

test('V6301-3 a stale device (snapshot from before the reset) cannot complete, reopen or resurrect; after refresh it works', async () => {
  const { srv, A, B } = await seeded(['a']);
  await A.s.act('a', DAY, 'complete', null); await tick();
  B.dev.frozen = true;                               // B still sees gen 0 and the done occurrence
  await resetNow(A.s); await tick();
  assert.deepEqual([genOf(srv.data.get('cleaningTasks/a')), occ(srv, `a_${YMD}`).status, occ(srv, `a_${YMD}`).taskGen], [1, 'open', 1], 'generation first, then audited undo under it');
  await assert.rejects(B.s.act('a', DAY, 'reopen', null), (e) => e.detail === 'cleaning.validation.conflict', 'stale reopen refused');
  assert.equal(occ(srv, `a_${YMD}`).status, 'open');
  B.dev.frozen = false; srv.fire(); await tick();
  await B.s.act('a', DAY, 'complete', null);
  assert.equal(occ(srv, `a_${YMD}`).status, 'done', 'fresh snapshot → new progress is accepted');
});

test('V6301-4 reset order + failures: undo never runs for a task whose generation bump failed; retry finishes; stale retry refused', async () => {
  const { srv, A } = await seeded(['a', 'b']);
  await A.s.act('a', DAY, 'complete', null); await A.s.act('b', DAY, 'complete', null); await tick();
  srv.setDeny((o) => o.name === 'cleaningTasks' && o.id === 'b');
  const r1 = await resetNow(A.s); await tick();
  assert.deepEqual(srv.commits.filter((c) => /cleaningTasks|cleaningOccurrences:a_/.test(c)).slice(-2), ['update:cleaningTasks:a', `update:cleaningOccurrences:a_${YMD}`], 'task generation before its undo');
  assert.equal(occ(srv, `b_${YMD}`).status, 'done', 'b untouched (its bump failed)');
  assert.deepEqual([r1.retry.patches.map((p) => p.id), r1.retry.undo.map((u) => u.taskId)], [['b'], ['b']]);
  srv.setDeny(() => false);
  const r2 = await A.s.resetProgress(r1.retry); await tick();
  assert.deepEqual([r2.saved, r2.failed.length, occ(srv, `b_${YMD}`).status, genOf(srv.data.get('cleaningTasks/b'))], [2, 0, 'open', 1]);
  // re-running the same (now stale) retry plan: already applied → no second bump, nothing reopened again
  const r3 = await A.s.resetProgress(r1.retry); await tick();
  assert.deepEqual([r3.failed.length, genOf(srv.data.get('cleaningTasks/b'))], [0, 1], 'idempotent');
  // a retry plan from BEFORE a newer reset can never move the generation back or sideways
  await resetNow(A.s); await tick();
  assert.equal(genOf(srv.data.get('cleaningTasks/b')), 2);
  const r4 = await A.s.resetProgress({ patches: [{ id: 'b', data: { resetGen: 1 } }], undo: [] });
  assert.deepEqual([r4.failed.length, genOf(srv.data.get('cleaningTasks/b'))], [1, 2], 'stale generation refused');
});

test('V6301-5 two devices resetting at the same time: one generation step, no double undo, audit kept', async () => {
  const { srv, A, B } = await seeded(['a']);
  await A.s.act('a', DAY, 'complete', null); await tick();
  const [ra, rb] = await Promise.all([resetNow(A.s), resetNow(B.s)]); await tick();
  assert.equal(genOf(srv.data.get('cleaningTasks/a')), 1, 'both computed 0 → 1; the second is a no-op');
  assert.equal(ra.failed.length + rb.failed.length, 0);
  assert.equal(occ(srv, `a_${YMD}`).status, 'open');
  assert.equal(srv.commits.filter((c) => c.startsWith('set:cleaningLog:') && c.includes(`a_${YMD}`)).length, 2, 'complete + ONE reopen');
});

test('V6301-6 an edit form opened before a reset cannot write the old schedule back', async () => {
  const { srv, A } = await seeded(['a']);
  await resetNow(A.s); await tick();
  await assert.rejects(A.s.updateTask('a', { startDate: '2026-11-01' }, { memberUids: ['u'], baseGen: 0 }), (e) => e.detail === 'cleaning.validation.conflict');
  assert.equal(srv.data.get('cleaningTasks/a').startDate, DAY);
  assert.equal(await A.s.updateTask('a', { title: 'Renamed' }, { memberUids: ['u'], baseGen: 1 }), true, 'fresh form works');
});

test('V6301-7 restore defaults: definition + generation in one write; undo under the new generation; stale completion refused', async () => {
  const srv = server();
  const rooms = [{ id: 'k1', name: 'k1', type: 'kitchen', active: true }];
  const plan0 = restoreDefaultsPlan({ rooms, devices: [], tasks: [], lang: 'en', uid: 'u', now: 'NOW', today: '2026-11-01' });
  const A = await store(srv); const B = await store(srv);
  await A.s.restoreDefaults(plan0, { today: '2026-11-01' }); await tick();
  const id = plan0.creates[0].id;
  await A.s.act(id, DAY, 'complete', null).catch(() => {}); await tick();
  B.dev.frozen = true;
  const snap = A.s.getSnapshot();
  const plan = restoreDefaultsPlan({ rooms, devices: [], tasks: snap.tasks, lang: 'en', uid: 'u', now: 'NOW', today: DAY });
  const before = srv.commits.length;
  const r = await A.s.restoreDefaults(plan, { today: DAY }); await tick();
  assert.equal(r.failed.length, 0);
  const taskWrites = srv.commits.slice(before).filter((c) => c === `update:cleaningTasks:${id}`);
  assert.equal(taskWrites.length, 1, 'one write per restored default');
  assert.equal(genOf(srv.data.get(`cleaningTasks/${id}`)), 1);
  const o = occ(srv, `${id}_${YMD}`); assert.deepEqual([o.status, o.taskGen], ['open', 1], 'progress reset under the new generation');
  const stale = B.s.getSnapshot().occurrences.find((x) => x.id === `${id}_${YMD}`);
  await assert.rejects(B.s.act(id, DAY, stale && stale.status === 'done' ? 'reopen' : 'complete', null), 'stale device refused');
  assert.deepEqual([occ(srv, `${id}_${YMD}`).status, occ(srv, `${id}_${YMD}`).taskGen], ['open', 1], 'reset state unchanged by the stale device');
  const again = restoreDefaultsPlan({ rooms, devices: [], tasks: A.s.getSnapshot().tasks, lang: 'en', uid: 'u', now: 'NOW', today: DAY });
  assert.deepEqual([again.creates, again.patches, again.reactivate], [[], [], []], 'definitions still idempotent');
});
