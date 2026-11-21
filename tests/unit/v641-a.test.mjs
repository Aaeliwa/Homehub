// V6.4.1 Stage A — portable contacts JSON (parse limits / schema / unsafe structure / per-item validation /
// Unicode + RTL / export ↔ import round trip / stable category identity EN ↔ AR / media validation / merge
// decisions that never overwrite media silently) and the Contacts in-page history helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseContactsJson, exportContactsJson, nestingDepth, JSON_LIMITS, JSON_SCHEMA, JSON_VERSION, ITEM_KEYS, mergeJson, conflictPairs,
  EXAMPLE, exampleText, aiPrompt, schemaText, jsonFileName } from '../../src/modules/contacts/contacts-json.js';
import { buildPreview, planImport } from '../../src/modules/contacts/contacts-import.js';
import { categoryLabels, categoryLabel, SUGGESTED_LABELS, SUGGESTED_CATEGORIES, suggestedId, createDoc, importId, editPatch } from '../../src/modules/contacts/contact-model.js';
import { navOf, listOf, createContactsNav, SUB_VIEWS } from '../../src/modules/contacts/contacts-nav.js';
import en from '../../src/core/i18n/locales/en.js';
import ar from '../../src/core/i18n/locales/ar.js';
import { readFileSync } from 'node:fs';

const doc = (items, extra = {}) => JSON.stringify({ schema: JSON_SCHEMA, version: JSON_VERSION, items, ...extra });
const C = (id, name, phones = [], extra = {}) => ({ id, name, phones, categoryIds: [], favorite: false, rev: 1, deleted: false, organization: null, email: null, address: null, notes: null, ...extra });
const CATS = [...SUGGESTED_CATEGORIES.map((key) => ({ id: suggestedId(key), key, name: null, rev: 1 })), { id: 'cust01', name: 'Gym', rev: 1 }];
const preview = (text, opts = {}) => buildPreview(parseContactsJson(text), { categories: CATS, labelsOf: categoryLabels, ...opts });

test('A-json: whole-file rejections — size, encoding, empty, depth, not JSON, wrong top level / schema / version / items, too many', () => {
  const code = (x) => parseContactsJson(x).fileErrors[0];
  assert.equal(code(new Uint8Array(JSON_LIMITS.bytes + 1)), 'tooLarge');
  assert.equal(code('x'.repeat(JSON_LIMITS.bytes + 1)), 'tooLarge');
  assert.equal(code(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), 'encoding', 'invalid UTF-8 is refused, never guessed');
  assert.equal(code('   \n'), 'empty');
  assert.equal(code('[[[[[[[[1]]]]]]]]'), 'tooDeep');
  assert.equal(nestingDepth('{"a":"[[[[[[[[[["}'), 1, 'brackets inside strings do not count');
  assert.equal(nestingDepth('{"a":"\\"[[[[[[[[["}'), 1, 'escaped quotes handled');
  assert.equal(code('{"schema":'), 'notJson');
  assert.equal(code('[]'), 'notObject');
  assert.equal(code('"text"'), 'notObject');
  assert.equal(code('null'), 'notObject');
  const extra = parseContactsJson(doc([], { household: 'h1', __proto__x: 1 }));
  assert.equal(extra.fileErrors[0], 'unknownTop'); assert.deepEqual(extra.unknown, ['household', '__proto__x']);
  assert.equal(code('{"schema":"homehub.contacts","version":1,"items":[],"__proto__":{"admin":true}}'), 'unknownTop', '__proto__ at the top level is an unknown key');
  assert.equal(code(JSON.stringify({ schema: 'other', version: 1, items: [] })), 'schema');
  assert.equal(code(JSON.stringify({ schema: JSON_SCHEMA, version: 2, items: [] })), 'version');
  assert.equal(code(JSON.stringify({ schema: JSON_SCHEMA, version: '1', items: [] })), 'version', 'version is a number, not a string');
  assert.equal(code(JSON.stringify({ schema: JSON_SCHEMA, version: 1, items: {} })), 'items');
  assert.equal(code(JSON.stringify({ schema: JSON_SCHEMA, version: 1 })), 'items');
  assert.equal(code(doc(Array.from({ length: JSON_LIMITS.items + 1 }, (_, i) => ({ name: `n${i}` })))), 'tooMany');
  assert.deepEqual(parseContactsJson(doc(Array.from({ length: JSON_LIMITS.items }, (_, i) => ({ name: `n${i}` })))).fileErrors, [], 'exactly the limit is fine');
  assert.deepEqual(parseContactsJson(`﻿${doc([{ name: 'A' }])}`).fileErrors, [], 'UTF-8 BOM tolerated');
  assert.deepEqual(parseContactsJson(new TextEncoder().encode(doc([{ name: 'A' }]))).fileErrors, [], 'bytes input');
});

