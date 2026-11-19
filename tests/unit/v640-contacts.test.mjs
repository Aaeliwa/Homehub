// V6.4 Batch B — Shared Contacts: model (validation, phones, tel:/WhatsApp, search, duplicates, merge),
// vCard 2.1 / 3.0 / 4.0 parsing (Unicode, folding, escapes, QP, charsets, media, malformed, injection),
// export (escaping, CRLF, folding, round-trip), import preview / plan, and the store (permissions are the
// rules' job; here: revisions, stale edits, retry without duplicates, categories, two devices).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContact, telUri, whatsappTarget, matchKey, fold, searchMatch, findMatches, mergeValue, cleanNumber, importId, phonesOf,
  liveCategoryIds, createDoc, editPatch, CONTACT_LIMITS, SUGGESTED_CATEGORIES, suggestedId, categoryLabels } from '../../src/modules/contacts/contact-model.js';
import { parseVcf, exportVcf, foldLine, decodeFile, VCF_LIMITS, vcfFileName } from '../../src/modules/contacts/vcard.js';
import { buildPreview, planImport, allowedActions, separateOp } from '../../src/modules/contacts/contacts-import.js';
import { createContactsStore } from '../../src/modules/contacts/contacts-store.js';
import { defaultRoles } from '../../src/modules/index.js';
import { createPermissionSet } from '../../src/core/permissions/resolver.js';
import { upgradeRolePermissions } from '../../src/core/permissions/roles.js';
import { readFileSync } from 'node:fs';

const C = (id, name, phones = [], extra = {}) => ({ id, name, phones, categoryIds: [], favorite: false, rev: 1, deleted: false, organization: null, email: null, address: null, notes: null, ...extra });

test('B-model: validation keeps Arabic / English names exactly, bounds every field, refuses junk numbers', () => {
  const ok = validateContact({ name: '  د. أحمد   عبد الرحمن ', phones: [{ label: 'mobile', number: '+20 100 123 4567' }, { label: 'mobile', number: '' }, { label: 'home', number: '٠٢-٢٣٤٥٦٧٨٩' }], email: 'a@b.co' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value.name, 'د. أحمد عبد الرحمن', 'only whitespace normalised; letters untouched');
  assert.deepEqual(ok.value.phones, ['mobile|+20 100 123 4567', 'home|02-23456789'], 'empty rows dropped; Arabic-Indic digits → ASCII');
  const bad = validateContact({ name: '', email: 'nope', phones: [{ label: 'x|y', number: '123' }, { label: 'mobile', number: '<script>' }, { label: 'mobile', number: 'javascript:1' }] });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['email', 'name', 'phone0', 'phone1', 'phone2']);
  assert.equal(validateContact({ name: 'x'.repeat(121) }).errors.name, 'contacts.v.nameLong');
  assert.equal(validateContact({ name: 'n', notes: 'x'.repeat(1001) }).errors.notes, 'contacts.v.notesLong');
  assert.equal(validateContact({ name: 'n', phones: Array.from({ length: 11 }, (_, i) => ({ label: 'mobile', number: `0100000${i}00` })) }).errors.phones, 'contacts.v.tooManyPhones');
  const cats = [{ id: 's_doctors' }, { id: 'cust01' }];
  assert.deepEqual(validateContact({ name: 'n', categoryIds: ['s_doctors', 'gone99', 's_doctors', 'bad id!'] }, { categories: cats }).value.categoryIds, ['s_doctors'], 'unknown / duplicate / malformed ids dropped');
  assert.equal(validateContact({ name: 'n‮evil\u0000' }).value.name, 'nevil', 'bidi overrides / control chars removed');
  assert.deepEqual(validateContact(ok.value).value, ok.value, 're-validating a validated value is idempotent (phones kept)');
  assert.equal(validateContact({ name: '<img src=x onerror=alert(1)>' }).value.name, '<img src=x onerror=alert(1)>', 'kept as text (rendered with textContent)');
});

test('B-model: tel: URIs and WhatsApp targets — validated, never guessed', () => {
  assert.equal(telUri('+20 100 123 4567'), 'tel:+201001234567');
  assert.equal(telUri('(02) 2345-678'), 'tel:022345678');
  assert.equal(telUri('javascript:alert(1)'), null); assert.equal(telUri('12'), null);
  assert.deepEqual(whatsappTarget('+20 100 123 4567'), { digits: '201001234567', url: 'https://wa.me/201001234567' });
  assert.deepEqual(whatsappTarget('0100 123 4567'), { needCountry: true }, 'national number: ask for the country code');
  assert.deepEqual(whatsappTarget('0100 123 4567', '20'), { digits: '201001234567', url: 'https://wa.me/201001234567' });
  assert.deepEqual(whatsappTarget('0100 123 4567', '020'), { error: 'country' });
  assert.deepEqual(whatsappTarget('+1 23'), { error: 'length' });
  assert.equal(cleanNumber('0020 100'), '+20 100'); assert.equal(cleanNumber('tel:+1-555-0100;ext=2'), '+1-555-0100');
});

