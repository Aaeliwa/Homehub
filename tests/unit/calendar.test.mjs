import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../../src/modules/calendar/calendar-model.js';
import { createCalendarStore } from '../../src/modules/calendar/calendar-store.js';

const FIXTURE = readFileSync(new URL('../fixtures/google-calendar-2026.csv', import.meta.url), 'utf8');

test('Google CSV fixture: 8 events, 9 blank lines ignored; US dates / 12-h times; shifts → work; Private flag; stable ids', () => {
  const p = C.previewImport(FIXTURE);
  assert.deepEqual([p.rows.length, p.blank, p.rows.filter((r) => r.ok).length], [8, 9, 8]);
  const n = p.rows[2];   // Night Shift 1/31 7 PM → 2/10 7 AM (crosses a month)
  assert.deepEqual([n.value.title, n.value.type, n.value.startDate, n.value.startTime, n.value.endDate, n.value.endTime, n.value.allDay, n.private],
    ['Night Shift', 'work', '2026-01-31', '19:00', '2026-02-10', '07:00', false, true]);
  assert.ok(p.rows.every((r) => r.value.type === 'work' && /^csv_[0-9a-f]{16}$/.test(r.id)));
  assert.deepEqual(C.previewImport(FIXTURE).rows.map((r) => r.id), p.rows.map((r) => r.id), 'deterministic import identity');
  const again = C.previewImport(FIXTURE, { existingIds: new Set(p.rows.map((r) => r.id)) });
  assert.ok(again.rows.every((r) => r.duplicate), 're-import → every row is a duplicate (nothing rewritten)');
});

test('CSV parser: quotes, "" escapes, embedded commas / newlines, CRLF, BOM; per-row errors; bad files refused', () => {
  assert.deepEqual(C.parseCsv('﻿a,"b,c","d ""q"""\r\n"x\ny",2\n'), [['a', 'b,c', 'd "q"'], ['x\ny', '2']]);
  const H = 'Subject,Start Date,Start Time,End Date,End Time,All Day Event,Description,Location,Private\n';
  const p = C.previewImport(`${H}"Eid, family",4/10/2026,,4/12/2026,,TRUE,"note, ""quoted""",Home,FALSE\nBad,13/40/2026,7:00 AM,1/1/2026,8:00 AM,FALSE,,,FALSE\nNo time,1/2/2026,,1/2/2026,,FALSE,,,FALSE\n`);
  assert.deepEqual([p.rows[0].ok, p.rows[0].value.title, p.rows[0].value.allDay, p.rows[0].value.description], [true, 'Eid, family', true, 'note, "quoted"']);
  assert.deepEqual([p.rows[1].ok, p.rows[1].errors.includes('calendar.err.date')], [false, true]);
  assert.deepEqual([p.rows[2].ok, p.rows[2].errors.includes('calendar.err.time')], [false, true]);
  assert.throws(() => C.previewImport('Title,When\nx,y'), /calendar\.import\.columns/);
  assert.throws(() => C.previewImport(`${H}"open`), /calendar\.import\.badQuotes/);
  assert.equal(C.classify('Annual leave'), 'vacation'); assert.equal(C.classify('Dentist'), 'other');
  assert.deepEqual(['12:00:00 AM', '12:30 PM', '7:05:00 pm', '13:00 PM'].map(C.usTime), ['00:00', '12:30', '19:05', null]);
});

