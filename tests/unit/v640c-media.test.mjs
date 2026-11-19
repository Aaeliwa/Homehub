// V6.4 Batch C — contact pictures and restaurant menus: URL safety (client = rules grammar), menus encoding /
// ordering / limits, Drive embeds, presentation rules, backward compatibility (no erasure by imports, merges,
// older clients or a no-op edit), category rename / removal / reassignment, stale revisions, vCard regression,
// service worker / CSP / sandbox static guarantees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeHttpsUrl, isStoredUrl, driveEmbedUrl, detectKind, menuPresentation, encodeMenu, decodeMenu, menusOf, storedMenusOk, validateMedia,
  restaurantCategoryIds, showsMenu, URL_PATTERN, MENU_ENTRY_PATTERN, MENU_ENTRY_LENGTH_PATTERN, HOST_DENY_PATTERN, MENUS_DENY_PATTERN, MEDIA_LIMITS, isStoredMenuEntry } from '../../src/modules/contacts/contact-media.js';
import { validateContact, createDoc, editPatch, mergeValue, CONTENT_FIELDS, MEDIA_FIELDS, liveCategoryIds } from '../../src/modules/contacts/contact-model.js';
import { parseVcf, exportVcf } from '../../src/modules/contacts/vcard.js';
import { createContactsStore } from '../../src/modules/contacts/contacts-store.js';
import { buildPreview, planImport } from '../../src/modules/contacts/contacts-import.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const RULES = read('firestore.rules');
/** The regex literals of a rules function, unescaped exactly as the rules engine reads them. */
const rulesRegexes = (fn) => [...RULES.slice(RULES.indexOf(`function ${fn}(`), RULES.indexOf('\n    }', RULES.indexOf(`function ${fn}(`))).matchAll(/matches\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1].replace(/\\\\/g, '\\'));
const IMG = 'https://cdn.example.com/menu/p1.jpg';
const M = (kind, label, url) => encodeMenu({ kind, label, url });