test('B-model: search (name, organization, category, digits in any format) and folding', () => {
  const c = C('c1', 'أحمد', ['mobile|+20 100 123 4567'], { organization: 'Clinic Méd' });
  assert.ok(searchMatch(c, 'احمد'), 'hamza variants'); assert.ok(searchMatch(c, 'clinic med'), 'accents');
  assert.ok(searchMatch(c, '01001234567'), 'national format finds international number'); assert.ok(searchMatch(c, '123 45'));
  assert.ok(searchMatch(C('c2', 'N', ['mobile|0100 123 4567']), '+20 100 123 4567'), 'international query finds a national number');
  assert.ok(searchMatch(c, 'doc', ['Doctors'])); assert.ok(!searchMatch(c, 'zzz'));
  assert.equal(fold('مُحَمَّد'), 'محمد'); assert.equal(matchKey('+20 100 123 4567'), matchKey('0100-123-4567'));
});

test('B-model: duplicates (phone first, name second, shared numbers ambiguous) and non-destructive merge', () => {
  const a = C('a1', 'Mona', ['mobile|+20 100 111 2222']); const b = C('b1', 'Omar', ['mobile|0100 111 2222']); const n = C('n1', 'Sara', []);
  const m = findMatches({ name: 'Mona', phones: [{ number: '01001112222' }] }, [a, b, n]);
  assert.deepEqual(m.map((x) => [x.contact.id, x.by]), [['a1', 'both'], ['b1', 'phone']]);
  assert.deepEqual(findMatches({ name: 'sara', phones: [] }, [a, n]).map((x) => x.by), ['name']);
  const ex = C('e1', 'Dr Ali', ['mobile|+20 100 555 6666'], { email: 'ali@x.com', organization: null, categoryIds: ['s_doctors'] });
  const r = mergeValue(ex, { name: 'Ali Hassan', phones: ['work|02 3333 4444', 'mobile|01005556666'], organization: 'Clinic', email: 'other@x.com', categoryIds: ['s_emergency'] });
  assert.deepEqual(r.value.phones, ['mobile|+20 100 555 6666', 'work|02 3333 4444'], 'new number added, same number not twice');
  assert.equal(r.value.organization, 'Clinic', 'empty field filled'); assert.equal(r.value.email, 'ali@x.com', 'never overwritten');
  assert.deepEqual(r.conflicts.sort(), ['email', 'name']); assert.deepEqual(r.value.categoryIds, ['s_doctors', 's_emergency']); assert.equal(r.changed, true);
});

test('B-vcard: 2.1 quoted-printable + charset, 3.0 escapes / folding / groups, 4.0 tel: URIs, multiple TEL, media skipped', () => {
  const v21 = 'BEGIN:VCARD\r\nVERSION:2.1\r\nN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D8=A3=D8=AD=D9=85=D8=AF;=\r\n=D9=85=D8=AD=D9=85=D8=AF\r\nTEL;CELL;VOICE:+20 100 123 4567\r\nTEL;HOME:02-2345678\r\nPHOTO;ENCODING=BASE64;TYPE=JPEG:/9j/4AAQ\r\n AAAA\r\nX-ANDROID-CUSTOM:x\r\nEND:VCARD\r\n';
  const v30 = 'BEGIN:VCARD\nVERSION:3.0\nFN:Dr. Smith\\, MD\\; Heart\nORG:Clinic;Cardio\nitem1.TEL;TYPE=WORK,VOICE:(02) 555-1234\nitem1.X-ABLabel:Desk\nEMAIL;TYPE=INTERNET:dr@example.com\nADR;TYPE=WORK:;;12 Nile St\\, Floor 3;Cairo;;11511;Egypt\nNOTE:Line 1\\nLine 2 — a long note that is folded across\n  two lines\nCATEGORIES:Doctors,طوارئ\nEND:VCARD\n';
  const v40 = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ünïcödé 😀\r\nTEL;VALUE=uri;TYPE="voice,cell":tel:+1-555-555-0100\r\nTEL;VALUE=uri:tel:+1-555-555-0100\r\nEND:VCARD\r\n';
  const r = parseVcf(v21 + v30 + v40).records;
  assert.equal(r.length, 3);
  assert.equal(r[0].value.name, 'محمد أحمد'); assert.deepEqual(r[0].value.phones, [{ label: 'mobile', number: '+20 100 123 4567' }, { label: 'home', number: '02-2345678' }]);
  assert.equal(r[0].mediaSkipped, 1); assert.ok(r[0].warnings.includes('mediaSkipped')); assert.ok(r[0].unsupported.includes('X-ANDROID-CUSTOM'));
  assert.equal(r[1].value.name, 'Dr. Smith, MD; Heart'); assert.equal(r[1].value.organization, 'Clinic – Cardio');
  assert.equal(r[1].value.address, '12 Nile St, Floor 3, Cairo, 11511, Egypt'); assert.equal(r[1].value.notes, 'Line 1\nLine 2 — a long note that is folded across two lines');
  assert.deepEqual(r[1].value.phones, [{ label: 'work', number: '(02) 555-1234' }]); assert.deepEqual(r[1].value.categoryNames, ['Doctors', 'طوارئ']);
  assert.equal(r[2].value.name, 'Ünïcödé 😀'); assert.deepEqual(r[2].value.phones, [{ label: 'mobile', number: '+1-555-555-0100' }], 'tel: URI + de-duplicated');
});

