// V6.5 Phase 01 — Pantry catalog: integer units, product model (EN / AR names, Arabic normalisation, aliases,
// quantity vs presence, thresholds, archive), the scope store (bounded listener, update masks, stale edits,
// capacity / truncation, disposal) and the static guards for V6.5 files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { UNITS, BASE_UNIT, MAX_BASE_MILLI, parseQuantity, formatQuantity, convertible, assertConvertible, unitsFor, dimensionOf, isBaseMilli, unitFits } from '../../src/modules/inventory/units.js';
import { validateProduct, assertValid, createDoc, editPatch, archivePatch, restorePatch, normalizeText, matches, displayName, otherName, sortProducts, similarProducts,
  parseAliases, minText, DOC_KEYS, EDITABLE, CATEGORIES, LOCATIONS, LIMITS } from '../../src/modules/inventory/product-model.js';
import { createInventoryStore } from '../../src/modules/inventory/inventory-store.js';
import { ROLE_TEMPLATE_VERSION, TEMPLATE_CHANGES, upgradeRolePermissions } from '../../src/core/permissions/roles.js';
import { defaultRoles } from '../../src/modules/index.js';
import en from '../../src/core/i18n/locales/en.js';
import ar from '../../src/core/i18n/locales/ar.js';

const err = (fn) => { try { fn(); } catch (e) { return e.detail; } return null; };

// ------------------------------------------------------------------------------------------------ units
test('P01 units: base milli-units, exact decimal parsing (no floating point), same-dimension only', () => {
  assert.deepEqual(BASE_UNIT, { count: 'piece', mass: 'g', volume: 'ml' });
  assert.equal(parseQuantity('2', 'piece'), 2000, '2 pieces = 2,000 milli-pieces');
  assert.equal(parseQuantity('1', 'kg'), 1000000, '1 kg = 1,000,000 milli-grams');
  assert.equal(parseQuantity('1.5', 'kg'), 1500000);
  assert.equal(parseQuantity('0.001', 'kg'), 1000, '1 g');
  assert.equal(parseQuantity('0.000001', 'kg'), 1, '1 milli-gram is the resolution');
  assert.equal(parseQuantity('250', 'g'), 250000); assert.equal(parseQuantity('0.5', 'g'), 500); assert.equal(parseQuantity('0.25', 'l'), 250000);
  assert.equal(parseQuantity('١٫٥', 'kg'), 1500000, 'Arabic-Indic digits + Arabic decimal mark');
  assert.equal(parseQuantity('2,5', 'l'), 2500000, 'comma decimal');
  assert.equal(parseQuantity('0.1', 'l') + parseQuantity('0.2', 'l'), parseQuantity('0.3', 'l'), 'no 0.1 + 0.2 drift');
  assert.equal(parseQuantity('3.000', 'piece'), 3000, 'trailing zero decimals are whole');
  assert.equal(err(() => parseQuantity('2.5', 'piece')), 'pantry.err.wholePieces', 'pieces are whole');
  assert.equal(err(() => parseQuantity('0.0001', 'g')), 'pantry.err.precision');
  assert.equal(err(() => parseQuantity('0', 'kg')), 'pantry.err.positive'); assert.equal(parseQuantity('0', 'kg', { allowZero: true }), 0);
  for (const bad of ['-1', '1e3', 'abc', '', ' ', '1.2.3', '١,٢,٣', 'NaN', 'Infinity']) assert.equal(err(() => parseQuantity(bad, 'g')), 'pantry.err.amount', bad);
  assert.equal(err(() => parseQuantity('1000001', 'kg')), 'pantry.err.tooLarge', '> 10^12 milli-g');
  assert.equal(parseQuantity('1000000', 'kg'), MAX_BASE_MILLI, 'exactly the bound');
  assert.equal(err(() => parseQuantity('9999999999999', 'kg')), 'pantry.err.tooLarge', 'no unsafe integers');
  assert.equal(err(() => parseQuantity('1', 'cup')), 'pantry.err.unit');
  assert.equal(formatQuantity(1500000, 'kg'), '1.5'); assert.equal(formatQuantity(1500000, 'g'), '1500'); assert.equal(formatQuantity(1, 'kg'), '0.000001');
  assert.equal(formatQuantity(20000, 'piece'), '20'); assert.equal(formatQuantity(0, 'l'), '0'); assert.equal(formatQuantity(250000, 'l'), '0.25');
  assert.equal(err(() => formatQuantity(-1, 'g')), 'pantry.err.amount'); assert.equal(err(() => formatQuantity(1.5, 'g')), 'pantry.err.amount');
  assert.ok(convertible('g', 'kg') && convertible('l', 'ml') && !convertible('piece', 'g') && !convertible('g', 'ml'));
  assert.equal(err(() => assertConvertible('kg', 'l')), 'pantry.err.dimension');
  assert.deepEqual([unitsFor('mass'), unitsFor('volume'), unitsFor('count'), dimensionOf('l'), dimensionOf('cup')], [['g', 'kg'], ['ml', 'l'], ['piece'], 'volume', null]);
  assert.ok(isBaseMilli(3000, 'count') && !isBaseMilli(3500, 'count') && isBaseMilli(3500, 'mass') && !isBaseMilli(-1, 'mass') && !isBaseMilli(MAX_BASE_MILLI + 1, 'mass'));
  assert.ok(unitFits('mass', 'kg') && !unitFits('mass', 'ml') && !unitFits(null, 'g'));
  assert.ok(Object.values(UNITS).every((u) => Number.isSafeInteger(u.perUnit)));
});

