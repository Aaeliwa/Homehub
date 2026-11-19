import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrams, mgToPlain, mulDiv, metalValue, fxValue, applyBps } from '../../src/modules/savings/quantity.js';
import { validateAssetInput, buildAssetCreate, buildEvent, balanceOf, accessOf, assetReaders, validateAllocations, percentToBps, sortActivity } from '../../src/modules/savings/savings-model.js';
import { latestQuote, metalPrice, freshness, isLive, valueOf, portfolio, FRESH_MS } from '../../src/modules/savings/valuation.js';
import { createHttpProvider, validateQuotePayload, PRICE_ENDPOINT } from '../../src/modules/savings/providers.js';
import { toHijri, addHijriYear, hawlEnd, hasHijri } from '../../src/modules/savings/hijri.js';

const DAY = 86400000;
const q = (key, price, at, extra = {}) => ({ id: `${key}@${at}`, kind: key.includes('-') ? 'metal' : 'fx', key, priceMinor: price, currency: 'EGP', source: 'manual', observedAt: at, ...extra });

test('precision: grams→mg, exact products, half-up rounding, basis points', () => {
  assert.deepEqual(parseGrams('50'), { value: 50000 });
  assert.deepEqual(parseGrams('12.345'), { value: 12345 });
  assert.deepEqual(parseGrams('٥٠٫٥'), { value: 50500 }, 'Arabic digits and decimal sign');
  assert.ok(parseGrams('1.2345').error && parseGrams('-1').error && parseGrams('abc').error);
  assert.equal(mgToPlain(12345), '12.345'); assert.equal(mgToPlain(50000), '50');
  assert.equal(metalValue(50000, 400000), 20000000, '50 g × 4,000 EGP = 200,000 EGP');
  assert.equal(metalValue(50000, 410000), 20500000, 'price change: quantity unchanged, value 205,000');
  assert.equal(fxValue(250000, 4850), 12125000, '2,500 USD × 48.50 = 121,250 EGP');
  assert.equal(applyBps(28500000, 250), 712500, '285,000 × 2.5% = 7,125');
  assert.equal(mulDiv(1, 1, 2), 1, 'half rounds up'); assert.equal(mulDiv(-1, 1, 2), -1);
  assert.equal(mulDiv(999999999999, 999999, 1000), 999998999999000, 'BigInt product (~1e18) exact, no float overflow');
  assert.equal(mulDiv(9007199254740, 1000000, 1000000), 9007199254740, 'large exact');
});

test('assets: types, units, ownership, privacy labels, metadata vs quantity', () => {
  const base = { uid: 'ahmed', memberUids: ['ahmed', 'sara', 'omar'], homeCurrency: 'EGP' };
  const gold = validateAssetInput({ name: 'Gold', type: 'gold', purity: '21', opening: '50' }, base);
  assert.deepEqual(gold.errors, {}); assert.equal(gold.value.openingQty, 50000); assert.equal(gold.value.currency, null);
  assert.ok(validateAssetInput({ name: 'G', type: 'gold', purity: '20' }, base).errors.purity, 'unsupported karat');
  assert.equal(validateAssetInput({ name: 'S', type: 'silver', purity: '925' }, base).value.purity, '925');
  assert.ok(validateAssetInput({ name: 'U', type: 'fx', currency: 'EGP' }, base).errors.currency, 'fx must be foreign');
  assert.equal(validateAssetInput({ name: 'USD', type: 'fx', currency: 'USD', opening: '2500' }, base).value.openingQty, 250000);
  assert.ok(validateAssetInput({ name: 'X', type: 'gold', purity: '21', opening: '1.2345' }, base).errors.opening);
  assert.ok(validateAssetInput({ name: '', type: 'cash' }, base).errors.name);
  const p = validateAssetInput({ name: 'Mine', type: 'cash', scope: 'personal', visibility: 'shared', sharedWith: ['sara', 'ahmed'] }, base).value;
  assert.deepEqual([p.ownerUid, p.sharedWith, p.visibility], ['ahmed', ['sara'], 'shared'], 'owner removed from share list');
  assert.equal(validateAssetInput({ name: 'X', type: 'cash', scope: 'personal', visibility: 'shared', sharedWith: [] }, base).value.visibility, 'private');
  assert.ok(validateAssetInput({ name: 'X', type: 'cash', scope: 'personal', ownerUid: 'stranger' }, base).errors.ownerUid);
  const { data } = buildAssetCreate({ input: { name: 'Fund', type: 'cash', scope: 'home', allocations: [{ uid: 'ahmed', bps: 6000 }, { uid: 'sara', bps: 4000 }] }, uid: 'ahmed', memberUids: base.memberUids, homeCurrency: 'EGP', now: 'N' });
  assert.deepEqual([data.visibility, data.ownerUid, data.audience, data.readers, data.createdBy], ['household', null, 'household', [], 'ahmed']);
  assert.ok(!('balance' in data) && !('valueMinor' in data), 'no stored balance or value');
  const child = buildAssetCreate({ input: { name: 'Omar savings', type: 'cash', scope: 'personal', ownerUid: 'omar', visibility: 'shared', sharedWith: ['ahmed', 'sara'] }, uid: 'ahmed', memberUids: base.memberUids, homeCurrency: 'EGP', now: 'N' }).data;
  assert.deepEqual(child.readers, ['ahmed', 'omar', 'sara'], 'child + guardians');
});