test('date coverage policy, cross-month, overnight, month boundaries; Monday-first grid', () => {
  const night = { id: 'n', startDate: '2026-01-31', startTime: '19:00', endDate: '2026-02-10', endTime: '07:00', allDay: false, type: 'work' };
  assert.ok(C.covers(night, '2026-01-31') && C.covers(night, '2026-02-01') && C.covers(night, '2026-02-10'), 'every touched date, both months');
  const toMidnight = { id: 'm', startDate: '2026-03-01', startTime: '20:00', endDate: '2026-03-02', endTime: '00:00', allDay: false, type: 'other' };
  assert.equal(C.lastDate(toMidnight), '2026-03-01', 'ends exactly at 00:00 → the next day is not covered');
  assert.deepEqual(C.inRange([night], '2026-02-01', '2026-02-28').map((e) => e.id), ['n']);
  assert.deepEqual(C.inRange([{ ...night, deletedAt: 'x' }], '2026-02-01', '2026-02-28'), [], 'deleted events never count');
  const g = C.monthGrid('2026-11'); assert.deepEqual([g[0], g.length, g.at(-1)], ['2026-10-26', 42, '2026-12-06'], 'Nov 2026 starts on a Sunday → Monday-first');
  assert.equal(C.monthGrid('2026-02')[0], '2026-01-26');
  assert.deepEqual([C.shiftMonth('2026-12', 1), C.shiftMonth('2026-01', -1)], ['2027-01', '2025-12'], 'year boundaries');
});

test('work / vacation intervals: gaps are SUGGESTIONS (never vacation); confirmed vacation; overlaps; reclassify; delete', () => {
  const evs = C.previewImport(FIXTURE).rows.map((r) => ({ ...r.value, id: r.id }));
  const gaps = C.offDutyGaps(evs);
  assert.deepEqual(gaps[0], { start: '2026-01-09', end: '2026-01-10', days: 2, confirmed: false });
  assert.deepEqual(C.intervals(evs, 'vacation'), [], 'no vacation is ever inferred from gaps');
  const vac = { id: 'v1', title: 'Trip', type: 'vacation', allDay: true, startDate: '2026-01-09', endDate: '2026-01-10' };
  assert.equal(C.offDutyGaps([...evs, vac])[0].confirmed, true);
  const ivs = C.intervals([...evs, vac, { ...vac, id: 'v2', startDate: '2026-01-10', endDate: '2026-01-12' }], 'vacation');
  assert.equal(ivs.length, 2); assert.ok(C.inAny(ivs, '2026-01-10'), 'overlap → membership, never counted twice');
  assert.deepEqual(C.intervals([{ ...vac, type: 'other' }], 'vacation'), [], 'reclassified → no longer a vacation interval');
  assert.deepEqual(C.intervals([{ ...vac, deletedAt: 'x' }], 'vacation'), [], 'deleted vacation → stops matching');
});

const tick = () => new Promise((r) => setTimeout(r, 0));
function fakeRepo() {
  const db = new Map(); const bdb = new Map(); const ws = new Set(); let n = 0; const commits = [];
  const list = (m = db) => [...m.entries()].map(([id, v]) => ({ id, ...v }));
  const watch = (m, pred, on) => { const f = () => on(list(m).filter(pred)); ws.add(f); queueMicrotask(f); return () => ws.delete(f); };
  const repo = { db, bdb, commits, failOn: null, now: () => 'N', newId: (h, name) => `${name === 'calendarImports' ? 'bt' : 'ev'}${String(++n).padStart(5, '0')}`,
    watchHousehold: (h, on) => watch(db, (x) => x.audience === 'household', on),
    watchMine: (h, uid, on) => watch(db, (x) => x.createdBy === uid, on),
    watchImportsHousehold: (h, on) => watch(bdb, (x) => x.audience === 'household', on),
    watchImportsMine: (h, uid, on) => watch(bdb, (x) => x.createdBy === uid, on),
    async commit(h, ops) {
      if (ops.length > 450) throw new Error('batch too large');
      if (repo.failOn && repo.failOn(ops)) throw Object.assign(new Error('network'), { code: 'unavailable' });   // atomic: nothing applied
      const m = (o) => (o.name === 'calendarImports' ? bdb : db);
      for (const o of ops) if (o.mode === 'set' && m(o).has(o.id)) throw Object.assign(new Error('exists'), { code: 'permission-denied' });   // create-only
      for (const o of ops) { commits.push(`${o.mode}:${o.name || 'ev'}:${o.id}:${ops.length}`); m(o).set(o.id, o.mode === 'set' ? { ...o.data } : { ...m(o).get(o.id), ...o.data }); }
      for (const f of ws) f();
    }, get watchers() { return ws.size; } };
  return repo;
}