test('A-json: per-item validation — unknown / prototype keys, wrong types, limits; invalid items are excluded, valid ones stay', () => {
  const p = parseContactsJson('{"schema":"homehub.contacts","version":1,"items":['
    + '{"name":"Ok","phones":[{"number":"01001234567"}]},'
    + '{"name":"Proto","__proto__":{"isAdmin":true}},'
    + '{"name":"Ctor","constructor":{"prototype":{}}},'
    + '{"name":"Id","id":"abc","createdBy":"u1"},'
    + '{"name":5},{"organization":"no name"},"string item",null,[1],'
    + '{"name":"BadPhone","phones":"0100"},{"name":"BadPhone2","phones":[{"number":1}]},{"name":"PhoneKey","phones":[{"number":"1","ext":"2"}]},'
    + '{"name":"Fav","favorite":"yes"},{"name":"Cats","categories":"Doctors"},{"name":"Cats2","categories":["  "]},'
    + '{"name":"Menus","menus":[{"type":"video","url":"https://a.com/x"}]},{"name":"Nulls","email":null,"phones":null,"categories":null,"avatarUrl":null}'
    + ']}');
  assert.deepEqual(p.fileErrors, []);
  const by = Object.fromEntries(p.records.map((r) => [typeof r.value.name === 'string' && r.value.name ? r.value.name : `#${r.index}`, r]));
  assert.equal(by.Ok.ok, true); assert.deepEqual(by.Ok.value.phones, [{ label: 'other', number: '01001234567' }], 'missing label → other');
  assert.deepEqual(by.Proto.errors, ['unknownField']); assert.deepEqual(by.Proto.unknownFields, ['__proto__']);
  assert.equal(({}).isAdmin, undefined, 'no prototype pollution'); assert.equal(Object.prototype.isAdmin, undefined);
  assert.deepEqual(by.Ctor.errors, ['unknownField']);
  assert.deepEqual(by.Id.unknownFields, ['id', 'createdBy'], 'ids / audit fields are never imported');
  assert.ok(by['#4'].errors.includes('fieldType') && by['#4'].errors.includes('noName'));
  assert.deepEqual(by['#5'].errors, ['noName']);
  for (const i of [6, 7, 8]) assert.deepEqual(by[`#${i}`].errors, ['itemType']);
  for (const n of ['BadPhone', 'BadPhone2', 'PhoneKey']) assert.ok(by[n].errors.includes('phoneType'), n);
  assert.deepEqual(by.Fav.errors, ['fieldType']); assert.deepEqual(by.Cats.errors, ['categoryType']); assert.deepEqual(by.Cats2.errors, ['categoryType']);
  assert.deepEqual(by.Menus.errors, ['menuType']);
  assert.equal(by.Nulls.ok, true, 'null = absent');
  const tooMany = parseContactsJson(doc([{ name: 'P', phones: Array.from({ length: 11 }, () => ({ number: '0100' })) }, { name: 'C', categories: Array.from({ length: 11 }, (_, i) => `c${i}`) },
    { name: 'M', menus: Array.from({ length: 11 }, () => ({ type: 'web', url: 'https://a.com/' })) }])).records;
  assert.deepEqual(tooMany.map((r) => r.errors[0]), ['tooManyPhones', 'tooManyCategories', 'tooManyMenus']);
  // the shared validators then run in the preview: limits, e-mail, numbers, media URLs
  const pv = preview(doc([{ name: 'x'.repeat(121) }, { name: 'E', email: 'nope' }, { name: 'N', phones: [{ number: 'javascript:1' }] },
    { name: 'U', avatarUrl: 'http://a.com/a.png' }, { name: 'U2', avatarUrl: 'https://user:pw@a.com/a.png' }, { name: 'U3', menus: [{ type: 'image', url: 'https://localhost/x.png' }] },
    { name: 'Good', email: 'g@x.co' }]));
  assert.deepEqual(pv.items.map((i) => i.status), ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'new']);
  assert.deepEqual(pv.items[3].errors, ['urlHttps']); assert.ok(pv.items[4].errors.includes('urlCredentials'));
  assert.equal(planImport(pv.items, { source: 'json' }).length, 1, 'invalid items are excluded, the valid one is planned');
  assert.deepEqual(preview(doc([{ name: 'H', id: 'x', createdBy: 'u' }])).items[0].unknownFields, ['id', 'createdBy'], 'the preview names the refused fields');
});