// ------------------------------------------------------------------------------------------------ model
const base = { nameEn: 'Eggs', nameAr: 'بيض', category: 'dairy', location: 'fridge', trackMode: 'quantity', dimension: 'count', displayUnit: 'piece', minQty: '6', aliases: 'egg, بيضة' };

test('P01 model: names (≥ 1, never invented), enums, quantity vs presence, thresholds, aliases', () => {
  const ok = validateProduct(base);
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value, { nameEn: 'Eggs', nameAr: 'بيض', category: 'dairy', location: 'fridge', trackMode: 'quantity', dimension: 'count', displayUnit: 'piece', minMilli: 6000, aliases: ['egg', 'بيضة'], note: null });
  assert.equal(validateProduct({ ...base, nameAr: '' }).value.nameAr, null, 'missing Arabic is null, not a translation');
  assert.equal(validateProduct({ ...base, nameEn: '  ', nameAr: '' }).errors.name, 'pantry.err.name');
  assert.equal(validateProduct({ ...base, nameEn: 'x'.repeat(81) }).errors.nameEn, 'pantry.err.tooLong');
  assert.equal(validateProduct({ ...base, nameEn: '  Fresh \n  eggs\u0007 ' }).value.nameEn, 'Fresh eggs', 'whitespace / control characters cleaned');
  assert.equal(validateProduct({ ...base, category: 'x' }).errors.category, 'pantry.err.category');
  assert.equal(validateProduct({ ...base, location: 'x' }).errors.location, 'pantry.err.location');
  assert.equal(validateProduct({ ...base, trackMode: 'x' }).errors.trackMode, 'pantry.err.mode');
  assert.equal(validateProduct({ ...base, dimension: 'mass' }).errors.displayUnit, 'pantry.err.unit', 'piece is not a mass unit');
  assert.equal(validateProduct({ ...base, minQty: '2.5' }).errors.minQty, 'pantry.err.wholePieces');
  assert.equal(validateProduct({ ...base, minQty: '0' }).errors.minQty, 'pantry.err.positive');
  assert.equal(validateProduct({ ...base, minQty: '' }).value.minMilli, null, 'threshold optional');
  assert.equal(validateProduct({ ...base, dimension: 'mass', displayUnit: 'kg', minQty: '0.75' }).value.minMilli, 750000);
  const pres = validateProduct({ ...base, trackMode: 'presence', minQty: '6' });
  assert.deepEqual(pres.errors, {}); assert.deepEqual([pres.value.dimension, pres.value.displayUnit, pres.value.minMilli], [null, null, null], 'presence mode has no unit / threshold');
  assert.deepEqual(parseAliases('rice, أرز ,، Rice,  ,a|b'), ['rice', 'أرز', 'ab'], 'trimmed, de-duplicated by search key, separator stripped');
  assert.equal(validateProduct({ ...base, aliases: Array.from({ length: LIMITS.aliases + 1 }, (_, i) => `a${i}`) }).errors.aliases, 'pantry.err.tooManyAliases');
  assert.equal(validateProduct({ ...base, note: 'x'.repeat(201) }).errors.note, 'pantry.err.tooLong');
  assert.equal(err(() => assertValid({ ...base, nameEn: '', nameAr: '' })), 'pantry.err.name');
  assert.equal(CATEGORIES.length, 15); assert.equal(LOCATIONS.length, 7);
});

