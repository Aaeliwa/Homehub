import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../src/modules/chef/recipe-model.js';
import * as T from '../../src/modules/chef/timer-model.js';
import { createChefStore } from '../../src/modules/chef/chef-store.js';
import { resetActionFor, completeAllItems, resetAllItems } from '../../src/modules/cleaning/cleaning-model.js';

test('YouTube parser: accepted forms → 11-char id; lookalikes, credentials, bad ids, HTML and schemes rejected', () => {
  const ID = 'dQw4w9WgXcQ';
  for (const u of [`https://www.youtube.com/watch?v=${ID}`, `https://youtube.com/watch?v=${ID}&t=30s`, `https://m.youtube.com/watch?v=${ID}`, `https://music.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`, `https://youtu.be/${ID}?si=x`, `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/embed/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`]) assert.equal(R.parseYouTube(u), ID, u);
  for (const u of [`https://www.youtube.com.evil.com/watch?v=${ID}`, `https://evilyoutube.com/watch?v=${ID}`, `https://user:pw@www.youtube.com/watch?v=${ID}`, `https://www.youtube.com:8443/watch?v=${ID}`,
    'https://www.youtube.com/watch?v=short', `https://www.youtube.com/watch?v=${ID}x`, `https://www.youtube.com/playlist?list=${ID}`, `<iframe src="https://www.youtube.com/embed/${ID}"></iframe>`,
    `javascript:alert(1)//youtube.com/watch?v=${ID}`, `ftp://youtube.com/watch?v=${ID}`, '', null]) assert.equal(R.parseYouTube(u), null, String(u));
  assert.equal(R.embedUrl(ID), `https://www.youtube-nocookie.com/embed/${ID}?autoplay=1&rel=0&playsinline=1`);
});

test('amounts: integer thousandths; fractions, Arabic digits; display-only scaling never drifts', () => {
  assert.deepEqual(['2', '1.5', '1½', '1 1/2', '3/4', '٢', '0.125', ''].map(R.parseAmount), [2000, 1500, 1500, 1500, 750, 2000, 125, null]);
  for (const bad of ['-1', 'abc', '1/0', '0', '1.2345']) assert.throws(() => R.parseAmount(bad), /recipes\.err\.amount/, bad);
  const base = 1500;
  assert.equal(R.formatAmount(R.scaleMilli(base, 4, 6)), '2 ¼');
  for (let i = 0; i < 50; i++) R.scaleMilli(base, 4, i % 2 ? 6 : 4);   // up / down repeatedly …
  assert.equal(R.scaleMilli(base, 4, 4), 1500, '… is always computed from the immutable base (no drift)');
  assert.equal(R.scaleMilli(base, 4, 6), 2250);
  assert.deepEqual([R.formatAmount(500), R.formatAmount(333), R.formatAmount(1667), R.formatAmount(1234), R.formatAmount(null)], ['½', '⅓', '1 ⅔', '1.23', '']);
});

test('recipes: validation, stable ids on edit, duplicate gets NEW ids, empty rows dropped, bounds', () => {
  const { value, errors } = R.validateRecipe({ titleEn: 'Koshari', category: 'main', servings: 4, video: 'https://youtu.be/dQw4w9WgXcQ',
    ingredients: [{ id: 'iabc123', name: 'Rice', amount: '1 1/2', unit: 'cup' }, { name: '' }], steps: [{ text: 'Boil', minutes: 10 }, { text: ' ' }] });
  assert.deepEqual(errors, {});
  assert.deepEqual([value.videoId, value.ingredients.length, value.ingredients[0].id, value.ingredients[0].amountMilli, value.steps.length, value.steps[0].minutes], ['dQw4w9WgXcQ', 1, 'iabc123', 1500, 1, 10]);
  assert.equal(R.validateRecipe({}).errors.title, 'recipes.err.title');
  // V6.1.1: other sites are stored as a safe LINK (never embedded); unsafe schemes are still rejected.
  const vimeo = R.validateRecipe({ titleEn: 'x', video: 'https://vimeo.com/1' }).value; assert.deepEqual([vimeo.videoId, vimeo.videoUrl], [null, 'https://vimeo.com/1']);
  assert.equal(R.validateRecipe({ titleEn: 'x', video: 'javascript:alert(1)' }).errors.video, 'recipes.err.video');
  assert.equal(R.validateRecipe({ titleEn: 'x', servings: 0 }).errors.servings, 'recipes.err.number');
  const dup = R.validateRecipe(R.duplicateInput({ ...value, id: 'r1' }, '(copy)')).value;
  assert.equal(dup.titleEn, 'Koshari (copy)'); assert.notEqual(dup.ingredients[0].id, 'iabc123', 'duplicate: new ingredient ids');
  const p = R.editPatch({ ...value, rev: 3 }, { ...value, notes: 'Spicy' }, { uid: 'u', now: 'N' });
  assert.deepEqual(Object.keys(p).sort(), ['notes', 'rev', 'updatedAt', 'updatedBy']); assert.equal(p.rev, 4);
});