test('B-vcard: malformed / hostile input never crashes and is reported (no name, unterminated, junk, huge, not a vCard)', () => {
  const junk = 'BEGIN:VCARD\nVERSION:3.0\nTEL:<script>alert(1)</script>\nFN\nN:;;;;\nEND:VCARD\nBEGIN:VCARD\nFN:Open record\nTEL:123456';
  const r = parseVcf(junk).records;
  assert.deepEqual([r[0].ok, r[0].errors, r[0].warnings.sort()], [false, ['noName'], ['badLine', 'badPhone']]);
  assert.deepEqual([r[1].ok, r[1].errors], [false, ['unterminated']]);
  assert.deepEqual(parseVcf('hello world').fileErrors, ['notVcf']);
  assert.deepEqual(parseVcf(`BEGIN:VCARD\nFN:${'x'.repeat(VCF_LIMITS.bytes)}\nEND:VCARD`).fileErrors, ['tooLarge']);
  const many = Array.from({ length: VCF_LIMITS.records + 3 }, (_, i) => `BEGIN:VCARD\nFN:P${i}\nEND:VCARD`).join('\n');
  const m = parseVcf(many); assert.equal(m.records.length, VCF_LIMITS.records); assert.deepEqual(m.fileErrors, ['tooMany']);
  const long = parseVcf(`BEGIN:VCARD\nFN:${'n'.repeat(130)}\nNOTE:${'x'.repeat(1500)}\nEND:VCARD`).records[0];
  assert.deepEqual([long.ok, long.errors, long.value.notes.length], [false, ['nameTooLong'], 1000]);
  const nested = parseVcf('BEGIN:VCARD\nFN:Outer\nAGENT:\nBEGIN:VCARD\nFN:Inner\nEND:VCARD\nEND:VCARD').records;
  assert.deepEqual(nested.map((x) => x.value.name), ['Outer']);
  // Windows-1256 (Arabic legacy charset) file: decoded via the declared CHARSET, not mangled
  const bytes = Uint8Array.from([...Buffer.from('BEGIN:VCARD\r\nVERSION:2.1\r\nFN;CHARSET=windows-1256:'), 0xe3, 0xe4, 0xc7, ...Buffer.from('\r\nEND:VCARD\r\n')]);
  assert.equal(parseVcf(bytes).records[0].value.name, 'منا');
  assert.equal(decodeFile(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41])), 'A', 'UTF-8 BOM stripped');
});

test('B-vcard: export = vCard 3.0, UTF-8, CRLF, escaped, folded ≤ 75 octets; round-trips through the importer', () => {
  const c = C('x1', 'أحمد, محمد; "Q"\\', ['mobile|+20 100 123 4567', 'Clinic desk|(02) 555', 'whatsapp|+20 111'], { organization: 'A;B', email: 'a@b.co', address: '12 Nile St\nCairo', notes: 'line1\nline2 ' + 'و'.repeat(80), categoryIds: ['s_doctors', 'gone'] });
  const out = exportVcf([c], { categoryName: (id) => (id === 's_doctors' ? 'Doctors' : null) });
  assert.ok(out.endsWith('\r\n') && !/[^\r]\n/.test(out), 'CRLF only');
  for (const line of out.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `≤ 75 octets: ${line}`);
  assert.match(out, /FN:أحمد\\, محمد\\; "Q"\\\\\r\n/); assert.match(out, /ORG:A\\;B/); assert.match(out, /CATEGORIES:Doctors\r\n/);
  assert.match(out, /X-HOMEHUB-LABEL:Clinic desk/);
  const back = parseVcf(out).records[0];
  assert.equal(back.value.name, c.name); assert.equal(back.value.organization, 'A;B'); assert.equal(back.value.email, 'a@b.co');
  assert.equal(back.value.notes, c.notes); assert.equal(back.value.address, '12 Nile St\nCairo');
  assert.deepEqual(back.value.phones.map((p) => [p.label, p.number]), [['mobile', '+20 100 123 4567'], ['Clinic desk', '(02) 555'], ['mobile', '+20 111']]);
  assert.deepEqual(back.value.categoryNames, ['Doctors']);
  assert.equal(foldLine('ا'.repeat(50)).split('\r\n').every((l) => Buffer.byteLength(l) <= 75), true, 'never splits a UTF-8 character');
  assert.equal(vcfFileName('../evil:name'), '..-evil-name.vcf'); assert.equal(exportVcf([]), '');
});