test('P01 model: Arabic / English normalisation and bilingual search', () => {
  assert.equal(normalizeText('  ÉGGS  Large '), 'eggs large');
  assert.equal(normalizeText('أَرُزّ'), 'ارز', 'diacritics + alef hamza');
  assert.equal(normalizeText('إسـكـنـدرانـي'), 'اسكندراني', 'tatweel + alef below');
  assert.equal(normalizeText('آلة'), 'اله', 'alef madda, ta marbuta');
  assert.equal(normalizeText('مستشفى'), 'مستشفي', 'alef maqsura');
  assert.equal(normalizeText('لبن ٣٪'), 'لبن 3٪', 'Arabic-Indic digits');
  const p = { id: 'a', nameEn: 'Basmati rice', nameAr: 'أرز بسمتي', aliases: ['ruz'], note: 'big bag' };
  for (const q of ['rice', 'RICE', 'ارز', 'أرز', 'أَرز', 'بسمتي ارز', 'ruz', 'bag', '']) assert.ok(matches(p, q), q);
  for (const q of ['milk', 'حليب', 'rice milk']) assert.ok(!matches(p, q), q);
  assert.equal(displayName(p, 'ar'), 'أرز بسمتي'); assert.equal(displayName({ nameEn: 'Salt', nameAr: null }, 'ar'), 'Salt', 'falls back, never empty');
  assert.equal(otherName(p, 'ar'), 'Basmati rice'); assert.equal(otherName({ nameEn: 'Salt', nameAr: null }, 'en'), null);
  assert.deepEqual(sortProducts([{ id: 'b', nameEn: 'b10' }, { id: 'a', nameEn: 'B2' }, { id: 'c', nameEn: 'a' }], 'en').map((x) => x.id), ['c', 'a', 'b'], 'locale + numeric collation');
  assert.deepEqual(similarProducts({ nameEn: 'EGGS', nameAr: null }, [{ id: 'x', nameEn: 'eggs' }, { id: 'y', nameAr: 'بيض' }], null).map((x) => x.id), ['x']);
  assert.deepEqual(similarProducts({ nameEn: null, nameAr: 'بَيض' }, [{ id: 'y', nameAr: 'بيض' }], 'y'), [], 'the product itself is not "similar"');
});