test('timers: remaining derived from absolute time (refresh-safe); transitions; completion only when due', () => {
  assert.equal(T.durationMs({ h: 1, m: 2, s: 3 }), 3723000);
  for (const bad of [{ s: 0 }, { h: 25 }, { m: 60 }, { s: -1 }]) assert.throws(() => T.durationMs(bad), /timers\.err\.duration/);
  const t0 = 1_000_000; const c = T.createFields({ label: 'Rice', durationMs: 600000 }, t0);
  const tm = { ...c, id: 't', rev: 1 };
  assert.equal(T.remainingMs(tm, t0 + 125000), 475000, 'any re-render / reload derives the same value');
  const paused = { ...tm, ...T.transition(tm, 'pause', t0 + 125000) };
  assert.deepEqual([paused.status, paused.remainingMsAtPause, T.remainingMs(paused, t0 + 999999)], ['paused', 475000, 475000]);
  const resumed = { ...paused, ...T.transition(paused, 'resume', t0 + 200000) };
  assert.equal(resumed.endsAtMs, t0 + 200000 + 475000);
  assert.throws(() => T.transition(resumed, 'complete', t0 + 200000), /timers\.err\.state/, 'not due yet');
  assert.equal(T.transition(resumed, 'complete', resumed.endsAtMs).status, 'completed');
  assert.equal(T.transition({ ...tm, status: 'completed' }, 'restart', t0).endsAtMs, t0 + 600000);
  assert.equal(T.fmt(3723000), '1:02:03'); assert.equal(T.fmt(65000), '01:05');
});

