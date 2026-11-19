import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zakatLedger, snapshotForHawl, zakatReaders } from '../../src/modules/savings/zakat-ledger.js';
import { createSavingsStore } from '../../src/modules/savings/savings-store.js';
import { assess } from '../../src/modules/savings/zakat-engine.js';

const S = (id, end, est) => ({ id, kind: 'snapshot', hawlEnd: end, date: end, estimateMinor: est });
const P = (id, amt, snap) => ({ id, kind: 'payment', amountMinor: amt, snapshotId: snap, date: '2026-10-07' });

test('ledger: estimate, linked payments, outstanding and unlinked payments are kept separate', () => {
  const l = zakatLedger([S('a', '2025-10-01', 1000000), S('b', '2026-09-20', 1200000)], [P('p1', 400000, 'b'), P('p2', 300000, 'b'), P('p3', 1000000, 'a'), P('p4', 50000, null), P('p5', 7, 'ghost')]);
  assert.deepEqual(l.rows.map((r) => [r.snapshot.id, r.estimateMinor, r.paidMinor, r.outstandingMinor]), [['b', 1200000, 700000, 500000], ['a', 1000000, 1000000, 0]]);
  assert.deepEqual(l.unlinked.map((p) => p.id), ['p4', 'p5'], 'never guessed onto a Hawl');
  assert.deepEqual(l.totals, { estimateMinor: 2200000, paidLinkedMinor: 1700000, outstandingMinor: 500000, unlinkedMinor: 50007 });
});

test('ledger: overpayment is shown, outstanding never negative; malformed amounts ignored', () => {
  const l = zakatLedger([S('a', '2026-01-01', 1000)], [P('p', 1500, 'a'), { id: 'x', amountMinor: 'oops', snapshotId: 'a' }]);
  assert.deepEqual([l.rows[0].paidMinor, l.rows[0].outstandingMinor, l.rows[0].overpaidMinor], [1500, 0, 500]);
});

test('readers: owner always, child guardians always, explicit shares; ≤ 6', () => {
  assert.deepEqual(zakatReaders({ ownerUid: 'w' }), ['w'], 'private by default');
  assert.deepEqual(zakatReaders({ ownerUid: 'c', guardianUids: ['w', 'a'], sharedWith: ['x'] }), ['a', 'c', 'w', 'x']);
  assert.throws(() => zakatReaders({ ownerUid: 'o', sharedWith: ['1', '2', '3', '4', '5', '6'] }));
  assert.equal(snapshotForHawl([S('a', '2026-01-01', 1)], '2026-01-01').id, 'a');
});

function fakeRepo() {
  const data = new Map(); const ws = new Set(); const commits = []; let n = 0;
  const fire = () => { for (const w of ws) w(); };
  return { data, commits, now: () => 'NOW', newId: () => `id${++n}`,
    watch(home, name, kind, uid, onValue) {
      const w = () => onValue([...data.entries()].filter(([k]) => k.startsWith(`${home}/${name}/`)).map(([k, d]) => ({ id: k.split('/')[2], ...d }))
        .filter((d) => (name === 'priceQuotes' ? true : kind === 'household' ? (name === 'savingsAssets' ? d.visibility === 'household' : d.audience === 'household') : (d.readers || []).includes(uid))));
      ws.add(w); queueMicrotask(w); return () => ws.delete(w);
    },
    async commit(home, ops) { commits.push(ops.map((o) => `${o.mode}:${o.name}:${o.id}`)); for (const o of ops) { const k = `${home}/${o.name}/${o.id}`; data.set(k, o.mode === 'set' ? { ...o.data } : { ...data.get(k), ...o.data }); } fire(); } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const at = (d) => Date.parse(`${d}T10:00:00Z`);

async function wifeWithDueHawl() {
  const repo = fakeRepo();
  const s = createSavingsStore({ homeId: 'H', uid: 'wife', repo, homeCurrency: 'EGP', nowMs: () => at('2026-10-06') });
  s.ensure({ canViewHousehold: false }); s.subscribe(() => {}); await tick();
  repo.data.set('H/savingsAssets/c', { type: 'cash', scope: 'personal', ownerUid: 'wife', currency: 'EGP', active: true, zakatTreatment: 'included', visibility: 'private', readers: ['wife'], audience: 'restricted' });
  repo.data.set('H/savingsEvents/e', { assetId: 'c', type: 'opening', qty: 40000000, date: '2025-01-10', status: 'active', readers: ['wife'], audience: 'restricted' });
  repo.data.set('H/priceQuotes/q', { kind: 'metal', key: 'gold-21', priceMinor: 400000, currency: 'EGP', source: 'manual', observedAt: at('2025-01-01') });
  await repo.commit('H', []); await tick();
  return { repo, s };
}

test('payHawl: ONE batch = calculation (only if missing) + linked payment; second instalment reuses it', async () => {
  const { repo, s } = await wifeWithDueHawl();
  const a = s.zakatFor('wife', '2026-10-06');
  assert.equal(a.status, 'complete');
  const r1 = await s.payHawl('wife', a, { amount: '6000', date: '2026-10-07', readers: ['wife'] }); await tick();
  assert.deepEqual(repo.commits.at(-1).map((c) => c.split(':')[0] + ':' + c.split(':')[1]), ['set:zakatRecords', 'set:zakatRecords'], 'snapshot + payment together');
  assert.equal(repo.data.get(`H/zakatRecords/${r1.paymentId}`).snapshotId, r1.snapshotId);
  const r2 = await s.payHawl('wife', s.zakatFor('wife', '2026-10-06'), { amount: '4000', date: '2026-10-08', readers: ['wife'] }); await tick();
  assert.equal(r2.snapshotId, r1.snapshotId, 'same Hawl → same calculation');
  assert.equal(repo.commits.at(-1).length, 1, 'no second snapshot');
  const l = s.ledger('wife');
  assert.deepEqual([l.rows.length, l.rows[0].estimateMinor, l.rows[0].paidMinor, l.rows[0].outstandingMinor], [1, 1000000, 1000000, 0]);
  await assert.rejects(s.payHawl('wife', { due: null }, { amount: '1', date: '2026-10-07', readers: ['wife'] }), (e) => e.detail === 'savings.validation.noCompletedHawl');
});

test("setZakatSharing: re-labels readers on all of the owner's records, content untouched; revocable", async () => {
  const { repo, s } = await wifeWithDueHawl();
  await s.saveProfile('wife', {}, { readers: ['wife'] });
  await s.payHawl('wife', s.zakatFor('wife', '2026-10-06'), { amount: '100', date: '2026-10-07', readers: ['wife'] }); await tick();
  const before = [...repo.data.entries()].filter(([k]) => k.includes('zakatRecords')).map(([k, d]) => [k, { ...d, readers: undefined }]);
  assert.equal(await s.setZakatSharing('wife', ['husband', 'wife']), 3);
  await tick();
  assert.ok([...repo.data.entries()].filter(([k]) => k.includes('zakatRecords')).every(([, d]) => d.readers.join() === 'husband,wife'));
  assert.ok(repo.commits.at(-1).every((c) => c.startsWith('update:zakatRecords')));
  const after = [...repo.data.entries()].filter(([k]) => k.includes('zakatRecords')).map(([k, d]) => [k, { ...d, readers: undefined }]);
  assert.deepEqual(after, before, 'only readers changed');
  assert.equal(await s.setZakatSharing('wife', ['wife']), 3, 'revoked');
  assert.equal(s.zakatReadersOf('wife').join(), 'wife');
  await assert.rejects(s.setZakatSharing('wife', ['husband']), 'owner must remain');
});