test('P01 documents: create = zero stock / stockRev 0 / rev 1; edit = metadata mask only; trackMode fixed; dimension locked after stock; archive / restore', () => {
  const now = 'NOW'; const v = assertValid(base);
  const d = createDoc(v, { uid: 'u1', now });
  assert.deepEqual(Object.keys(d), DOC_KEYS, 'exact schema, in order');
  assert.deepEqual([d.stockMilli, d.presence, d.stockRev, d.rev, d.archived, d.schemaVersion, d.createdBy, d.updatedAt], [0, null, 0, 1, false, 1, 'u1', now]);
  const pd = createDoc(assertValid({ ...base, trackMode: 'presence' }), { uid: 'u1', now });
  assert.deepEqual([pd.stockMilli, pd.presence, pd.dimension, pd.displayUnit, pd.minMilli], [null, null, null, null, null], 'presence: no numeric stock');
  const cur = { id: 'p1', ...d };
  assert.equal(editPatch(cur, assertValid(base, { current: cur }), { uid: 'u2', now }), null, 'no change → no write');
  const patch = editPatch(cur, assertValid({ ...base, nameEn: 'Brown eggs', minQty: '12' }, { current: cur }), { uid: 'u2', now });
  assert.deepEqual(patch, { nameEn: 'Brown eggs', minMilli: 12000, rev: 2, updatedBy: 'u2', updatedAt: now });
  assert.ok(Object.keys(patch).every((k) => [...EDITABLE, 'rev', 'updatedBy', 'updatedAt'].includes(k)), 'never a stock field');
  assert.equal(validateProduct({ ...base, trackMode: 'presence' }, { current: cur }).errors.trackMode, 'pantry.err.modeLocked');
  assert.equal(validateProduct({ ...base, trackMode: undefined, dimension: 'mass', displayUnit: 'g' }, { current: cur }).value.trackMode, 'quantity', 'mode taken from the stored product');
  assert.deepEqual(validateProduct({ ...base, dimension: 'mass', displayUnit: 'g', minQty: '' }, { current: cur }).errors, {}, 'dimension editable while stockRev == 0');
  assert.equal(validateProduct({ ...base, dimension: 'mass', displayUnit: 'g' }, { current: { ...cur, stockRev: 3 } }).errors.dimension, 'pantry.err.dimensionLocked');
  assert.deepEqual(archivePatch(cur, { uid: 'u3', now }), { archived: true, archivedAt: now, archivedBy: 'u3', rev: 2, updatedBy: 'u3', updatedAt: now });
  assert.deepEqual(restorePatch({ ...cur, rev: 2, archived: true }, { uid: 'u3', now }), { archived: false, archivedAt: null, archivedBy: null, rev: 3, updatedBy: 'u3', updatedAt: now });
  assert.equal(minText({ ...cur, minMilli: 1500000, dimension: 'mass', displayUnit: 'kg' }), '1.5'); assert.equal(minText(pd), '');
});