test('calendar store: CRUD; tasks done; soft delete; private visible to creator; idempotent import (re-run + concurrent); listener cleanup', async () => {
  const repo = fakeRepo(); const A = createCalendarStore({ homeId: 'H', uid: 'u1', timezone: 'Africa/Cairo', repo }); A.subscribe(() => {}); await tick();
  const id = await A.create({ title: 'Dentist', type: 'task', allDay: false, startDate: '2026-11-20', startTime: '09:00', endDate: '2026-11-20', endTime: '09:30' }); await tick();
  assert.equal(repo.db.get(id).timezone, 'Africa/Cairo');
  await A.setDone(id, true); await tick(); assert.equal(repo.db.get(id).done, true);
  await assert.rejects(A.create({ title: 'x', startDate: '2026-11-20', endDate: '2026-11-19', allDay: true }), (e) => e.detail === 'calendar.err.order');
  await A.remove(id); await tick(); assert.ok(repo.db.get(id).deletedAt, 'soft delete');
  await assert.rejects(A.edit(id, { title: 'y', startDate: '2026-11-20', allDay: true }), (e) => e.detail === 'calendar.err.deleted');
  const rows = C.previewImport(FIXTURE).rows;
  const r1 = await A.importRows(rows, { audience: 'household' }); await tick();
  assert.deepEqual([r1.created, r1.skipped, r1.failed.length], [8, 0, 0]);
  const r2 = await A.importRows(rows, { audience: 'household' }); assert.deepEqual([r2.created, r2.skipped], [0, 8], 're-import creates nothing');
  const theirs = repo.db.get(rows[0].id); repo.db.delete(rows[0].id);   // (simulate a concurrent importer the local snapshot has not seen yet)
  const B = createCalendarStore({ homeId: 'H', uid: 'u2', timezone: 'Africa/Cairo', repo }); B.subscribe(() => {}); await tick();
  repo.db.set(rows[0].id, { ...theirs, createdBy: 'u3' });
  const r3 = await B.importRows([rows[0]], { audience: 'household' }); assert.deepEqual([r3.created, r3.skipped], [0, 1], 'create-only race → reported as duplicate');
  assert.deepEqual(A.intervals('work').length, 8);
  await A.create({ title: 'Mine', type: 'other', allDay: true, startDate: '2026-11-21', audience: 'private' }); await tick();
  assert.ok(A.getSnapshot().events.some((e) => e.title === 'Mine')); assert.ok(!B.getSnapshot().events.some((e) => e.title === 'Mine'), 'private → creator only');
  A.dispose(); B.dispose(); assert.equal(repo.watchers, 0);
});

// ============================================================ V6.2.1 — CSV import batches
const csvOf = (n, prefix = 'Day Shift', from = 1) => ['Subject,Start Date,Start Time,End Date,End Time,All Day Event,Description,Location,Private',
  ...Array.from({ length: n }, (_, i) => { const x = new Date(Date.UTC(2026, 2, from + i)); const d = `${x.getUTCMonth() + 1}/${x.getUTCDate()}/2026`; return `${prefix} ${from + i},${d},7:00 AM,${d},7:00 PM,False,,,False`; })].join('\n');

test('V621 batches: provenance on every imported event; manual events carry none; one batch doc per import (file, count, status)', async () => {
  const repo = fakeRepo(); const A = createCalendarStore({ homeId: 'H', uid: 'u1', timezone: 'Africa/Cairo', repo }); A.subscribe(() => {}); await tick();
  const man = await A.create({ title: 'Dentist', type: 'task', allDay: true, startDate: '2026-11-20' }); await tick();
  assert.deepEqual([repo.db.get(man).importBatchId, repo.db.get(man).importRev], [null, null]);
  const rows = C.previewImport(FIXTURE).rows;
  const r = await A.importRows(rows, { audience: 'household', fileName: 'google-2026.csv' }); await tick();
  assert.equal(r.created, 8); const b = repo.bdb.get(r.batchId);
  assert.deepEqual([b.fileName, b.status, b.createdCount, b.audience, b.createdBy, b.rev], ['google-2026.csv', 'active', 8, 'household', 'u1', 2]);
  for (const x of rows) assert.deepEqual([repo.db.get(x.id).importBatchId, repo.db.get(x.id).importRev, repo.db.get(x.id).source], [r.batchId, 1, 'csv']);
  assert.equal(repo.commits.indexOf(`set:calendarImports:${r.batchId}:1`), repo.commits.findIndex((c) => c.startsWith('set:calendarImports')), 'batch written BEFORE its events');
  const again = await A.importRows(rows, { audience: 'household', fileName: 'google-2026.csv' });
  assert.deepEqual([again.created, again.skipped, again.batchId], [0, 8, null], 'dedupe kept; nothing new → no empty batch');
  assert.equal(A.getSnapshot().batches.length, 1); A.dispose();
});