test('A-json: Unicode / RTL kept exactly; Arabic-Indic digits normalised like manual entry; export ↔ import round trip', () => {
  const contacts = [
    C('aaaaaa01', 'د. أحمد عبد الرحمن', ['mobile|+20 100 123 4567', 'Clinic desk|0223456789'], { organization: 'عيادة النيل', notes: 'الأحد ‏والأربعاء\nمساءً', favorite: true, categoryIds: ['s_doctors', 'cust01', 'gone99'] }),
    C('aaaaaa02', 'Pizza Place', ['work|0100'], { avatarUrl: 'https://img.example.com/p.png', menus: ['image|Page 1|https://img.example.com/m1.jpg', 'pdf||https://img.example.com/m.pdf'], categoryIds: ['s_restaurants'] }),
    C('aaaaaa03', 'Deleted', [], { deleted: true }),
  ];
  const name = (id) => { const c = CATS.find((k) => k.id === id); return c ? categoryLabel(c, (k) => en[k]) : null; };
  const text = exportContactsJson(contacts.filter((c) => !c.deleted), { categoryName: name });
  const obj = JSON.parse(text);
  assert.deepEqual(Object.keys(obj), ['schema', 'version', 'items']);
  assert.ok(!/aaaaaa0|"id"|rev|createdBy|updatedAt|deleted|household/.test(text), 'no ids / audit / household data');
  const ahmad = obj.items.find((i) => i.organization);
  assert.deepEqual(ahmad.categories, ['Doctors', 'Gym'], 'removed categories are not exported');
  assert.equal(ahmad.notes, 'الأحد ‏والأربعاء\nمساءً', 'RTL marks / newlines kept');
  const pizza = obj.items.find((i) => i.name === 'Pizza Place');
  assert.deepEqual(pizza.menus, [{ type: 'image', label: 'Page 1', url: 'https://img.example.com/m1.jpg' }, { type: 'pdf', url: 'https://img.example.com/m.pdf' }]);
  assert.equal('email' in pizza, false, 'empty values omitted');
  // import it into an EMPTY household → same content, same media, same categories
  const pv = preview(text);
  assert.deepEqual(pv.items.map((i) => i.status), ['new', 'new']);
  const back = Object.fromEntries(pv.items.map((i) => [i.value.name, i.value]));
  assert.equal(back['د. أحمد عبد الرحمن'].organization, 'عيادة النيل');
  assert.deepEqual(back['د. أحمد عبد الرحمن'].phones, ['mobile|+20 100 123 4567', 'Clinic desk|0223456789']);
  assert.deepEqual(back['د. أحمد عبد الرحمن'].categoryIds, ['s_doctors', 'cust01']);
  assert.equal(back['د. أحمد عبد الرحمن'].favorite, true);
  assert.equal(back['Pizza Place'].avatarUrl, 'https://img.example.com/p.png');
  assert.deepEqual(back['Pizza Place'].menus, ['image|Page 1|https://img.example.com/m1.jpg', 'pdf||https://img.example.com/m.pdf']);
  // the round trip is idempotent: importing again finds the deterministic ids → "imported", skipped
  const ops = planImport(pv.items, { source: 'json' });
  assert.ok(ops.every((o) => o.kind === 'create' && o.source === 'json' && o.copy === 0));
  const live = ops.map((o) => ({ ...o.value, id: o.id, rev: 1, deleted: false, source: 'json' }));
  assert.deepEqual(preview(text, { contacts: live }).items.map((i) => [i.status, i.action]), [['imported', 'skip'], ['imported', 'skip']]);
  const digits = preview(doc([{ name: 'D', phones: [{ label: 'mobile', number: '٠١٠٠ ١٢٣ ٤٥٦٧' }] }])).items[0];
  assert.deepEqual(digits.value.phones, ['mobile|0100 123 4567']);
});