test('C-url: the client grammar IS the rules grammar (URL + deny, per-element menu entry, joined-list deny)', () => {
  assert.deepEqual(rulesRegexes('contactUrlOk'), [URL_PATTERN, HOST_DENY_PATTERN]);
  assert.deepEqual(rulesRegexes('contactMenuOk'), [MENU_ENTRY_LENGTH_PATTERN, MENU_ENTRY_PATTERN]);
  assert.deepEqual(rulesRegexes('contactMenusOk'), [MENUS_DENY_PATTERN]);
  assert.match(RULES, /function contactUrlOk\(v\) \{\s+return v is string && v\.size\(\) <= 500 && v\.matches\([^\n]+\)\s+&& !v\.matches\(/);
  // rev 2 (C1): every index 0–9 is validated ON ITS OWN, structure before the joined (negative) deny check
  const fn = RULES.slice(RULES.indexOf('function contactMenusOk('), RULES.indexOf('function contactMediaOk('));
  assert.match(fn, /return l is list && l\.size\(\) <= 10 &&/);
  assert.deepEqual([...fn.matchAll(/contactMenuOk\(l, (\d)\)/g)].map((m) => Number(m[1])), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(fn.indexOf('contactMenuOk(l, 9)') < fn.indexOf("l.join('|')"), 'join only after all elements passed');
  assert.ok(!/l\.join\('\|'\)\.matches\(/.test(fn.replace(/!l\.join/, '')), 'the joined string is never used for a POSITIVE (structure) check');
  assert.ok(!/\/\//.test(URL_PATTERN + MENU_ENTRY_PATTERN + HOST_DENY_PATTERN + MENUS_DENY_PATTERN), 'no "//" in rules strings (https:[/][/])');
});

/** An independent model of the RULES' menus check, built only from the regex literals in firestore.rules. */
const [R_LEN, R_FMT] = rulesRegexes('contactMenuOk').map((x) => new RegExp(x, 'u'));
const [R_DENY] = rulesRegexes('contactMenusOk').map((x) => new RegExp(x, 'u'));
const rulesMenusOk = (l) => Array.isArray(l) && l.length <= 10 && l.every((e) => typeof e === 'string' && R_LEN.test(e) && R_FMT.test(e)) && (l.length === 0 || !R_DENY.test(l.join('|')));

test('C1 rev2: adversarial menu arrays — combined, split, merged, shifted and malformed elements are refused (client = rules model)', () => {
  const ok = 'https://a.example/1.jpg'; const ok2 = 'https://b.example/menu.pdf';
  const E = (k, l, u) => `${k}|${l}|${u}`;
  const bad = {
    'two entries combined in ONE element': [E('image', 'a', ok) + '|' + E('pdf', 'b', ok2)],
    'one entry SPLIT across two elements': ['image', 'a|' + ok],
    'one entry split three ways': ['image', 'a', ok],
    'kind|label in one, url in the next': ['image|a', ok],
    '11 entries smuggled into 6 elements': [...Array.from({ length: 5 }, () => E('image', '', ok) + '|' + E('image', '', ok)), E('image', '', ok)],
    'trailing separator': [E('image', 'a', ok) + '|'],
    'leading separator': ['|' + E('image', 'a', ok)],
    'extra field': [E('image', 'a', ok) + '|x'],
    'pipe inside label': ['image|a|b|' + ok],
    'empty element': [''],
    'empty element after a valid one': [E('image', 'a', ok), ''],
    'separator-only element': ['||'],
    'kind only + empty fields': ['image||'],
    'unknown kind': [E('exe', 'a', ok)],
    'upper-case kind': [E('IMAGE', 'a', ok)],
    'label 41 characters': [E('image', 'x'.repeat(41), ok)],
    'url 501 characters': [E('image', '', `https://a.example/${'x'.repeat(483)}`)],
    'newline in label': [E('image', 'a\nb', ok)],
    'http url': [E('image', 'a', 'http://a.example/1.jpg')],
    'credentials': [E('image', 'a', 'https://u:p@a.example/1.jpg')],
    'local host in 2nd element': [E('image', 'a', ok), E('web', 'r', 'https://router.local/')],
    'wildcard-DNS host': [E('image', 'a', 'https://10.0.0.1.nip.io/x.jpg')],
    'non-string element': [5], 'null element': [E('image', 'a', ok), null], 'object element': [{ kind: 'image', label: '', url: ok }],
    'nested list': [[E('image', 'a', ok)]],
  };
  for (const [why, l] of Object.entries(bad)) {
    assert.equal(storedMenusOk(l), false, `client: ${why}`);
    assert.equal(rulesMenusOk(l), false, `rules: ${why}`);
  }
  const good = {
    'one entry': [E('image', 'a', ok)],
    'label that LOOKS like a local URL (text only)': [E('image', 'https://router.local', ok)],
    'empty label, all kinds': ['image', 'pdf', 'web', 'drive'].map((k) => E(k, '', k === 'drive' ? 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view' : ok)),
    '10 entries at the limits (40-char Arabic / emoji labels, 500-char urls)': Array.from({ length: 10 }, (_, i) => E('image', (i % 2 ? 'ق' : '😀').repeat(40), `https://a.example/${'p'.repeat(481)}${i}`)),
    'empty list': [],
  };
  for (const [why, l] of Object.entries(good)) {
    assert.equal(storedMenusOk(l), true, `client: ${why}`);
    assert.equal(rulesMenusOk(l), true, `rules: ${why}`);
  }
  assert.equal(`https://a.example/${'p'.repeat(481)}0`.length, 500);
  assert.equal(isStoredMenuEntry(E('image', 'a', ok) + '|' + E('pdf', 'b', ok2)), false);
  assert.equal(decodeMenu(E('image', 'a', ok) + '|' + E('pdf', 'b', ok2)), null, 'a combined element is never rendered');
});

test('C-url: valid links are normalised (lower-case host, IDN → punycode, unsafe path characters encoded)', () => {
  const ok = {
    'https://Example.COM/menu.jpg': 'https://example.com/menu.jpg',
    '  https://cdn.example.com/a b.png  ': 'https://cdn.example.com/a%20b.png',
    'https://مطعم.example/منيو.png': 'https://xn--2gbe8ac.example/%D9%85%D9%86%D9%8A%D9%88.png',
    'https://a.example/x|y{z}^': 'https://a.example/x%7Cy%7Bz%7D%5E',
    'https://maps.google.com/@30.1,31.2,15z': 'https://maps.google.com/@30.1,31.2,15z',
    'https://a.co.uk:8443/p?q=1&r=2#top': 'https://a.co.uk:8443/p?q=1&r=2#top',
    'https://a.example/‮gnp.exe': 'https://a.example/gnp.exe',                 // bidi override stripped, not hidden
  };
  for (const [raw, url] of Object.entries(ok)) {
    assert.deepEqual(normalizeHttpsUrl(raw), { url }, raw);
    assert.ok(new RegExp(URL_PATTERN).test(url) && isStoredUrl(url), `rules accept ${url}`);
  }
  assert.deepEqual(normalizeHttpsUrl(''), { empty: true }); assert.deepEqual(normalizeHttpsUrl('   '), { empty: true });
});

test('C-url: dangerous / malformed / oversized links are refused — by the client AND by the rules grammar', () => {
  const bad = {
    'javascript:alert(1)': 'urlScheme', ' JaVaScRiPt:alert(1)': 'urlScheme', 'java\nscript:alert(1)': 'urlScheme', 'vbscript:x': 'urlScheme',
    'data:image/png;base64,iVBORw0KGgo=': 'urlScheme', 'data:text/html,<script>alert(1)</script>': 'urlScheme', 'file:///etc/passwd': 'urlScheme',
    'blob:https://a.example/1': 'urlScheme', 'about:blank': 'urlScheme', 'intent://x#Intent;end': 'urlScheme', 'ftp://a.example/x': 'urlScheme',
    'http://a.example/x.jpg': 'urlHttps',
    'https://user:pass@a.example/x': 'urlCredentials', 'https://a.example@evil.example/x': 'urlCredentials', 'https://user@a.example/': 'urlCredentials',
    'https://localhost/x': 'url', 'https://127.0.0.1/x': 'url', 'https://192.168.1.1/admin': 'url', 'https://[::1]/x': 'url', 'https://a/x': 'url',
    'https://foo.localhost/x': 'urlHost', 'https://printer.local/': 'urlHost', 'https://nas.home.arpa/': 'urlHost', 'https://router.home/': 'urlHost',
    'https://db.internal/': 'urlHost', 'https://app.corp/': 'urlHost', 'https://srv.lan/': 'urlHost', 'https://192.168.1.1.nip.io/': 'urlHost', 'https://127-0-0-1.sslip.io/': 'urlHost',
    'https://localtest.me/': 'urlHost', 'https://x.lvh.me/': 'urlHost', 'https://a.localdomain/': 'urlHost', 'https://foo.localhost./x': 'url',
    '//evil.example/x': 'url', 'example.com/menu.jpg': 'url', 'https://exa mple.com/': 'url', 'https://': 'url', 'not a url': 'url',
    [`https://a.example/${'x'.repeat(483)}`]: 'urlLong', [`https://a.example/${'x'.repeat(3000)}`]: 'urlLong',
  };
  for (const [raw, code] of Object.entries(bad)) assert.deepEqual(normalizeHttpsUrl(raw), { error: `contacts.v.${code}` }, raw);
  // the RULES grammar alone (a malicious client skipping validation) refuses the raw forms too
  const re = new RegExp(URL_PATTERN);
  for (const raw of ['javascript:alert(1)', 'http://a.example/x', 'https://u:p@a.example/x', 'https://a.example@evil.example/', 'https://127.0.0.1/x', 'https://[::1]/',
    'https://Example.com/x', 'https://a.example/x y', 'https://foo.localhost/x', 'https://printer.local:8443/x', 'https://1.2.3.4.nip.io/x', 'https://a.example/"><img src=x onerror=alert(1)>', 'https://a.example/x\u0000', 'https://a.example/x|y', 'HTTPS://a.example/', 'https://a.example\\@b.example/'])
    assert.ok(!(re.test(raw) && !new RegExp(HOST_DENY_PATTERN).test(raw)), `rules refuse ${JSON.stringify(raw)}`);   // = contactUrlOk
  assert.ok(!isStoredUrl(`https://a.example/${'x'.repeat(490)}`), '> 500 characters');
});

test('C-drive: only Google Drive / Docs FILE links embed, via their official /preview URL (sharing untouched)', () => {
  const cases = {
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing': 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview',
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/edit': 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview',
    'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp': 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview',
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?resourcekey=0-abc_DEF': 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview?resourcekey=0-abc_DEF',
    'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit': 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/preview',
    'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/': 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/preview',
    'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit': 'https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/preview',
  };
  for (const [u, e] of Object.entries(cases)) assert.equal(driveEmbedUrl(u), e, u);
  for (const u of ['https://drive.google.com.evil.example/file/d/1AbCdEfGhIjKlMnOp/view', 'https://evil.example/drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view',
    'http://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view', 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp', 'https://drive.google.com/file/d/short/view',
    'https://docs.google.com/forms/d/1AbCdEfGhIjKlMnOp/viewform', 'https://docs.google.com/document/d/e/2PACX-1vT/pub', 'https://sites.google.com/view/menu', 'https://www.youtube.com/watch?v=x'])
    assert.equal(driveEmbedUrl(u), null, u);
  assert.equal(detectKind('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view'), 'drive');
  assert.equal(detectKind('https://a.example/Menu.PDF'), 'pdf'); assert.equal(detectKind('https://a.example/p1.WEBP?x=1'), 'image'); assert.equal(detectKind('https://a.example/logo.svg'), 'image'); assert.equal(detectKind('https://a.example/menu'), 'web');
  assert.equal(menuPresentation({ kind: 'image', url: IMG }), 'image');
  assert.equal(menuPresentation({ kind: 'pdf', url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view' }), 'embed', 'a Drive-hosted PDF previews in Drive');
  assert.equal(menuPresentation({ kind: 'pdf', url: 'https://a.example/menu.pdf' }), 'link', 'other PDFs: open original only');
  assert.equal(menuPresentation({ kind: 'web', url: 'https://a.example/menu' }), 'link', 'websites are never embedded');
});

test('C-menus: multiple ordered links, labels, auto-detection, blank rows dropped, limits, idempotent re-validation', () => {
  const e = {};
  const v = validateMedia({ menus: [{ kind: 'auto', label: ' Lunch  page ', url: IMG }, { kind: 'auto', label: '', url: '' },
    { kind: 'auto', label: 'قائمة', url: 'https://a.example/menu.pdf' }, { kind: 'web', label: 'Site', url: 'https://a.example/' }, { kind: 'auto', label: '', url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view' }] }, e);
  assert.deepEqual(e, {});
  assert.deepEqual(v.menus, [M('image', 'Lunch page', IMG), M('pdf', 'قائمة', 'https://a.example/menu.pdf'), M('web', 'Site', 'https://a.example/'), M('drive', '', 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view')]);
  assert.ok(storedMenusOk(v.menus));
  const again = {}; assert.deepEqual(validateMedia({ menus: v.menus }, again).menus, v.menus, 'stored strings re-validate unchanged'); assert.deepEqual(again, {});
  const reordered = [v.menus[2], v.menus[0], v.menus[1]];
  assert.deepEqual(validateMedia({ menus: reordered }, {}).menus, reordered, 'order is the user’s order');
  const errs = (rows) => { const x = {}; validateMedia({ menus: rows }, x); return x; };
  assert.deepEqual(errs([{ kind: 'image', label: 'x'.repeat(41), url: IMG }]), { menu0: 'contacts.v.menuLabel' });
  assert.deepEqual(errs([{ kind: 'image', label: 'a|b', url: IMG }]), { menu0: 'contacts.v.menuLabel' });
  assert.deepEqual(errs([{ kind: 'drive', label: '', url: 'https://a.example/x' }]), { menu0: 'contacts.v.menuDrive' });
  assert.deepEqual(errs([{ kind: 'exe', label: '', url: IMG }]), { menu0: 'contacts.v.menuKind' });
  assert.deepEqual(errs([{ kind: 'image', label: 'Only a label', url: '' }]), { menu0: 'contacts.v.menuUrl' });
  assert.deepEqual(errs([{ kind: 'image', label: '', url: 'javascript:alert(1)' }]), { menu0: 'contacts.v.urlScheme' });
  assert.deepEqual(errs(['image|x|http://a.example/x.jpg']), { menu0: 'contacts.v.urlScheme' }, 'a tampered stored entry is an error, never silently dropped');
  assert.deepEqual(errs(Array.from({ length: 11 }, (_, i) => ({ kind: 'image', label: '', url: `https://a.example/${i}.jpg` }))), { menus: 'contacts.v.tooManyMenus' });
  assert.equal(decodeMenu('image|x'), null); assert.equal(decodeMenu('exe|x|https://a.example/'), null);
  assert.deepEqual(menusOf({ menus: [M('image', 'a', IMG), 'junk', 7] }), [{ kind: 'image', label: 'a', url: IMG }], 'only valid entries are rendered');
});

test('C-menus: the rules list check refuses tampered direct writes (format and length)', () => {
  const bad = [
    ['exe|x|https://a.example/'], ['image|x|http://a.example/x.jpg'], ['image|x|javascript:alert(1)'], ['image|x'], ['image|x|https://a.example/a|b'],
    [`image|${'x'.repeat(41)}|${IMG}`], [`image||https://a.example/${'x'.repeat(490)}`], ['image|\u0000|' + IMG], ['image|x|https://u:p@a.example/'],
    ['image|x|https://127.0.0.1/a.jpg'], ['image|x|https://a.example/<script>'], Array.from({ length: 11 }, () => M('image', '', IMG)), [5], [M('image', '', IMG), null],
  ];
  for (const l of bad) assert.equal(storedMenusOk(l), false, JSON.stringify(l).slice(0, 80));
  assert.equal(storedMenusOk([]), true);
  assert.equal(storedMenusOk(Array.from({ length: 10 }, (_, i) => M(['image', 'pdf', 'web', 'drive'][i % 4] === 'drive' ? 'web' : ['image', 'pdf', 'web'][i % 3], 'لابل ' + i, `https://a.example/${'p'.repeat(470)}${i}`))), true, '10 long entries');
});

// ------------------------------------------------------------------ compatibility: never erase media
const BASE = () => ({ id: 'c00001', name: 'Pizza Place', organization: null, email: null, address: null, notes: null, favorite: false, phones: ['mobile|0100 111 2222'],
  categoryIds: ['s_restaurants'], source: 'manual', deleted: false, rev: 4, avatarUrl: 'https://cdn.example.com/logo.png', menus: [M('image', 'p1', IMG), M('pdf', 'full', 'https://a.example/m.pdf')] });

test('C-compat: imports, merges and older-client shaped inputs carry NO media keys → can never erase media', () => {
  const plain = validateContact({ name: 'X', phones: [{ label: 'mobile', number: '0100' }] }).value;
  assert.ok(!('avatarUrl' in plain) && !('menus' in plain), 'no media keys unless given');
  assert.deepEqual(CONTENT_FIELDS, ['name', 'organization', 'email', 'address', 'notes', 'favorite', 'phones', 'categoryIds'], 'the 6.4.0-b edit field list is unchanged');
  assert.deepEqual(MEDIA_FIELDS, ['avatarUrl', 'menus']);
  const cur = BASE();
  // an older (6.4.0-b) client edits the name: its value has no media keys → patch without media
  assert.deepEqual(Object.keys(editPatch(cur, { ...plain, name: 'Pizza Place 2', categoryIds: cur.categoryIds, phones: cur.phones }, { uid: 'u', now: 'N' })).sort(), ['name', 'rev', 'updatedAt', 'updatedBy']);
  // a .vcf merge into the restaurant
  const merged = mergeValue(cur, validateContact({ name: 'Pizza Place', phones: [{ label: 'work', number: '02 3333 4444' }], organization: 'Pizza Co' }).value).value;
  const p = editPatch(cur, merged, { uid: 'u', now: 'N' });
  assert.ok(!('avatarUrl' in p) && !('menus' in p), 'merge leaves media alone'); assert.equal(p.organization, 'Pizza Co');
  // vCard import values never carry media; createDoc for an import drops any media defensively
  const d = createDoc({ ...plain, avatarUrl: IMG, menus: [M('image', '', IMG)] }, { uid: 'u', now: 'N', source: 'vcf' });
  assert.ok(!('avatarUrl' in d) && !('menus' in d));
  const m = createDoc({ ...plain, avatarUrl: null, menus: [] }, { uid: 'u', now: 'N', source: 'manual' });
  assert.ok(!('avatarUrl' in m) && !('menus' in m), 'an empty picture / menu list is not stored');
});

test('C-compat: the editor on an OLD contact (no media keys) saves nothing new; explicit changes patch exactly the media field', () => {
  const old = { ...BASE() }; delete old.avatarUrl; delete old.menus;
  const form = (x) => validateContact({ name: old.name, phones: old.phones, categoryIds: old.categoryIds, favorite: false, avatarUrl: null, menus: [], ...x }).value;
  assert.equal(editPatch(old, form({}), { uid: 'u', now: 'N' }), null, 'open + save an untouched old contact → no write, no empty media keys');
  assert.deepEqual(editPatch(old, form({ avatarUrl: 'https://cdn.example.com/a.png' }), { uid: 'u', now: 'N' }).avatarUrl, 'https://cdn.example.com/a.png');
  const cur = BASE(); const keep = { avatarUrl: cur.avatarUrl, menus: cur.menus };
  const same = validateContact({ ...cur, ...keep }).value;
  assert.equal(editPatch(cur, same, { uid: 'u', now: 'N' }), null);
  assert.deepEqual(editPatch(cur, validateContact({ ...cur, avatarUrl: '' }).value, { uid: 'u', now: 'N' }).avatarUrl, null, 'remove picture → null');
  assert.deepEqual(editPatch(cur, validateContact({ ...cur, menus: [] }).value, { uid: 'u', now: 'N' }).menus, [], 'remove all menus → []');
  assert.deepEqual(editPatch(cur, validateContact({ ...cur, menus: [cur.menus[1], cur.menus[0]] }).value, { uid: 'u', now: 'N' }).menus, [cur.menus[1], cur.menus[0]], 'reorder');
});

test('C-category: Menu section follows the Restaurants category KEY — rename keeps it, removal hides it (data kept), reassignment shows it again', () => {
  const cats = [{ id: 's_restaurants', key: 'restaurants', name: null, rev: 1 }, { id: 'cust01', key: null, name: 'Restaurants', rev: 1 }, { id: 's_doctors', key: 'doctors', name: null, rev: 1 }];
  assert.deepEqual(restaurantCategoryIds(cats), ['s_restaurants'], 'a custom category merely NAMED Restaurants does not count');
  const c = BASE();
  assert.equal(showsMenu(liveCategoryIds(c, cats), cats), true);
  const renamed = cats.map((k) => (k.id === 's_restaurants' ? { ...k, name: 'Food & takeaway', rev: 2 } : k));
  assert.equal(showsMenu(liveCategoryIds(c, renamed), renamed), true, 'renamed');
  const removed = cats.filter((k) => k.id !== 's_restaurants');
  assert.equal(showsMenu(liveCategoryIds(c, removed), removed), false, 'category removed → hidden');
  assert.equal(menusOf(c).length, 2, '…but the menu data is still there');
  const unassigned = { ...c, categoryIds: ['s_doctors'] };
  assert.equal(showsMenu(liveCategoryIds(unassigned, cats), cats), false);
  assert.equal(showsMenu(liveCategoryIds({ ...unassigned, categoryIds: ['s_doctors', 's_restaurants'] }, cats), cats), true, 'reassigned');
  // the editor sends hidden menu rows unchanged: un-assigning the category alone never touches menus
  const p = editPatch(c, validateContact({ ...c, categoryIds: ['s_doctors'] }, { categories: cats }).value, { uid: 'u', now: 'N' });
  assert.deepEqual(Object.keys(p).sort(), ['categoryIds', 'rev', 'updatedAt', 'updatedBy']);
});

// ------------------------------------------------------------------ store: revisions with media
function repoFor(db) {
  const ws = new Set(); const fire = () => { for (const w of ws) w(); };
  const list = () => [...db.entries()].map(([id, v]) => ({ id, ...v }));
  return { fire, repo: { now: () => 'NOW', newId: () => `id${db.size + 1}xxxx`,
    watchContacts: (h, on) => { const w = () => on(list().filter((c) => !c.deleted)); ws.add(w); queueMicrotask(w); return () => ws.delete(w); },
    watchCategories: (h, on) => { queueMicrotask(() => on([{ id: 's_restaurants', key: 'restaurants', name: null, order: 0, rev: 1 }])); return () => {}; },
    read: async (h, id) => (db.has(id) ? { id, ...db.get(id) } : null), readDeleted: async () => [], exists: async (h, n, id) => db.has(id),
    async commit(h, ops) {
      await new Promise((r) => setTimeout(r, 1));
      for (const o of ops) { const cur = db.get(o.id); if (o.mode === 'set' && cur) throw Object.assign(new Error('x'), { code: 'permission-denied' });
        if (o.mode === 'update' && (!cur || o.data.rev !== cur.rev + 1)) throw Object.assign(new Error('rev'), { code: 'permission-denied' }); }
      for (const o of ops) db.set(o.id, o.mode === 'set' ? { ...o.data } : { ...db.get(o.id), ...o.data });
      fire();
    } } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('C-store: media edits are revisioned — a stale editor (or second device) is refused, nothing overwritten; VCF re-import / merge keeps media', async () => {
  const db = new Map(); const { repo } = repoFor(db);
  const A = createContactsStore({ homeId: 'H', uid: 'a', repo, canView: true }); A.subscribe(() => {});
  const B = createContactsStore({ homeId: 'H', uid: 'b', repo, canView: true }); B.subscribe(() => {}); await tick();
  const id = await A.createContact({ name: 'Pizza Place', phones: [{ label: 'mobile', number: '0100 111 2222' }], categoryIds: ['s_restaurants'], avatarUrl: 'https://cdn.example.com/logo.png',
    menus: [{ kind: 'auto', label: 'p1', url: IMG }] }); await tick();
  assert.deepEqual([db.get(id).avatarUrl, db.get(id).menus, db.get(id).rev], ['https://cdn.example.com/logo.png', [M('image', 'p1', IMG)], 1]);
  const formB = { ...B.contact(id) };                                       // B opens the editor at rev 1
  await A.updateContact(id, { ...A.contact(id), menus: [...db.get(id).menus, M('pdf', 'full', 'https://a.example/m.pdf')] }, { baseRev: 1 }); await tick();
  await assert.rejects(B.updateContact(id, { ...formB, avatarUrl: null }, { baseRev: 1 }), (e) => e.detail === 'contacts.err.stale');
  assert.deepEqual([db.get(id).rev, db.get(id).menus.length, db.get(id).avatarUrl], [2, 2, 'https://cdn.example.com/logo.png'], 'B did not erase A’s menu nor the picture');
  // a .vcf for the same restaurant: merge → media untouched
  const vcf = 'BEGIN:VCARD\nVERSION:3.0\nFN:Pizza Place\nTEL:01001112222\nORG:Pizza Co\nPHOTO;VALUE=uri:https://evil.example/track.png\nURL:https://evil.example/\nEND:VCARD';
  const prev = buildPreview(parseVcf(vcf), { contacts: A.getSnapshot().contacts, categories: A.getSnapshot().categories });
  assert.equal(prev.items[0].mediaSkipped, 1, 'PHOTO (even a URI) is skipped — never fetched or stored');
  prev.items[0].action = 'merge';
  const r = await A.importContacts(planImport(prev.items, { contacts: A.getSnapshot().contacts })); await tick();
  assert.equal(r.merged, 1);
  assert.deepEqual([db.get(id).organization, db.get(id).avatarUrl, db.get(id).menus.length], ['Pizza Co', 'https://cdn.example.com/logo.png', 2]);
  await assert.rejects(A.updateContact(id, { ...A.contact(id), avatarUrl: 'javascript:alert(1)' }), (e) => e.detail === 'contacts.v.urlScheme');
});

test('C-vcard: import never yields media; export stays vCard 3.0 without PHOTO / URL / menu data (documented exclusion)', () => {
  const r = parseVcf('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Cafe\r\nPHOTO:https://evil.example/p.jpg\r\nPHOTO;MEDIATYPE=image/png:data:image/png;base64,AAAA\r\nLOGO;VALUE=uri:https://evil.example/l.png\r\nURL:https://cafe.example/menu\r\nEND:VCARD\r\n').records[0];
  assert.equal(r.mediaSkipped, 3); assert.ok(!('avatarUrl' in r.value) && !('menus' in r.value));
  assert.ok(r.unsupported.includes('URL'), 'URL reported as not imported');
  const out = exportVcf([BASE()]);
  assert.ok(!/PHOTO|LOGO|URL[:;]|X-HOMEHUB-MENU|cdn\.example|a\.example/.test(out), out);
  assert.match(out, /^BEGIN:VCARD\r\nVERSION:3\.0\r\nFN:Pizza Place\r\n/);
});

test('C-static: no HTML injection paths; iframes only sandboxed Drive/Docs previews; safe external links; SW never caches external media; CSP allow-list', () => {
  const ui = read('src/modules/contacts/media-ui.js'); const page = read('src/modules/contacts/page.js');
  for (const src of [ui, page, read('src/modules/contacts/contact-media.js')]) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'no HTML sinks');
  assert.equal((ui.match(/h\('iframe'/g) || []).length, 1, 'one iframe site'); assert.equal((page.match(/h\('iframe'/g) || []).length, 0);
  assert.match(ui, /h\('iframe', \{[\s\S]{0,200}?sandbox: EMBED_SANDBOX, allow: '', referrerpolicy: 'no-referrer', loading: 'lazy', src: driveEmbedUrl\(m\.url\)/);
  assert.match(ui, /export const EMBED_SANDBOX = 'allow-scripts allow-same-origin';/);
  assert.ok(!/allow-top-navigation|allow-popups|allow-forms|allow-modals|allow-downloads/.test(ui), 'no extra sandbox powers');
  assert.match(ui, /target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer'/);
  assert.ok((ui.match(/referrerpolicy: 'no-referrer'/g) || []).length >= 5, 'every image / frame / link without referrer');
  const sw = read('sw.js');
  assert.match(sw, /if \(req\.mode !== 'navigate' \|\| new URL\(req\.url\)\.origin !== self\.location\.origin\) return;/, 'cross-origin requests (pictures, menus) bypass the service worker');
  assert.ok(!/caches\.open|cache\.put|caches\.match/.test(sw), 'network-only: no Cache API');
  assert.match(read('index.html'), /content="frame-src https:\/\/www\.youtube-nocookie\.com https:\/\/www\.youtube\.com https:\/\/drive\.google\.com https:\/\/docs\.google\.com"/);
  assert.equal(MEDIA_LIMITS.url, 500); assert.equal(MEDIA_LIMITS.menus, 10); assert.equal(MEDIA_LIMITS.menuLabel, 40);
});