test('allocations: explicit, total exactly 100%, never guessed', () => {
  assert.equal(validateAllocations([{ uid: 'a', bps: 6000 }, { uid: 'b', bps: 4000 }]), null);
  assert.equal(validateAllocations([{ uid: 'a', bps: 5000 }]), 'savings.validation.allocationSum');
  assert.equal(validateAllocations([{ uid: 'a', bps: 6000 }, { uid: 'a', bps: 4000 }]), 'savings.validation.allocationInvalid');
  assert.equal(validateAllocations([]), 'savings.validation.allocationRequired');
  assert.equal(percentToBps('60'), 6000); assert.equal(percentToBps('33.33'), 3333); assert.equal(percentToBps('0'), null); assert.equal(percentToBps('101'), null);
});

test('events: signed quantities, deterministic balances, newest-first activity', () => {
  const a = { id: 'g', type: 'gold', purity: '21', currency: null, active: true, visibility: 'private', ownerUid: 'ahmed', readers: ['ahmed'] };
  const e1 = { id: '1', ...buildEvent({ asset: a, type: 'opening', qty: 50000, date: '2026-01-01', uid: 'ahmed', now: 'N' }) };
  assert.equal(e1.unit, 'mg'); assert.equal(e1.createdBy, 'ahmed'); assert.deepEqual(e1.readers, ['ahmed']);
  assert.throws(() => buildEvent({ asset: a, type: 'withdrawal', qty: 5, date: '2026-01-01', uid: 'u', now: 'N' }), 'withdrawal must be negative');
  assert.throws(() => buildEvent({ asset: a, type: 'contribution', qty: 0, date: '2026-01-01', uid: 'u', now: 'N' }));
  assert.throws(() => buildEvent({ asset: { ...a, active: false }, type: 'contribution', qty: 1, date: '2026-01-01', uid: 'u', now: 'N' }), 'archived');
  const evs = [e1, { id: '2', assetId: 'g', qty: -10000, date: '2026-03-01' }, { id: '3', assetId: 'g', qty: 5000, date: '2026-02-01' }, { id: '4', assetId: 'g', qty: 999, date: '2026-04-01', status: 'void' }];
  assert.equal(balanceOf('g', evs), 45000);
  assert.equal(balanceOf('g', evs, '2026-02-15'), 55000, 'history matters');
  assert.deepEqual(sortActivity(evs).map((e) => e.id), ['4', '2', '3', '1']);
});

test('privacy labels: owner-only, shared, household', () => {
  assert.deepEqual(accessOf({ visibility: 'private', ownerUid: 'sara' }), { audience: 'restricted', readers: ['sara'] });
  assert.deepEqual(assetReaders({ visibility: 'shared', ownerUid: 'sara', sharedWith: ['ahmed'] }), ['ahmed', 'sara']);
  assert.deepEqual(accessOf({ visibility: 'household' }), { audience: 'household', readers: [] });
});