// ------------------------------------------------------------------------------------------------ store
function fakeRepo() {
  const ops = []; let on = null; let er = null; let stopped = 0; const archived = [];
  return { ops, archived, push: (docs) => on(docs), fail: (e) => er(e), stopped: () => stopped,
    now: () => 'NOW', newId: () => 'newProd01', read: async (h, id) => archived.find((x) => x.id === id) || null,
    readArchived: async () => archived, watchProducts: (h, o, e) => { on = o; er = e; return () => { stopped++; }; },
    commit: async (h, o) => { ops.push(...o); } };
}
test('P01 store: one bounded listener, confirmed writes, update masks (never set on edit), stale editor refused, capacity / truncation, disposal', async () => {
  const repo = fakeRepo(); const s = createInventoryStore({ homeId: 'H', uid: 'u1', repo, canView: true });
  assert.equal(s.getSnapshot().status, 'loading'); assert.equal(s.listenerCount(), 1);
  repo.push([{ id: 'p1', ...createDoc(assertValid(base), { uid: 'u1', now: 'T' }) }]);
  assert.equal(s.getSnapshot().status, 'ready'); assert.equal(s.getSnapshot().products.length, 1);
  assert.equal(await s.createProduct({ ...base, nameEn: 'Milk', nameAr: 'حليب', dimension: 'volume', displayUnit: 'l', minQty: '1' }), 'newProd01');
  assert.equal(repo.ops[0].mode, 'set'); assert.equal(repo.ops[0].data.stockMilli, 0);
  assert.equal(await s.updateProduct('p1', { ...base, nameEn: 'Eggs XL' }, { baseRev: 1 }), true);
  assert.equal(repo.ops[1].mode, 'update', 'edits are field masks'); assert.ok(!('stockMilli' in repo.ops[1].data) && !('stockRev' in repo.ops[1].data));
  await assert.rejects(s.updateProduct('p1', base, { baseRev: 0 }), (e) => e.detail === 'pantry.err.stale');
  assert.equal(await s.updateProduct('p1', base, { baseRev: 1 }), false, 'unchanged → no write');
  await s.archiveProduct('p1'); assert.equal(repo.ops.at(-1).data.archived, true);
  await assert.rejects(s.updateProduct('nope', base), (e) => e.detail === 'pantry.err.notFound');
  await assert.rejects(s.createProduct({ ...base, nameEn: '', nameAr: '' }), (e) => e.detail === 'pantry.err.name');
  repo.archived.push({ id: 'old1', archived: true, rev: 4 });
  assert.deepEqual((await s.listArchived()).items.map((x) => x.id), ['old1']);
  await s.restoreProduct('old1'); assert.deepEqual(repo.ops.at(-1).data, { archived: false, archivedAt: null, archivedBy: null, rev: 5, updatedBy: 'u1', updatedAt: 'NOW' });
  // capacity: listener reads limit + 1 → truncated flag; creation refused at the limit
  repo.push(Array.from({ length: LIMITS.maxProducts + 1 }, (_, i) => ({ id: `p${i}`, archived: false, nameEn: `P${i}` })));
  assert.deepEqual([s.getSnapshot().truncated, s.getSnapshot().products.length, s.getSnapshot().atLimit], [true, LIMITS.maxProducts, true]);
  await assert.rejects(s.createProduct(base), (e) => e.detail === 'pantry.err.atLimit');
  repo.fail({ code: 'PERMISSION_DENIED' }); assert.equal(s.getSnapshot().status, 'error');
  s.dispose(); assert.equal(repo.stopped(), 1, 'listener released on Home switch / sign-out');
  await assert.rejects(s.createProduct(base), (e) => e.detail === 'disposed');
  const none = createInventoryStore({ homeId: 'H', uid: 'u1', repo: fakeRepo(), canView: false });
  assert.deepEqual([none.getSnapshot().status, none.listenerCount()], ['denied', 0], 'no inventory.view → no listener at all');
});

// ------------------------------------------------------------------------------------------------ permissions / static guards
// P02 update (explained in V65-P02-REPORT §Tests): Phase 01 pinned "no template change"; Phase 02 adds exactly ONE grant,
// inventory.adjust, via additive template v10. The stronger assertion: v10 is the ONLY template version touching inventory,
// it adds only inventory.adjust (exact grant), Shopping still has none, and every Phase 01 default is unchanged.
test('P01 permissions (updated for P02): only template v10 touches inventory, adding just inventory.adjust; Phase 01 defaults unchanged; no child access, delete (archive) admin only', () => {
  assert.equal(ROLE_TEMPLATE_VERSION, 10, 'P02: v10 adds inventory.adjust');
  assert.deepEqual(Object.entries(TEMPLATE_CHANGES).filter(([, ns]) => ns.includes('inventory')).map(([v]) => Number(v)), [10]);
  assert.ok(!Object.values(TEMPLATE_CHANGES).some((ns) => ns.includes('shopping')));
  const roles = Object.fromEntries(defaultRoles().map((r) => [r.id, r.permissions]));
  assert.deepEqual(['admin', 'member', 'viewer', 'child'].map((r) => roles[r].filter((p) => p.startsWith('inventory.') && p !== 'inventory.adjust')),
    [['inventory.create', 'inventory.delete', 'inventory.edit', 'inventory.view'], ['inventory.create', 'inventory.edit', 'inventory.view'], ['inventory.view'], []]);
  assert.deepEqual(['admin', 'member', 'viewer', 'child'].map((r) => roles[r].includes('inventory.adjust')), [true, true, false, false]);
  // a role at the current version keeps its customisation verbatim
  const custom = ['chef.view', 'inventory.view', 'shopping.view'];
  assert.deepEqual(upgradeRolePermissions({ current: custom, template: roles.child, from: ROLE_TEMPLATE_VERSION }), custom.sort());
});