test('A-json: category identity is stable across Arabic / English export and import', () => {
  for (const key of SUGGESTED_CATEGORIES) {
    assert.equal(en[`contacts.cat.${key}`], SUGGESTED_LABELS[key][0], `EN label of ${key} is recognised on import`);
    assert.equal(ar[`contacts.cat.${key}`], SUGGESTED_LABELS[key][1], `AR label of ${key} is recognised on import`);
  }
  const contact = C('bbbbbb01', 'Sara', ['mobile|0100 111 2222'], { categoryIds: ['s_doctors', 's_pharmacies', 'cust01'] });
  for (const dict of [en, ar]) {
    const nm = (id) => { const c = CATS.find((k) => k.id === id); return c ? categoryLabel(c, (k) => dict[k]) : null; };
    const text = exportContactsJson([contact], { categoryName: nm, locale: dict === ar ? 'ar' : 'en' });
    assert.deepEqual(JSON.parse(text).items[0].categories, dict === ar ? ['أطباء', 'صيدليات', 'Gym'] : ['Doctors', 'Pharmacies', 'Gym']);
    const it = preview(text).items[0];
    assert.deepEqual(it.value.categoryIds, ['s_doctors', 's_pharmacies', 'cust01'], 'same category ids whatever the export language');
    assert.deepEqual(it.unknownCategories, []);
  }
  const it = preview(doc([{ name: 'X', categories: ['DOCTORS', 'Unknown Cat', 'مطاعم'] }])).items[0];
  assert.deepEqual(it.value.categoryIds, ['s_doctors', 's_restaurants'], 'case-insensitive; never creates a category');
  assert.deepEqual(it.unknownCategories, ['Unknown Cat']);
});

test('A-json: duplicates default to skip; merge is explicit and never overwrites media (or text) unless that field is ticked', () => {
  const existing = C('cccccc01', 'Pizza Place', ['work|0100 222 3333'], { avatarUrl: 'https://img.example.com/old.png', menus: ['image||https://img.example.com/old.jpg'], organization: 'Old Org', rev: 4 });
  const text = doc([{ name: 'Pizza Place', organization: 'New Org', email: 'p@x.co', phones: [{ label: 'mobile', number: '0100 222 3333' }, { label: 'home', number: '0225556666' }],
    avatarUrl: 'https://img.example.com/new.png', menus: [{ type: 'image', url: 'https://img.example.com/new.jpg' }] }]);
  const pv = preview(text, { contacts: [existing] });
  const it = pv.items[0];
  assert.equal(it.status, 'duplicate'); assert.equal(it.action, 'skip', 'duplicates are skipped by default');
  assert.equal(planImport(pv.items, { contacts: [existing], source: 'json' }).length, 0);
  assert.deepEqual(conflictPairs(existing, it.value).map((c) => c.field), ['organization', 'avatarUrl', 'menus']);
  // merge with NOTHING ticked → fills empty e-mail, adds the new number, keeps org / picture / menus
  let [op] = planImport([{ ...it, action: 'merge' }], { contacts: [existing], source: 'json' });
  assert.equal(op.kind, 'merge'); assert.equal(op.baseRev, 4);
  assert.equal(op.value.organization, 'Old Org'); assert.equal(op.value.email, 'p@x.co');
  assert.equal('avatarUrl' in op.value || 'menus' in op.value, false, 'conflicting media not carried → stored picture / menus untouched');
  let patch = editPatch(existing, op.value, { uid: 'u1', now: 1 });
  assert.deepEqual(Object.keys(patch).filter((k) => !['rev', 'updatedBy', 'updatedAt'].includes(k)).sort(), ['email', 'phones']);
  assert.ok(op.value.phones.includes('home|0225556666'));
  assert.deepEqual(op.conflicts.sort(), ['avatarUrl', 'menus', 'organization']);
  // ticking ONLY the picture replaces only the picture
  [op] = planImport([{ ...it, action: 'merge', take: new Set(['avatarUrl']) }], { contacts: [existing], source: 'json' });
  assert.equal(op.value.avatarUrl, 'https://img.example.com/new.png'); assert.equal('menus' in op.value, false); assert.equal(op.value.organization, 'Old Org');
  patch = editPatch(existing, op.value, { uid: 'u1', now: 1 }); assert.equal(patch.avatarUrl, 'https://img.example.com/new.png'); assert.equal('menus' in patch, false);
  [op] = planImport([{ ...it, action: 'merge', take: new Set(['menus', 'organization', 'id', 'createdBy']) }], { contacts: [existing], source: 'json' });
  assert.deepEqual(op.value.menus, ['image||https://img.example.com/new.jpg']); assert.equal(op.value.organization, 'New Org');
  assert.equal('createdBy' in op.value, false, 'only allow-listed fields can be taken');
  // a contact without media gets the media filled (adding is not overwriting)
  const bare = { ...existing, avatarUrl: undefined, menus: undefined };
  const m = mergeJson(bare, it.value);
  assert.equal(m.value.avatarUrl, 'https://img.example.com/new.png'); assert.ok(!m.conflicts.includes('avatarUrl'));
  // .vcf merges are unchanged (no media at all)
  const [vop] = planImport([{ ...it, action: 'merge', take: new Set(['avatarUrl']) }], { contacts: [existing], source: 'vcf' });
  assert.equal('avatarUrl' in vop.value || 'menus' in vop.value, false, '.vcf merge carries no media keys → stored media untouched');
  // a JSON create keeps its validated media; a .vcf create never stores media
  assert.equal(createDoc(it.value, { uid: 'u1', now: 1, source: 'json' }).avatarUrl, it.value.avatarUrl);
  assert.equal('avatarUrl' in createDoc(it.value, { uid: 'u1', now: 1, source: 'vcf' }), false);
});