test('valuation: latest quote, derived purity, freshness, never "live" from manual', () => {
  const now = 100 * DAY;
  const qs = [q('gold-21', 400000, now - 2 * DAY), q('gold-21', 410000, now - 1000), q('gold-24', 460000, now - 3 * DAY)];
  assert.equal(latestQuote(qs, 'gold-21').priceMinor, 410000);
  assert.equal(latestQuote(qs, 'gold-21', now - DAY).priceMinor, 400000, 'historical price at a date');
  const d18 = metalPrice(qs, 'gold', '18');
  assert.equal(d18.derived, true); assert.equal(d18.priceMinor, 345000, '24K × 18/24');
  assert.equal(metalPrice(qs, 'silver', '999'), null, 'never invented');
  assert.equal(freshness(qs[1], now), 'current'); assert.equal(freshness(qs[0], now), 'stale');
  assert.equal(freshness(null, now), 'unavailable');
  assert.equal(isLive(qs[1], now), false, 'manual is never live');
  assert.equal(isLive({ ...qs[1], source: 'http' }, now), true);
  assert.equal(isLive({ ...qs[1], source: 'http', observedAt: now - FRESH_MS - 1 }, now), false);
  const gold = { type: 'gold', purity: '21' };
  assert.equal(valueOf(gold, 50000, qs, { homeCurrency: 'EGP', nowMs: now }).valueMinor, 20500000);
  assert.equal(valueOf({ type: 'fx', currency: 'USD' }, 250000, qs, { homeCurrency: 'EGP', nowMs: now }).status, 'unavailable');
  assert.equal(valueOf({ type: 'cash', currency: 'EGP' }, 2500000, [], { homeCurrency: 'EGP' }).status, 'native');
});

test('visible-wealth total counts only passed (readable) assets; unvalued never counted as zero', () => {
  const now = 10 * DAY;
  const assets = [{ id: 'c', type: 'cash', currency: 'EGP', active: true }, { id: 'g', type: 'gold', purity: '21', active: true }, { id: 'u', type: 'fx', currency: 'USD', active: true }, { id: 'x', type: 'cash', currency: 'EGP', active: false }];
  const p = portfolio(assets, { c: 2500000, g: 50000, u: 250000, x: 999 }, [q('gold-21', 400000, now)], { homeCurrency: 'EGP', nowMs: now });
  assert.equal(p.totalMinor, 22500000);
  assert.deepEqual(p.unvalued.map((a) => a.id), ['u']);
  assert.deepEqual(p.byType, { cash: 2500000, gold: 20000000 });
});

test('providers: unconfigured by default; failures degrade safely; no keys', async () => {
  assert.equal(PRICE_ENDPOINT, null);
  assert.deepEqual(await createHttpProvider().fetchQuotes(['gold-21']), { status: 'unconfigured', quotes: [] });
  const ok = createHttpProvider({ endpoint: 'https://p', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ quotes: [{ kind: 'metal', key: 'gold-21', priceMinor: 400000, currency: 'EGP', observedAt: 1 }] }) }) });
  assert.equal((await ok.fetchQuotes(['gold-21'])).quotes[0].source, 'http');
  for (const [impl, err] of [[async () => ({ ok: false, status: 429 }), 'rateLimited'], [async () => ({ ok: false, status: 500 }), 'http500'],
    [async () => { throw new TypeError('x'); }, 'network'], [async () => ({ ok: true, status: 200, json: async () => ({ quotes: [{ key: 'gold-21' }] }) }), 'invalidResponse']]) {
    assert.equal((await createHttpProvider({ endpoint: 'https://p', fetchImpl: impl }).fetchQuotes(['k'])).error, err);
  }
  const slow = createHttpProvider({ endpoint: 'https://p', timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) });
  assert.equal((await slow.fetchQuotes(['k'])).error, 'timeout');
  assert.equal(validateQuotePayload({ kind: 'metal', key: 'gold-21', priceMinor: 1.5, currency: 'EGP', observedAt: 1 }), false, 'non-integer price rejected');
});

test('Hijri: Umm al-Qura conversion and one lunar year (~354–355 days, not 365)', () => {
  assert.ok(hasHijri());
  assert.deepEqual(toHijri('2026-10-06'), { year: 1448, month: 4, day: 25 });
  const end = addHijriYear('2026-10-06');
  assert.equal(end.method, 'umalqura');
  assert.deepEqual(toHijri(end.date), { year: 1449, month: 4, day: 25 });
  const days = (Date.parse(end.date) - Date.parse('2026-10-06')) / DAY;
  assert.ok(days >= 354 && days <= 355, `${days}`);
  assert.equal(hawlEnd('2024-02-29', 'gregorian').date, '2025-02-28');
  assert.equal(hawlEnd('2026-03-10', 'gregorian').date, '2027-03-10');
});