const read = (p) => readFileSync(p, 'utf8');
const filesIn = (dir) => readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).map((f) => join(dir, f));
// P02 update: "stock is written only at creation" became "stock fields are built ONLY by product-model (creation) and stock-model
// (the stock mask)"; the rules check now targets the CATALOG branch of the update statement, which must still exclude stock fields.
test('P01 static (updated for P02): V6.5 files never touch Finance or money; Shopping still not started; stock fields only in product-model / stock-model; catalog masks exclude stock; rules within budget', () => {
  const v65 = [...filesIn('src/modules/inventory'), ...filesIn('src/modules/shopping'), 'assets/css/modules/inventory.css'];
  for (const f of v65) {
    const c = read(f);
    assert.ok(!/modules\/expenses|\.\.\/expenses\/|finance-|ledger\.js|recurrence\.js/.test(c), `${f} imports Finance`);
    assert.ok(!/\b(price|prices|amountMinor|currency|expenseId|expenses|walletId|wallet|totalMinor|estimatedPrice)\b/i.test(c), `${f} has money / expense fields`);
  }
  assert.deepEqual(readdirSync('src/modules/shopping'), ['module.js'], 'Shopping is not implemented in Phase 01');
  for (const f of filesIn('src/modules/inventory').filter((x) => !x.endsWith('product-model.js') && !x.endsWith('stock-model.js'))) {
    assert.ok(!/stockMilli\s*:|stockRev\s*:|presence\s*:/.test(read(f)), `${f} writes a stock field`);
  }
  assert.ok(!/mode:\s*'delete'|\.delete\(/.test(read('src/modules/inventory/inventory-repository.js')), 'no delete');
  const rules = read('firestore.rules');
  assert.ok(Buffer.byteLength(rules, 'utf8') <= 245000, `rules source ${Buffer.byteLength(rules, 'utf8')} bytes > 245,000 budget (hard limit 256 KB)`);
  const blk = rules.slice(rules.indexOf('match /pantryProducts/{productId}'), rules.indexOf('match /pantryProducts/{productId}') + 4000);
  assert.ok(/allow delete: if false;/.test(blk) && /incoming\(\)\.stockRev == 0/.test(blk), 'create pins zero / unrecorded stock; no delete');
  const upd = blk.slice(blk.indexOf('allow update'), blk.indexOf('allow delete'));
  const catalog = upd.slice(upd.indexOf('?'), upd.lastIndexOf(': pnStockWriteOk'));
  assert.ok(/^allow update: if incoming\(\)\.stockRev == resource\.data\.stockRev\s*\?/.test(upd), 'branch selected by stockRev');
  for (const m of catalog.matchAll(/hasOnly\(\[([^\]]*)\]\)/g)) assert.ok(!/stockMilli|presence|stockRev/.test(m[1]), `catalog mask has a stock field: ${m[1]}`);
});

test('P01 i18n: every Pantry key (incl. dynamic) exists in English and Arabic', () => {
  const keys = Object.keys(en).filter((k) => k.startsWith('pantry.'));
  assert.ok(keys.length > 100);
  for (const k of keys) { assert.ok(ar[k], `ar ${k}`); }
  for (const c of CATEGORIES) assert.ok(en[`pantry.cat.${c}`] && ar[`pantry.cat.${c}`], c);
  for (const l of LOCATIONS) assert.ok(en[`pantry.loc.${l}`] && ar[`pantry.loc.${l}`], l);
  for (const u of Object.keys(UNITS)) assert.ok(en[`pantry.unit.${u}`] && ar[`pantry.unit.${u}`], u);
  for (const d of ['count', 'mass', 'volume']) assert.ok(en[`pantry.dim.${d}`] && ar[`pantry.dim.${d}`], d);
  const src = filesIn('src/modules/inventory').map(read).join('\n');
  for (const m of src.matchAll(/'(pantry\.err\.[A-Za-z]+)'/g)) assert.ok(en[m[1]] && ar[m[1]], m[1]);
});