test('A-json: AI helpers are local text, describe the exact contract, and the example is itself importable', () => {
  assert.deepEqual(parseContactsJson(exampleText()).fileErrors, []);
  assert.ok(preview(exampleText()).items.every((i) => i.status === 'new'), 'example items are valid');
  const prompt = aiPrompt();
  assert.match(prompt, /NEVER guess or invent/); assert.match(prompt, /ONLY valid JSON/); assert.ok(prompt.includes(JSON_SCHEMA));
  for (const k of ITEM_KEYS) assert.ok(prompt.includes(k), k);
  const schema = JSON.parse(schemaText());
  assert.equal(schema.additionalProperties, false); assert.deepEqual(Object.keys(schema.properties.items.items.properties).sort(), [...ITEM_KEYS].sort());
  assert.equal(EXAMPLE.items.length, 2);
  assert.equal(jsonFileName('a/b:c'), 'a-b-c.json'); assert.equal(jsonFileName(''), 'contacts.json');
  const src = readFileSync(new URL('../../src/modules/contacts/contacts-json.js', import.meta.url), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|api\.openai|anthropic\.com|generativelanguage/.test(src), 'no network / AI API');
});

test('A-nav: history state helpers validate everything and never stack sub-views; back is one step', () => {
  assert.equal(navOf(null), null); assert.equal(navOf({ ctNav: { v: 'admin' } }), null);
  assert.deepEqual(navOf({ ctNav: { v: 'detail', id: 'abcdef12' } }), { v: 'detail', id: 'abcdef12' });
  assert.equal(navOf({ ctNav: { v: 'detail', id: '../x' } }), null, 'bad id → list');
  for (const v of SUB_VIEWS.filter((x) => x !== 'detail')) assert.deepEqual(navOf({ ctNav: { v, id: 'ignored1' } }), { v });
  assert.deepEqual(listOf({ ctList: { q: 'x'.repeat(500), cat: 7, fav: 'yes', y: -5 } }), { q: 'x'.repeat(200), cat: 'all', fav: false, y: 0 });
  assert.deepEqual(listOf({ ctList: { q: 'دكتور', cat: 's_doctors', fav: true, y: 812 } }), { q: 'دكتور', cat: 's_doctors', fav: true, y: 812 });
  // a fake window with a real-ish history stack
  const listeners = new Set(); const stack = [{ state: { router: 1 } }]; let i = 0; let backs = 0;
  const win = { addEventListener: (t, f) => listeners.add(f), removeEventListener: (t, f) => listeners.delete(f),
    history: { get state() { return stack[i].state; }, replaceState(s) { stack[i] = { state: s }; }, pushState(s) { stack.splice(i + 1); stack.push({ state: s }); i++; },
      back() { backs++; if (i > 0) { i--; for (const f of listeners) f(); } } } };
  const seen = []; const nav = createContactsNav({ onChange: (n, l) => seen.push([n, l]), win });
  nav.open({ v: 'detail', id: 'abcdef12' }, { q: 'a', cat: 'all', fav: true, y: 300 });
  assert.equal(stack.length, 2); assert.deepEqual(stack[0].state, { router: 1, ctList: { q: 'a', cat: 'all', fav: true, y: 300 } }, 'list state saved on the list entry; router state kept');
  assert.deepEqual(nav.current(), { v: 'detail', id: 'abcdef12' });
  nav.open({ v: 'import' }, { q: 'ignored', cat: 'all', fav: false, y: 0 });
  assert.equal(stack.length, 2, 'a sub-view from a sub-view replaces, never stacks');
  nav.back();
  assert.equal(i, 0); assert.deepEqual(seen.at(-1), [null, { q: 'a', cat: 'all', fav: true, y: 300 }], 'one step back = the list with its filters and scroll');
  nav.back(); assert.equal(backs, 1, 'on the list, back() never leaves Contacts');
  nav.replaceList({ q: 'b', cat: 'all', fav: false, y: 10 }); assert.equal(stack.length, 2, 'no new entry'); assert.equal(stack[0].state.ctList.q, 'b');
  nav.dispose(); assert.equal(listeners.size, 0);
});