test('B-import: preview classifies new / duplicate / possible / ambiguous / in-file / invalid; skip is the default; deterministic ids', () => {
  const existing = [C('a1', 'Mona', ['mobile|+20 100 111 2222'], { rev: 3 }), C('b1', 'Omar', ['mobile|0100 222 3333']), C('b2', 'Omar Two', ['home|+20 100 222 3333']), C('s1', 'Sara', [])];
  const cats = [{ id: 's_doctors', key: 'doctors', name: null }];
  const vcf = ['FN:New Person\nTEL:0122 000 1111\nCATEGORIES:أطباء,Unknown', 'FN:Mona\nTEL:01001112222', 'FN:sara', 'FN:Omar?\nTEL:01002223333', 'FN:New Person\nTEL:+20 122 000 1111', 'TEL:0100'].map((x) => `BEGIN:VCARD\nVERSION:3.0\n${x}\nEND:VCARD`).join('\n');
  const p = buildPreview(parseVcf(vcf), { contacts: existing, categories: cats, labelsOf: categoryLabels });
  assert.deepEqual(p.items.map((i) => [i.status, i.action]), [['new', 'create'], ['duplicate', 'skip'], ['possible', 'skip'], ['ambiguous', 'skip'], ['inFile', 'skip'], ['invalid', 'skip']]);
  assert.deepEqual(p.items[0].categoryIds, ['s_doctors'], 'Arabic suggested label mapped'); assert.deepEqual(p.items[0].unknownCategories, ['Unknown']);
  assert.equal(p.items[4].inFileOf, 0); assert.deepEqual(allowedActions(p.items[4]), ['skip', 'separate']); assert.deepEqual(allowedActions(p.items[5]), ['skip']);
  assert.deepEqual(p.counts, { new: 1, imported: 0, duplicate: 1, possible: 1, ambiguous: 1, inFile: 1, invalid: 1, selected: 1 });
  p.items[1].action = 'merge'; p.items[2].action = 'separate';
  const ops = planImport(p.items, { contacts: existing });
  assert.deepEqual(ops.map((o) => o.kind), ['create', 'merge', 'create']);
  assert.equal(ops[1].baseRev, 3, 'merge remembers the previewed revision');
  assert.deepEqual(planImport(p.items, { contacts: existing }).map((o) => o.id), ops.map((o) => o.id), 'same file → same ids (retry / second device)');
  assert.notEqual(ops[2].id, importId(p.items[2].value, 0), 'keep separate → its own copy id');
  assert.ok(ops.filter((o) => o.id).every((o) => /^vc_[0-9a-f]{16}$/.test(o.id)));
  const extra = planImport(p.items, { contacts: existing, extraCategoryIds: ['s_doctors'] });
  assert.deepEqual(extra[0].value.categoryIds, ['s_doctors']);
});