test('V621 Remove Import: only that batch (never manual / another batch); edited events kept unless opted out; vacations stop matching; bounded chunks', async () => {
  const repo = fakeRepo(); const A = createCalendarStore({ homeId: 'H', uid: 'u1', timezone: 'Africa/Cairo', repo }); A.subscribe(() => {}); await tick();
  const man = await A.create({ title: 'Day Shift 3', type: 'work', allDay: true, startDate: '2026-03-03' }); await tick();   // same title / date as an imported row
  const one = await A.importRows(C.previewImport(csvOf(45)).rows, { audience: 'household', fileName: 'march.csv' }); await tick();
  const two = await A.importRows(C.previewImport(FIXTURE).rows, { audience: 'household', fileName: 'google.csv' }); await tick();
  const ev = (id) => A.getSnapshot().all.find((e) => e.id === id);
  const firstOfOne = C.batchMembers(A.getSnapshot().all, one.batchId)[0];
  await A.edit(firstOfOne.id, { ...firstOfOne, title: 'Day Shift (swapped)' }); await tick();
  assert.equal(C.isEdited(ev(firstOfOne.id)), true);
  const plan = A.removalPreview(one.batchId); assert.deepEqual([plan.targets.length, plan.edited.length, plan.keep.length], [44, 1, 1]);
  repo.commits.length = 0;
  const res = await A.removeBatch(one.batchId); await tick();
  assert.deepEqual([res.removed, res.kept], [44, 1]);
  const chunks = repo.commits.filter((c) => c.startsWith('update:ev:')).map((c) => Number(c.split(':').pop()));
  assert.ok(chunks.every((n) => n <= C.REMOVE_CHUNK) && chunks.length === 44, 'soft deletes in chunks of ≤ REMOVE_CHUNK');
  assert.ok(ev(man) && C.isLive(ev(man)), 'manual event with the same title / date untouched');
  assert.ok(C.batchMembers(A.getSnapshot().all, two.batchId).every(C.isLive), 'other batch untouched');
  assert.ok(C.isLive(ev(firstOfOne.id)), 'edited event kept');
  const b = repo.bdb.get(one.batchId); assert.deepEqual([b.status, b.removedCount, b.keptCount, b.createdCount], ['removed', 44, 1, 45]);
  assert.deepEqual(await A.removeBatch(one.batchId), { removed: 0, kept: 1, already: true }, 'idempotent');
  // opt out of keeping: everything of batch two goes, incl. an edited vacation → Finance filter stops matching
  const vac = C.batchMembers(A.getSnapshot().all, two.batchId)[0];
  await A.edit(vac.id, { ...vac, type: 'vacation', shift: null }); await tick();   // V6.2.2: explicit 'not a shift' override
  assert.equal(A.intervals('vacation').length, 1);
  await A.removeBatch(two.batchId, { keepEdited: false }); await tick();
  assert.deepEqual([A.intervals('vacation').length, A.intervals('work').length], [0, 2], 'vacation gone; manual + kept work stay');
  assert.ok(C.isLive(ev(man))); A.dispose();
});