function fakeRepo() {
  const db = new Map(); const ws = new Set(); let n = 0; const commits = [];
  const docs = (p) => [...db.entries()].filter(([k]) => k.startsWith(p)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  return { db, commits, now: () => 'N', newId: (h, c) => `${c.slice(0, 3)}${String(++n).padStart(5, '0')}`,
    watchRecipes: (h, on) => { const f = () => on(docs('recipes/')); ws.add(f); queueMicrotask(f); return () => ws.delete(f); },
    watchTimers: (h, uid, on) => { const f = () => on(docs('cookingTimers/').filter((x) => x.ownerUid === uid)); ws.add(f); queueMicrotask(f); return () => ws.delete(f); },
    async commit(h, ops) {
      for (const o of ops) { const k = `${o.name}/${o.id}`; if (o.mode === 'update' && o.data.rev !== undefined && db.get(k) && o.data.rev !== db.get(k).rev + 1) throw Object.assign(new Error('stale'), { code: 'permission-denied' }); }
      for (const o of ops) { const k = `${o.name}/${o.id}`; commits.push(`${o.mode}:${k}`); if (o.mode === 'delete') db.delete(k); else db.set(k, o.mode === 'set' ? { ...o.data } : { ...db.get(k), ...o.data }); }
      for (const f of ws) f();
    }, get watchers() { return ws.size; } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('chef store: recipes CRUD / favorites (own uid) / archive; timers: no per-second writes; two tabs complete once; alarm once per tab; cleanup', async () => {
  let now = 1_000_000; const repo = fakeRepo();
  const A = createChefStore({ homeId: 'H', uid: 'u1', repo, canViewRecipes: true, nowMs: () => now });
  const B = createChefStore({ homeId: 'H', uid: 'u1', repo, canViewRecipes: true, nowMs: () => now });   // a second tab, same user
  A.subscribe(() => {}); B.subscribe(() => {}); await tick();
  const id = await A.createRecipe({ titleEn: 'Soup', servings: 2 }); await tick();
  await A.toggleFavorite(id); await tick(); assert.deepEqual(repo.db.get(`recipes/${id}`).favoritedBy, ['u1']);
  await A.toggleFavorite(id); await tick(); assert.deepEqual(repo.db.get(`recipes/${id}`).favoritedBy, []);
  await A.archiveRecipe(id, true); await tick(); assert.equal(repo.db.get(`recipes/${id}`).archived, true);
  const tid = await A.createTimer({ label: 'Rice', durationMs: 5000 }); await tick();
  const before = repo.commits.length;
  const rings = []; const alarm = (t) => rings.push(t.id);
  const offA = A.useTicker(alarm); const offA2 = A.useTicker(alarm);   // two panels in one tab share one ticker + one handler
  const offB = B.useTicker(alarm);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(repo.commits.length, before, 'no writes while running (no per-second persistence)');
  now += 5000; await new Promise((r) => setTimeout(r, 1100)); await tick();
  assert.equal(repo.db.get(`cookingTimers/${tid}`).status, 'completed');
  assert.equal(repo.commits.filter((c) => c === `update:cookingTimers/${tid}`).length, 1, 'completed exactly once across two tabs');
  assert.deepEqual(rings, [tid, tid], 'one ring per tab (tab A has two panels, rings once)');
  offA(); offA2(); offB(); A.dispose(); B.dispose(); assert.equal(repo.watchers, 0, 'listeners released');
});

test('cleaning room actions: reset = inverse action; current-room only; rights respected', () => {
  assert.deepEqual(['done', 'claimed', 'skipped', 'postponed', 'open'].map((s) => resetActionFor({ status: s })), ['reopen', 'unclaim', 'resume', 'resume', null]);
  const task = (id, roomId, extra = {}) => ({ id, roomId, active: true, assignMode: 'shared', assigneeUids: [], eligibleUids: [], ...extra });
  const it = (tk, occ) => ({ task: tk, date: '2026-11-10', occ });
  const board = { overdue: [], today: [it(task('a', 'kit'), null), it(task('b', 'kit'), { status: 'done', completedBy: 'u1' }), it(task('c', 'kit'), { status: 'done', completedBy: 'other' }),
    it(task('d', 'bath'), null), it(task('e', 'kit'), { status: 'claimed', claimedBy: 'other' })] };
  const can = (p) => p === 'cleaning.view' || p === 'cleaning.complete';
  assert.deepEqual(completeAllItems(board, 'kit', { uid: 'u1', can, isChild: false }).map((x) => x.taskId), ['a', 'e'], 'kitchen only; not done; V6.3: a legacy claim no longer blocks an eligible member');
  const priv = { overdue: [], today: [it(task('p', 'kit', { assignMode: 'assigned', assigneeUids: ['other'] }), { status: 'claimed', claimedBy: 'other' })] };
  assert.deepEqual(completeAllItems(priv, 'kit', { uid: 'u1', can, isChild: false }), [], 'never a task assigned to someone else');
  assert.deepEqual(resetAllItems(board, 'kit', { uid: 'u1', can, isChild: false }).map((x) => [x.taskId, x.action]), [['b', 'reopen']], 'only what I may undo');
  assert.deepEqual(resetAllItems(board, 'kit', { uid: 'u1', can: (p) => true, isChild: false }).map((x) => x.taskId), ['b', 'c', 'e'], 'editors may undo others');
});

// ---------------------------------------------------------------- V6.1.1
import { useAlarm } from '../../src/modules/chef/alarm.js';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('V6.1.1 timers: completed = ringing until dismissed; active / ringing semantics', () => {
  const now = 5_000_000;
  const tm = (status, extra = {}) => ({ id: 'x', status, durationMs: 60000, endsAtMs: null, remainingMsAtPause: null, rev: 1, ...extra });
  assert.deepEqual(['idle', 'running', 'paused', 'completed', 'dismissed'].map((s) => T.isActive(tm(s, s === 'running' ? { endsAtMs: now + 1 } : s === 'paused' ? { remainingMsAtPause: 5 } : {}), now)), [false, true, true, true, false]);
  assert.equal(T.isRinging(tm('running', { endsAtMs: now - 1 }), now), true, 'due before the completion write lands');
  assert.deepEqual(T.transition(tm('completed'), 'dismiss', now), { status: 'dismissed', endsAtMs: null, remainingMsAtPause: null });
  assert.throws(() => T.transition(tm('running', { endsAtMs: now + 5 }), 'dismiss', now), /timers\.err\.state/, 'only a ringing alarm is stopped');
  assert.equal(T.transition(tm('dismissed'), 'restart', now).status, 'running');
});

test('V6.1.1 alarm coordinator: repeats until explicit stop; one per store (no overlap); per-timer stop; blocked audio → enable; persisted across reload and tabs', async () => {
  const repo = fakeRepo(); let now = 1_000_000;
  const mk = () => createChefStore({ homeId: 'H', uid: 'u1', repo, canViewRecipes: true, nowMs: () => now });
  const A = mk(); A.subscribe(() => {}); await tick();
  const t1 = await A.createTimer({ label: 'Rice', durationMs: 1000 }); const t2 = await A.createTimer({ label: 'Eggs', durationMs: 1000 }); await tick();
  for (const id of [t1, t2]) await repo.commit('H', [{ mode: 'update', name: 'cookingTimers', id, data: { status: 'completed', endsAtMs: null, rev: 2 } }]);
  await tick();
  let beeps = 0; let allow = false; let closed = 0;
  const audio = { beep: () => { if (!allow) return false; beeps++; return true; }, unlock: async () => { allow = true; return true; }, close: () => { closed++; } };
  const p1 = useAlarm(A, { audio, intervalMs: 20 }); const p2 = useAlarm(A, { audio, intervalMs: 20 });   // dashboard + cooking mode
  assert.equal(p1.coordinator, p2.coordinator, 'ONE coordinator per store');
  assert.equal(p1.coordinator.ringing.length, 2, 'both expired timers individually ringing');
  await wait(30); assert.equal(p1.coordinator.audioBlocked, true, 'autoplay blocked → visual alarm + Enable sound');
  await p1.coordinator.enableSound(); assert.equal(p1.coordinator.audioBlocked, false);
  const b0 = beeps; await wait(110); assert.ok(beeps - b0 >= 3 && beeps - b0 <= 7, `repeats on one interval, no overlap (${beeps - b0})`);
  // Reload: a fresh store (same data) still sees both alarms ringing — persisted, not forgotten.
  const R = mk(); R.subscribe(() => {}); await tick();
  assert.equal(R.getSnapshot().timers.filter((x) => T.isRinging(x, now)).length, 2, 'refresh-persistent');
  // Stop ONE alarm — the other keeps ringing.
  await A.dismissAlarm(t1); await tick();
  assert.deepEqual(p1.coordinator.ringing.map((x) => x.id), [t2]);
  // Another tab stops the second; this tab's late Stop is an idempotent no-op.
  await R.dismissAlarm(t2); await tick();
  await A.dismissAlarm(t2);
  assert.equal(p1.coordinator.ringing.length, 0);
  const b1 = beeps; await wait(60); assert.equal(beeps, b1, 'silent after the last stop');
  p1.release(); p2.release(); assert.equal(closed, 1, 'audio closed when the last view unmounts');
  A.dispose(); R.dispose();
});

test('V6.1.1 recipes: safe non-YouTube links; soft delete hides + freezes; stale UI cannot act on a deleted recipe', async () => {
  assert.equal(R.safeVideoUrl('https://www.facebook.com/watch?v=1'), 'https://www.facebook.com/watch?v=1');
  for (const bad of ['http://facebook.com/x', 'https://u:p@facebook.com/x', 'https://facebook.com:444/x', 'javascript:alert(1)', 'data:text/html,1', 'https://localhost/x', 'https://a.com/<b>', `https://a.com/${'x'.repeat(500)}`]) assert.equal(R.safeVideoUrl(bad), null, bad);
  assert.deepEqual(['https://fb.watch/x', 'https://www.instagram.com/reel/1', 'https://example.org/v'].map(R.videoSourceName), ['Facebook', 'Instagram', 'example.org']);
  const yt = R.validateRecipe({ titleEn: 'x', video: 'https://youtu.be/dQw4w9WgXcQ' }).value; assert.deepEqual([yt.videoId, yt.videoUrl], ['dQw4w9WgXcQ', null], 'YouTube keeps the player');
  const look = R.validateRecipe({ titleEn: 'x', video: 'https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ' }).value;
  assert.deepEqual([look.videoId, look.videoUrl], [null, 'https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ'], 'a lookalike is only ever a LINK, never embedded');
  const repo = fakeRepo(); const S = createChefStore({ homeId: 'H', uid: 'u1', repo, canViewRecipes: true }); S.subscribe(() => {}); await tick();
  const id = await S.createRecipe({ titleEn: 'Soup' }); await tick();
  await S.deleteRecipe(id); await tick();
  const d = repo.db.get(`recipes/${id}`); assert.deepEqual([!!d.deletedAt, d.deletedBy, R.isDeleted(d)], [true, 'u1', true], 'soft-deleted, still stored');
  for (const [name, fn] of [['edit', () => S.editRecipe(id, { titleEn: 'x' })], ['duplicate', () => S.duplicateRecipe(id, '(c)')], ['archive', () => S.archiveRecipe(id, true)], ['favorite', () => S.toggleFavorite(id)], ['delete', () => S.deleteRecipe(id)]])
    await assert.rejects(fn(), (e) => e.detail === 'recipes.err.deleted', name);
  S.dispose();
});