// ------------------------------------------------------------------ store (fake repo mirroring the rules' revision / create-only checks)
function server() {
  const db = new Map(); const devices = []; let deny = () => false; const writes = [];
  const list = (p) => [...db.entries()].filter(([k]) => k.startsWith(p)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  const fire = () => { for (const d of devices) if (!d.frozen) for (const w of d.ws) w(); };
  const srv = { db, writes, setDeny(f) { deny = f; }, fire,
    loseResponse: () => false,
    device({ canDelete = true } = {}) {
      const dev = { ws: new Set(), frozen: false }; devices.push(dev); let n = 0;
      const repo = { now: () => 'NOW', newId: () => `gen${devices.length}x${++n}abc`,
        watchContacts: (h, on) => { const w = () => on(list('contacts/').filter((c) => c.deleted === false)); dev.ws.add(w); queueMicrotask(w); return () => dev.ws.delete(w); },
        watchCategories: (h, on) => { const w = () => on(list('contactCategories/')); dev.ws.add(w); queueMicrotask(w); return () => dev.ws.delete(w); },
        readDeleted: async () => { if (!canDelete) throw Object.assign(new Error('d'), { code: 'permission-denied' }); return list('contacts/').filter((c) => c.deleted === true).slice(0, 201); },
        // mirrors rules rev 2: a soft-deleted contact is unreadable without contacts.delete; a missing id reads as null
        read: async (h, id) => { const d = db.get(`contacts/${id}`); if (d && d.deleted === true && !canDelete) throw Object.assign(new Error('d'), { code: 'permission-denied' }); return d ? { id, ...d } : null; },
        exists: async (h, name, id) => db.has(`${name}/${id}`),
        async commit(h, ops) {
          await new Promise((r) => setTimeout(r, 1));
          for (const o of ops) {
            const k = `${o.name}/${o.id}`; const cur = db.get(k);
            if (deny(o)) throw Object.assign(new Error('x'), { code: 'unavailable' });
            if (o.mode === 'set' && cur) throw Object.assign(new Error('exists'), { code: 'permission-denied' });
            if (o.mode === 'update' && o.name === 'contacts' && (!cur || o.data.rev !== cur.rev + 1)) throw Object.assign(new Error('rev'), { code: 'permission-denied' });
          }
          for (const o of ops) { const k = `${o.name}/${o.id}`; writes.push(`${o.mode}:${k}`); if (o.mode === 'delete') db.delete(k); else db.set(k, o.mode === 'set' ? { ...o.data } : { ...db.get(k), ...o.data }); }
          fire();
          if (ops.some((o) => srv.loseResponse(o))) throw Object.assign(new Error('lost'), { code: 'unavailable' });   // committed, response lost
        } };
      return { dev, repo };
    } };
  return srv;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function client(srv, uid = 'u1', opts) { const { dev, repo } = srv.device(opts); const s = createContactsStore({ homeId: 'H', uid, repo, canView: true }); s.subscribe(() => {}); await tick(); return { s, dev }; }

test('B-store: create / edit (field-level, revisioned) / favourite / soft delete + restore; stale editor refused', async () => {
  const srv = server(); const { s } = await client(srv);
  const id = await s.createContact({ name: 'Dr Ali', phones: [{ label: 'mobile', number: '0100 555 6666' }] }); await tick();
  const doc = srv.db.get(`contacts/${id}`);
  assert.deepEqual([doc.rev, doc.source, doc.deleted, doc.createdBy, doc.schemaVersion], [1, 'manual', false, 'u1', 1]);
  assert.equal(await s.updateContact(id, { name: 'Dr Ali', phones: [{ label: 'mobile', number: '0100 555 6666' }] }, { baseRev: 1 }), false, 'no change → no write');
  await s.updateContact(id, { name: 'Dr Ali', organization: 'Clinic', phones: [{ label: 'mobile', number: '0100 555 6666' }] }, { baseRev: 1 }); await tick();
  assert.deepEqual([srv.db.get(`contacts/${id}`).rev, srv.db.get(`contacts/${id}`).organization], [2, 'Clinic']);
  await assert.rejects(s.updateContact(id, { name: 'Old form' }, { baseRev: 1 }), (e) => e.detail === 'contacts.err.stale', 'editor opened before a change');
  await s.setFavorite(id, true); await tick(); assert.equal(srv.db.get(`contacts/${id}`).favorite, true);
  await s.deleteContact(id); await tick();
  assert.equal(s.getSnapshot().contacts.length, 0); assert.ok(srv.db.has(`contacts/${id}`), 'soft delete keeps the record');
  const del = await s.loadDeleted(); assert.equal(del.more, false); await s.restoreContact(del.items[0]); await tick();
  assert.deepEqual([s.getSnapshot().contacts.length, srv.db.get(`contacts/${id}`).deletedAt], [1, null]);
  assert.ok(!srv.writes.some((w) => w.startsWith('delete:contacts/')), 'contacts are never hard-deleted');
});

test('B-store: two devices — a stale write is refused (revision), not silently overwritten', async () => {
  const srv = server(); const A = await client(srv, 'u1'); const B = await client(srv, 'u2');
  const id = await A.s.createContact({ name: 'Shared' }); await tick();
  B.dev.frozen = true;                                                 // B still sees rev 1
  await A.s.setFavorite(id, true); await tick();
  await assert.rejects(B.s.updateContact(id, { name: 'B edit' }), (e) => e.detail === 'contacts.err.stale');
  assert.equal(srv.db.get(`contacts/${id}`).name, 'Shared');
});

test('B-store: categories — suggested set is idempotent with stable ids; removing a category never touches contacts', async () => {
  const srv = server(); const { s } = await client(srv);
  assert.equal(await s.addSuggestedCategories(), SUGGESTED_CATEGORIES.length); await tick();
  assert.equal(await s.addSuggestedCategories(), 0, 'second run adds nothing'); await tick();
  assert.ok(SUGGESTED_CATEGORIES.every((k) => srv.db.has(`contactCategories/${suggestedId(k)}`)));
  const id = await s.createContact({ name: 'Doc', categoryIds: ['s_doctors', 's_emergency'] }); await tick();
  await s.deleteCategory('s_doctors'); await tick();
  const c = srv.db.get(`contacts/${id}`);
  assert.deepEqual(c.categoryIds, ['s_doctors', 's_emergency'], 'contact untouched');
  assert.deepEqual(liveCategoryIds({ ...c, id }, s.getSnapshot().categories), ['s_emergency'], 'no dangling category shown');
  await s.updateContact(id, { name: 'Doc', categoryIds: c.categoryIds }); await tick();
  assert.deepEqual(srv.db.get(`contacts/${id}`).categoryIds, ['s_emergency'], 'dropped on the next save');
  await assert.rejects(s.createCategory({ name: ' ' }), (e) => e.detail === 'contacts.v.catName');
});

test('B-store: import — confirmed writes only, partial failure + retry without duplicates, two devices importing the same file, stale merge re-confirmed', async () => {
  const srv = server(); const A = await client(srv, 'u1'); const B = await client(srv, 'u2');
  const target = await A.s.createContact({ name: 'Mona', phones: [{ label: 'mobile', number: '+20 100 111 2222' }] }); await tick();
  const vcf = ['FN:P One\nTEL:0122 000 0001', 'FN:P Two\nTEL:0122 000 0002', 'FN:Mona\nTEL:01001112222\nORG:Bakery'].map((x) => `BEGIN:VCARD\nVERSION:3.0\n${x}\nEND:VCARD`).join('\n');
  const prev = (s) => buildPreview(parseVcf(vcf), { contacts: s.getSnapshot().contacts, categories: [] });
  const pA = prev(A.s); pA.items[2].action = 'merge';
  assert.equal(srv.writes.filter((w) => w.startsWith('set:contacts/vc_')).length, 0, 'preview writes nothing');
  const ops = planImport(pA.items, { contacts: A.s.getSnapshot().contacts });
  srv.setDeny((o) => o.id === ops[1].id);
  const r1 = await A.s.importContacts(ops);
  assert.deepEqual([r1.created, r1.merged, r1.failed.length], [1, 1, 1]);
  assert.equal(srv.db.get(`contacts/${target}`).organization, 'Bakery'); assert.equal(srv.db.get(`contacts/${ops[0].id}`).source, 'vcf');
  assert.deepEqual(srv.db.get(`contacts/${target}`).phones, ['mobile|+20 100 111 2222'], 'a merge never drops the existing numbers');
  assert.deepEqual(srv.db.get(`contacts/${ops[0].id}`).phones, ['other|0122 000 0001'], 'imported numbers are saved (untyped TEL → other)');
  srv.setDeny(() => false); await tick();
  const r2 = await A.s.importContacts(ops);   // retry ALL: the saved ones are recognised, the merge is no longer current
  assert.deepEqual([r2.created, r2.already, r2.stale.length, r2.merged], [1, 2, 0, 0], 'no duplicate; the applied merge (baseRev + 1, same content) is recognised, not re-applied');
  // device B previewed the same file BEFORE A's import landed (it only saw Mona) and imports now:
  // same deterministic ids → nothing duplicated
  const pB = buildPreview(parseVcf(vcf), { contacts: [srv.db.get(`contacts/${target}`)].map((c) => ({ ...c, id: target })), categories: [] });
  const opsB = planImport(pB.items, { contacts: [{ id: target }] });
  const r3 = await B.s.importContacts(opsB);
  assert.deepEqual([r3.created, r3.already], [0, 2]);
  assert.equal([...srv.db.keys()].filter((k) => k.startsWith('contacts/')).length, 3, 'Mona + P One + P Two, no copies');
  await assert.rejects(Promise.all([A.s.importContacts(opsB), A.s.importContacts(opsB)]), (e) => e.detail === 'contacts.import.busy');
});

test('B-permissions: role template v9 matrix (least privilege; export ≠ view); additive upgrade keeps custom grants', () => {
  const p = Object.fromEntries(defaultRoles().map((r) => [r.id, createPermissionSet(r.permissions)]));
  const A = ['view', 'create', 'edit', 'delete', 'import', 'export', 'manageCategories'];
  const m = (r) => A.filter((a) => p[r].can(`contacts.${a}`));
  assert.deepEqual(m('owner'), A); assert.deepEqual(m('admin'), A);
  assert.deepEqual(m('member'), ['view', 'create', 'edit', 'import', 'export']);
  assert.deepEqual(m('viewer'), ['view']); assert.deepEqual(m('child'), ['view']);
  const memberV8 = ['contacts.view', 'contacts.create', 'contacts.edit', 'chef.view', 'custom.grant'];
  const up = upgradeRolePermissions({ current: memberV8, template: defaultRoles().find((r) => r.id === 'member').permissions, from: 8 });
  assert.ok(up.includes('contacts.import') && up.includes('contacts.export') && up.includes('custom.grant') && !up.includes('contacts.delete'));
  const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
  for (const a of ['view', 'create', 'edit', 'delete', 'import', 'manageCategories']) assert.match(rules, new RegExp(`can\\(h, 'contacts', '${a}'\\)`), `rules enforce contacts.${a}`);
  assert.ok(CONTACT_LIMITS.maxContacts <= 1000);
});

test('B-misc: createDoc / editPatch / phonesOf shapes match the rules key lists', () => {
  const v = validateContact({ name: 'X', phones: [{ label: 'mobile', number: '0100' }] }).value;
  const d = createDoc(v, { uid: 'u', now: 'N', source: 'vcf' });
  const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
  const keys = rules.match(/match \/contacts\/\{contactId\}[\s\S]*?exactKeys\(\[([\s\S]*?)\]\)/)[1].match(/'(\w+)'/g).map((x) => x.slice(1, -1)).sort();
  assert.deepEqual(Object.keys(d).sort(), keys);
  assert.deepEqual(Object.keys(editPatch({ ...d, id: 'i' }, { ...v, name: 'Y' }, { uid: 'u', now: 'N' })).sort(), ['name', 'rev', 'updatedAt', 'updatedBy']);
  assert.deepEqual(phonesOf({ phones: ['a|1', 'noPipe'] }), [{ label: 'a', number: '1' }, { label: 'other', number: 'noPipe' }]);
});

// ------------------------------------------------------------------ rev 2 (B2 / B3)
const card = (x) => `BEGIN:VCARD\nVERSION:3.0\n${x}\nEND:VCARD`;
const FILE = ['FN:Ali Driver\nTEL;CELL:0122 111 0001', 'FN:Huda Nurse\nTEL;CELL:0122 111 0002'].map(card).join('\n');
const plan = (s, file = FILE, mutate = () => {}) => { const p = buildPreview(parseVcf(file), { contacts: s.getSnapshot().contacts, categories: [] }); mutate(p.items); return planImport(p.items, { contacts: s.getSnapshot().contacts }); };
const vcIds = (srv) => [...srv.db.keys()].filter((k) => k.startsWith('contacts/vc_'));

test('B2 rev2: re-import after SOFT DELETION — never restored, never copied; reported as deleted (admin) / hidden (member)', async () => {
  const srv = server(); const admin = await client(srv, 'admin'); const member = await client(srv, 'member', { canDelete: false });
  await admin.s.importContacts(plan(admin.s)); await tick();
  const [aliId] = vcIds(srv).map((k) => k.slice(9)).filter((id) => srv.db.get(`contacts/${id}`).name === 'Ali Driver');
  await admin.s.deleteContact(aliId); await tick();
  const before = JSON.stringify([...srv.db]);
  const opsM = plan(member.s);                                             // the preview cannot see the deleted contact: "new"
  assert.deepEqual(opsM.map((o) => [o.kind, o.copy]), [['create', 0]], 'Huda is recognised as imported before; Ali looks new');
  const rM = await member.s.importContacts(opsM);
  assert.deepEqual([rM.created, rM.hidden.map((o) => o.name), rM.failed.length], [0, ['Ali Driver'], 0], 'member: exists but hidden');
  const rA = await admin.s.importContacts(plan(admin.s));
  assert.deepEqual([rA.created, rA.deleted.map((o) => o.name)], [0, ['Ali Driver']], 'admin: deleted, not restored');
  assert.equal(JSON.stringify([...srv.db]), before, 'nothing written: no restore, no copy, no overwrite');
  assert.equal(srv.db.get(`contacts/${aliId}`).deleted, true);
  // the user explicitly chooses "add as separate" → a NEW contact (copy 1); the deleted one stays deleted
  const r = await member.s.importContacts(rM.hidden.map((o) => separateOp(o, new Set())));
  assert.equal(r.created, 1); assert.equal(vcIds(srv).length, 3); assert.equal(srv.db.get(`contacts/${aliId}`).deleted, true);
});

test('B2 rev2: re-import after EDITING — preview marks it "imported before" (skip); a stale snapshot that misses it still never overwrites or copies', async () => {
  const srv = server(); const { s } = await client(srv);
  await s.importContacts(plan(s)); await tick();
  const ali = s.getSnapshot().contacts.find((c) => c.name === 'Ali Driver');
  await s.updateContact(ali.id, { name: 'Ali (school bus)', phones: [{ label: 'mobile', number: '0100 999 0000' }] }); await tick();
  const p = buildPreview(parseVcf(FILE), { contacts: s.getSnapshot().contacts, categories: [] });
  assert.deepEqual(p.items.map((i) => [i.status, i.action, i.edited]), [['imported', 'skip', true], ['imported', 'skip', false]]);
  assert.deepEqual(allowedActions(p.items[0]), ['skip', 'merge', 'separate'], 'no plain "create" for an imported record');
  assert.equal(p.items[0].matches[0].by, 'import');
  assert.deepEqual(planImport(p.items, { contacts: s.getSnapshot().contacts }), [], 'default: nothing to write');
  // stale / incomplete snapshot (the preview saw NOTHING): creates hit the occupied ids and are verified
  const stalePlan = planImport(buildPreview(parseVcf(FILE), { contacts: [], categories: [] }).items, { contacts: [] });
  assert.ok(stalePlan.every((o) => o.copy === 0), 'an occupied id is never turned into a copy by the planner');
  const r = await s.importContacts(stalePlan);
  assert.deepEqual([r.created, r.already, r.kept.map((o) => o.name)], [0, 1, ['Ali Driver']], 'edited one kept as is; untouched one = already');
  assert.equal(srv.db.get(`contacts/${ali.id}`).name, 'Ali (school bus)'); assert.equal(vcIds(srv).length, 2);
});

test('B2 rev2: retry after a COMMITTED write whose response was lost — recognised as already imported (creates, separate copies, merges)', async () => {
  const srv = server(); const { s } = await client(srv);
  const mona = await s.createContact({ name: 'Mona', phones: [{ label: 'mobile', number: '+20 100 111 2222' }] }); await tick();
  const file = [FILE, card('FN:Mona\nTEL:01001112222\nORG:Bakery'), card('FN:Ali Driver\nTEL;CELL:0122 111 0001')].join('\n');
  const ops = plan(s, file, (items) => { items[2].action = 'merge'; items[3].action = 'separate'; });
  assert.deepEqual(ops.map((o) => [o.kind, o.copy ?? null]), [['create', 0], ['create', 0], ['merge', null], ['create', 1]]);
  srv.loseResponse = () => true;
  const r1 = await s.importContacts(ops);
  assert.deepEqual([r1.failed.length, r1.already], [3, 1], 'lost create responses → failed (unknown outcome); the merge is read back and recognised');
  srv.loseResponse = () => false; await tick();
  const r2 = await s.importContacts(ops);   // retry the WHOLE plan
  assert.deepEqual([r2.created, r2.merged, r2.already, r2.stale.length, r2.kept.length], [0, 0, 4, 0, 0], 'all four verified as this import');
  assert.equal(vcIds(srv).length, 3, 'two records + ONE intentional copy — no copy 2');
  assert.equal(srv.db.get(`contacts/${mona}`).rev, 2, 'merge applied once');
});

test('B2 rev2: concurrent imports of the same file from two devices — each record exists once', async () => {
  const srv = server(); const A = await client(srv, 'a'); const B = await client(srv, 'b');
  const [ra, rb] = await Promise.all([A.s.importContacts(plan(A.s)), B.s.importContacts(plan(B.s))]);
  assert.equal(ra.created + rb.created, 2); assert.equal(ra.already + rb.already, 2);
  assert.equal(ra.kept.length + rb.kept.length + ra.failed.length + rb.failed.length, 0);
  assert.equal(vcIds(srv).length, 2);
  // different category choices on the two devices → same id, different content: the second is KEPT (not overwritten)
  const srv2 = server(); const C1 = await client(srv2, 'a'); const C2 = await client(srv2, 'b');
  const p1 = planImport(buildPreview(parseVcf(FILE), { contacts: [] }).items, { contacts: [] });
  const p2 = p1.map((o) => ({ ...o, value: { ...o.value, notes: 'from device 2' } }));
  await C1.s.importContacts(p1); const r = await C2.s.importContacts(p2);
  assert.deepEqual([r.created, r.kept.length], [0, 2]); assert.ok([...srv2.db.values()].every((d) => d.notes === null));
});

test('B2 rev2: explicit intentional duplicates — keep separate makes copies 1, 2 … (also for in-file twins), each retry-safe', async () => {
  const srv = server(); const { s } = await client(srv);
  await s.importContacts(plan(s)); await tick();
  const twice = [FILE.split('\n').slice(0, 5).join('\n'), card('FN:Ali Driver\nTEL;CELL:0122 111 0001')].join('\n');   // Ali + an in-file twin
  const ops = plan(s, twice, (items) => { items[0].action = 'separate'; items[1].action = 'separate'; });
  assert.deepEqual(ops.map((o) => o.copy), [1, 2], 'two explicit copies get two ids');
  assert.equal((await s.importContacts(ops)).created, 2); await tick();
  assert.equal(vcIds(srv).length, 4);
  // an explicit copy whose planned id is occupied by something else moves on (only because the user asked)
  const srv2 = server(); const { s: s2 } = await client(srv2);
  const value = validateContact({ name: 'Zed', phones: [{ label: 'mobile', number: '0100 000 0009' }] }).value;
  srv2.db.set(`contacts/${importId(value, 1)}`, { ...createDoc({ ...value, notes: 'other' }, { uid: 'x', now: 'N', source: 'vcf' }) });
  const r = await s2.importContacts([separateOp({ index: 0, value }, new Set())]);
  assert.equal(r.created, 1); assert.ok(srv2.db.has(`contacts/${importId(value, 2)}`));
  assert.equal(srv2.db.get(`contacts/${importId(value, 1)}`).notes, 'other', 'occupant untouched');
});

test('B3 rev2: capacity — exactly at the limit vs truncated (> limit): flags, creates refused, imports refused when incomplete, deleted list "more"', async () => {
  const fill = (srv, n, deleted = false) => { for (let i = 0; i < n; i++) srv.db.set(`contacts/${deleted ? 'd' : 'c'}${String(i).padStart(5, '0')}`, createDoc({ ...validateContact({ name: `P${i}` }).value }, { uid: 'u', now: 'N' })); if (deleted) for (let i = 0; i < n; i++) srv.db.get(`contacts/d${String(i).padStart(5, '0')}`).deleted = true; };
  const atCap = server(); fill(atCap, CONTACT_LIMITS.maxContacts); const A = await client(atCap);
  assert.deepEqual([A.s.getSnapshot().atLimit, A.s.getSnapshot().truncated, A.s.getSnapshot().contacts.length], [true, false, 1000]);
  await assert.rejects(A.s.createContact({ name: 'One more' }), (e) => e.detail === 'contacts.err.atLimit');
  const r = await A.s.importContacts(plan(A.s));
  assert.deepEqual([r.created, r.failed.map((o) => o.detail)], [0, ['contacts.err.atLimit', 'contacts.err.atLimit']], 'no silent drop: reported');
  const over = server(); fill(over, CONTACT_LIMITS.maxContacts + 1); const B = await client(over);
  assert.deepEqual([B.s.getSnapshot().truncated, B.s.getSnapshot().contacts.length], [true, 1000], 'never more than the capacity in memory');
  await assert.rejects(B.s.importContacts(plan(B.s)), (e) => e.detail === 'contacts.import.truncated');
  const del = server(); fill(del, CONTACT_LIMITS.deletedList + 1, true); const D = await client(del);
  const d = await D.s.loadDeleted(); assert.deepEqual([d.items.length, d.more], [CONTACT_LIMITS.deletedList, true]);
  const repoSrc = readFileSync(new URL('../../src/modules/contacts/contacts-repository.js', import.meta.url), 'utf8');
  assert.match(repoSrc, /CONTACT_LIMITS\.maxContacts \+ 1/); assert.match(repoSrc, /CONTACT_LIMITS\.deletedList \+ 1/);
});