test('V621 partial failure → batch stays "removing"; retry resumes only what is still live (no double write); events never hard-deleted', async () => {
  const repo = fakeRepo(); const A = createCalendarStore({ homeId: 'H', uid: 'u1', timezone: 'Africa/Cairo', repo }); A.subscribe(() => {}); await tick();
  const imp = await A.importRows(C.previewImport(csvOf(30)).rows, { audience: 'household', fileName: 'x.csv' }); await tick();
  let evChunks = 0; repo.failOn = (ops) => ops.some((o) => !o.name) && ++evChunks === 2;   // the 2nd chunk fails
  await assert.rejects(A.removeBatch(imp.batchId), (e) => e.detail === 'calendar.batch.partial' && e.removed === 20 && e.remaining === 10); await tick();
  assert.equal(repo.bdb.get(imp.batchId).status, 'removing');
  assert.equal(C.batchMembers(A.getSnapshot().all, imp.batchId).filter(C.isLive).length, 10);
  repo.failOn = null; repo.commits.length = 0;
  const res = await A.removeBatch(imp.batchId); await tick();
  assert.equal(res.removed, 10, 'retry touches only the 10 still live');
  assert.equal(repo.commits.filter((c) => c.startsWith('update:calendarImports')).length, 1, 'already "removing": only the final status write');
  assert.deepEqual([repo.bdb.get(imp.batchId).status, repo.bdb.get(imp.batchId).removedCount], ['removed', 30]);
  assert.equal(repo.db.size, 30, 'soft delete only'); A.dispose();
});

test('V621 re-import after removal: rows marked "removed earlier"; restored ONLY when chosen, into a NEW batch (no ghosts, not edited)', async () => {
  const repo = fakeRepo(); const A = createCalendarStore({ homeId: 'H', uid: 'u1', timezone: 'Africa/Cairo', repo }); A.subscribe(() => {}); await tick();
  const rows = C.previewImport(FIXTURE).rows;
  const first = await A.importRows(rows, { audience: 'household', fileName: 'g.csv' }); await tick();
  await A.removeBatch(first.batchId); await tick();
  const all = A.getSnapshot().all;
  const p = C.previewImport(FIXTURE, { existingIds: new Set(all.filter(C.isLive).map((e) => e.id)), removedIds: new Set(all.filter((e) => !C.isLive(e)).map((e) => e.id)) });
  assert.ok(p.rows.every((r) => r.removed && !r.duplicate));
  const skip = await A.importRows(p.rows, { audience: 'household', fileName: 'g.csv' });
  assert.deepEqual([skip.created, skip.restored, skip.skipped], [0, 0, 8], 'not restored without an explicit choice');
  const back = await A.importRows(p.rows.slice(0, 3), { audience: 'household', fileName: 'g.csv', restore: p.rows.slice(0, 3).map((r) => r.id) }); await tick();
  assert.deepEqual([back.restored, back.created], [3, 0]); assert.notEqual(back.batchId, first.batchId);
  for (const r of p.rows.slice(0, 3)) { const e = A.getSnapshot().all.find((x) => x.id === r.id); assert.ok(C.isLive(e) && e.importBatchId === back.batchId && !C.isEdited(e) && e.importRev === e.rev); }
  assert.equal(repo.bdb.get(back.batchId).createdCount, 3);
  assert.equal(C.batchMembers(A.getSnapshot().all, first.batchId).length, 5, 'old batch keeps only its still-removed rows');
  A.dispose();
});

test('V621 V6.2 imports without a batch: listed as ungrouped, never part of any removal plan (no guessing by title / date)', () => {
  const old = { id: 'csv_0123456789abcdef', title: 'Day Shift', source: 'csv', sourceKey: '0123456789abcdef', deletedAt: null, rev: 1, type: 'work', startDate: '2026-01-01', endDate: '2026-01-01' };
  const newer = { ...old, id: 'csv_fedcba9876543210', importBatchId: 'bt00001', importRev: 1 };
  const manual = { ...old, id: 'm1', source: 'manual', sourceKey: null };
  assert.deepEqual(C.ungroupedImports([old, newer, manual]).map((e) => e.id), ['csv_0123456789abcdef']);
  assert.deepEqual(C.removalPlan([old, newer, manual], 'bt00001').targets.map((e) => e.id), ['csv_fedcba9876543210']);
  assert.deepEqual(C.removalPlan([old, newer, manual], undefined).targets, [], 'an undefined id never matches ungrouped events');
});
