/**
 * Shared Contacts (V6.4 Batch B) — PURE model: limits, validation, phone handling, search, duplicate
 * detection, merge planning and category helpers. No Firebase, no DOM.
 *
 * Stored shape (homes/{h}/contacts/{id}, see FIRESTORE-SCHEMA.md):
 *   name (1–120, stored exactly as typed — Arabic / English never rewritten), organization|null,
 *   email|null, address|null, notes|null, favorite (shared), phones: ["<label>|<number>"] (≤ 10),
 *   categoryIds: [id] (≤ 10), source 'manual'|'vcf', deleted / deletedAt / deletedBy (soft delete),
 *   rev, createdBy / createdAt / updatedBy / updatedAt, schemaVersion 1.
 * Normalisation (digits, folded names) is computed for SEARCH and DUPLICATES only and never stored.
 * V6.4 C: optional avatarUrl / menus (contact-media.js) — compared and written only when an input carries them.
 */
import { validateMedia, sameMedia } from './contact-media.js';
export const CONTACT_LIMITS = Object.freeze({
  name: 120, organization: 120, email: 254, address: 300, notes: 1000,
  phones: 10, phoneNumber: 40, phoneLabel: 30, categories: 10, categoryName: 40,
  maxContacts: 1000,    // bounded listener (documented growth limit; the page shows a notice at the limit)
  maxCategories: 50, deletedList: 200,
});
export const PHONE_LABELS = Object.freeze(['mobile', 'home', 'work', 'whatsapp', 'fax', 'other']);
export const SUGGESTED_CATEGORIES = Object.freeze(['doctors', 'restaurants', 'pharmacies', 'maintenance', 'emergency', 'family', 'friends', 'schools', 'delivery', 'other']);
export const suggestedId = (key) => `s_${key}`;
/** Suggested-category labels in BOTH languages — used only to recognise vCard CATEGORIES names on import. */
export const SUGGESTED_LABELS = Object.freeze({
  doctors: ['Doctors', 'أطباء'], restaurants: ['Restaurants', 'مطاعم'], pharmacies: ['Pharmacies', 'صيدليات'], maintenance: ['Maintenance', 'صيانة'],
  emergency: ['Emergency', 'طوارئ'], family: ['Family', 'العائلة'], friends: ['Friends', 'أصدقاء'], schools: ['Schools', 'مدارس'], delivery: ['Delivery', 'توصيل'], other: ['Other', 'أخرى'],
});
export const categoryLabels = (cat) => [cat.name, ...(cat.key ? SUGGESTED_LABELS[cat.key] || [] : [])].filter(Boolean);
export const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
export const CAT_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;

const fail = (detail, fields) => Object.assign(new Error(detail), { code: 'validation', detail, fields });

// ------------------------------------------------------------------ text helpers
/** Arabic-Indic / Extended Arabic-Indic digits → ASCII (phone numbers only). */
export function asciiDigits(s) {
  return String(s ?? '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}
/** Remove control / bidi-format characters (never meaningful in stored text; prevents spoofing). */
export const clean = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '');
const oneLine = (s) => clean(s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const multiLine = (s) => clean(s).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

/** Folded form for SEARCH / DUPLICATES only (case, diacritics, Arabic letter variants). Never stored. */
export function fold(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')            // tashkeel, superscript alef, tatweel
    .replace(/[آأإٱ]/g, 'ا')        // آ أ إ ٱ → ا
    .replace(/ى/g, 'ي').replace(/ة/g, 'ه')   // ى → ي, ة → ه
    .normalize('NFD').replace(/[̀-ͯ]/g, '')         // Latin accents
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ------------------------------------------------------------------ phones
const NUMBER_RE = /^[+]?[0-9(][0-9 ()./#*-]{0,39}$/;   // same pattern as firestore.rules (contactPhoneOk)
const LABEL_RE = /^[^|\u0000-\u001f\u007f]{1,30}$/;   // same as firestore.rules (contactPhoneOk)
/** User / file input → stored number text (digits made ASCII, separators kept, junk refused later). */
export function cleanNumber(raw) {
  let s = oneLine(asciiDigits(raw)).replace(/[‐-―−]/g, '-').replace(/[  -​]/g, ' ');
  if (/^tel:/i.test(s)) s = s.slice(4).split(/[;?]/)[0];       // vCard 4.0 tel: URIs
  s = s.replace(/^00(?=\d)/, '+');
  return s.trim();
}
export const validNumber = (n) => typeof n === 'string' && n.length <= CONTACT_LIMITS.phoneNumber && NUMBER_RE.test(n) && digitsOf(n).length >= 3;
export const digitsOf = (n) => String(n || '').replace(/\D/g, '');
export const isInternational = (n) => /^\+/.test(String(n || '').trim());
/** Comparable key: the last 9 national digits (trunk 0 / country code differences ignored). */
export function matchKey(n) {
  let d = digitsOf(n); if (!d) return '';
  if (!isInternational(n)) d = d.replace(/^0+/, '');
  return d.length > 9 ? d.slice(-9) : d;
}
export const encodePhone = ({ label, number }) => `${label}|${number}`;
export function decodePhone(s) {
  const i = String(s).indexOf('|');
  return i < 0 ? { label: 'other', number: String(s) } : { label: s.slice(0, i), number: s.slice(i + 1) };
}
export const phonesOf = (c) => (Array.isArray(c && c.phones) ? c.phones.map(decodePhone) : []);
/** Validated tel: URI for a stored number, or null. The user's click opens the dialer — never auto-called. */
export function telUri(number) {
  if (!validNumber(number)) return null;
  const d = digitsOf(number); return d.length >= 3 && d.length <= 20 ? `tel:${isInternational(number) ? '+' : ''}${d}` : null;
}
/**
 * WhatsApp target digits (international, no '+'), or { needCountry: true } when the number is national
 * and no calling code was given — the UI then ASKS for the code instead of guessing.
 */
export function whatsappTarget(number, countryCode = null) {
  if (!validNumber(number)) return { error: 'invalid' };
  let d = digitsOf(number);
  if (!isInternational(number)) {
    const cc = digitsOf(countryCode);
    if (!cc) return { needCountry: true };
    if (cc.length > 3 || cc[0] === '0') return { error: 'country' };
    d = cc + d.replace(/^0+/, '');
  }
  if (d.length < 8 || d.length > 15) return { error: 'length' };
  return { digits: d, url: `https://wa.me/${d}` };
}

// ------------------------------------------------------------------ categories
export function categoryLabel(cat, t) {
  if (!cat) return '';
  if (cat.name) return cat.name;
  return cat.key ? t(`contacts.cat.${cat.key}`) : cat.id;
}
/** Visible category ids of a contact: unknown (deleted / concurrent removal) ids are never shown. */
export const liveCategoryIds = (contact, categories) => {
  const known = new Set(categories.map((c) => c.id));
  return (contact.categoryIds || []).filter((id) => known.has(id));
};
export function validateCategory({ name }) {
  const n = oneLine(name);
  if (!n) return { errors: { name: 'contacts.v.catName' } };
  if (n.length > CONTACT_LIMITS.categoryName) return { errors: { name: 'contacts.v.catNameLong' } };
  return { value: { name: n }, errors: {} };
}

// ------------------------------------------------------------------ validation
const optional = (v, max, field, errors, multi = false) => {
  const s = (multi ? multiLine : oneLine)(v);
  if (!s) return null;
  if (s.length > max) errors[field] = `contacts.v.${field}Long`;
  return s;
};
const EMAIL_RE = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

/**
 * input: { name, organization, email, address, notes, favorite, phones: [{label, number}], categoryIds }
 * opts.categories: known categories (unknown ids are dropped — no dangling references are written).
 */
export function validateContact(input, { categories = null } = {}) {
  const errors = {};
  const name = oneLine(input.name);
  if (!name) errors.name = 'contacts.v.name';
  else if (name.length > CONTACT_LIMITS.name) errors.name = 'contacts.v.nameLong';
  const organization = optional(input.organization, CONTACT_LIMITS.organization, 'organization', errors);
  const email = optional(input.email, CONTACT_LIMITS.email, 'email', errors);
  if (email && !errors.email && !EMAIL_RE.test(email)) errors.email = 'contacts.v.email';
  const address = optional(input.address, CONTACT_LIMITS.address, 'address', errors, true);
  const notes = optional(input.notes, CONTACT_LIMITS.notes, 'notes', errors, true);
  const phones = [];
  // Accepts form rows ({ label, number }) AND stored / planned values ("label|number"): re-validating a
  // validated value is idempotent (an import / merge plan never loses its numbers).
  for (const [i, raw] of (Array.isArray(input.phones) ? input.phones : []).entries()) {
    const p = typeof raw === 'string' ? decodePhone(raw) : raw;
    const number = cleanNumber(p && p.number);
    if (!number) continue;   // empty row → ignored
    let label = oneLine(p.label) || 'mobile';
    if (!LABEL_RE.test(label)) { errors[`phone${i}`] = 'contacts.v.label'; continue; }
    if (!validNumber(number)) { errors[`phone${i}`] = 'contacts.v.number'; continue; }
    label = label.slice(0, CONTACT_LIMITS.phoneLabel);
    if (phones.some((x) => digitsOf(x.number) === digitsOf(number))) continue;   // same number twice
    phones.push({ label, number });
  }
  if (phones.length > CONTACT_LIMITS.phones) errors.phones = 'contacts.v.tooManyPhones';
  let categoryIds = [...new Set((Array.isArray(input.categoryIds) ? input.categoryIds : []).filter((x) => typeof x === 'string' && CAT_ID_RE.test(x)))];
  if (categories) { const known = new Set(categories.map((c) => c.id)); categoryIds = categoryIds.filter((x) => known.has(x)); }
  if (categoryIds.length > CONTACT_LIMITS.categories) errors.categoryIds = 'contacts.v.tooManyCategories';
  const value = { name, organization, email, address, notes, favorite: input.favorite === true, phones: phones.map(encodePhone), categoryIds,
    // V6.4 C: avatarUrl / menus only when the input carries them (an import / merge / older client never erases them)
    ...validateMedia(input, errors) };
  return { value, errors };
}
export function assertValid(input, opts) {
  const r = validateContact(input, opts);
  const keys = Object.keys(r.errors);
  if (keys.length) throw fail(r.errors[keys[0]], r.errors);
  return r.value;
}
export const CONTENT_FIELDS = Object.freeze(['name', 'organization', 'email', 'address', 'notes', 'favorite', 'phones', 'categoryIds']);
/** V6.4 C optional media keys — absent on older contacts, never written by .vcf imports. */
export const MEDIA_FIELDS = Object.freeze(['avatarUrl', 'menus']);
export function createDoc(value, { uid, now, source = 'manual' }) {
  const v = { ...value };
  // an empty picture / menu list is simply not stored; imports never carry media (rules refuse it)
  if (source !== 'manual' || !v.avatarUrl) delete v.avatarUrl;
  if (source !== 'manual' || !Array.isArray(v.menus) || !v.menus.length) delete v.menus;
  return { ...v, source, deleted: false, deletedAt: null, deletedBy: null, rev: 1, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
}
/** Field-level patch (only what changed) + rev + stamp; null when nothing changed. */
export function editPatch(cur, value, { uid, now }) {
  const data = {};
  for (const k of CONTENT_FIELDS) if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(value[k] ?? null)) data[k] = value[k];
  // V6.4 C media: only keys the value CARRIES are compared (absent = untouched); absent = null = [] (no churn)
  for (const k of MEDIA_FIELDS) if (k in value && !sameMedia(k, cur[k], value[k])) data[k] = k === 'menus' ? value[k] || [] : value[k] || null;
  if (!Object.keys(data).length) return null;
  return { ...data, rev: cur.rev + 1, updatedBy: uid, updatedAt: now };
}
export const isDeleted = (c) => !!(c && c.deleted === true);

// ------------------------------------------------------------------ search / sort
export function searchMatch(c, q, catNames = []) {
  const f = fold(q); if (!f) return true;
  const hay = fold([c.name, c.organization, c.email, ...catNames].filter(Boolean).join(' '));
  if (f.split(' ').every((w) => hay.includes(w))) return true;
  const qd = digitsOf(asciiDigits(q));
  if (qd.length < 3) return false;
  const qk = qd.length >= 9 ? matchKey(asciiDigits(q)) : '';   // a full number in any format (+20 100… finds 0100…)
  return phonesOf(c).some((p) => digitsOf(p.number).includes(qd) || (matchKey(p.number) && (matchKey(p.number).includes(qd.replace(/^0+/, '')) || (qk && matchKey(p.number) === qk))));
  return false;
}
export function sortContacts(list, locale) {
  const col = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  return [...list].sort((a, b) => (b.favorite === true) - (a.favorite === true) || col.compare(a.name, b.name) || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ duplicates / merge
/** Matches of a candidate ({ name, phones:[{number}] }) among live contacts; phone first, name second. */
export function findMatches(cand, contacts) {
  const keys = new Set(cand.phones.map((p) => matchKey(p.number)).filter((k) => k.length >= 6));
  const nameKey = fold(cand.name);
  const out = [];
  for (const c of contacts) {
    if (isDeleted(c)) continue;
    const phone = phonesOf(c).some((p) => keys.has(matchKey(p.number)));
    const name = !!nameKey && fold(c.name) === nameKey;
    if (phone || name) out.push({ contact: c, by: phone && name ? 'both' : phone ? 'phone' : 'name' });
  }
  const rank = { both: 0, phone: 1, name: 2 };
  return out.sort((a, b) => rank[a.by] - rank[b.by] || a.contact.name.localeCompare(b.contact.name));
}
/**
 * Merge an incoming record into an existing contact WITHOUT overwriting anything: new phone numbers are
 * appended (≤ 10), empty fields are filled, categories are united; different non-empty values are kept
 * as they are and reported as `conflicts`. Returns { value, changed, conflicts, droppedPhones }.
 */
export function mergeValue(existing, incoming) {
  const value = {}; for (const k of CONTENT_FIELDS) value[k] = existing[k] ?? null;
  const conflicts = [];
  const have = new Set(phonesOf(existing).map((p) => matchKey(p.number)));
  const phones = [...(existing.phones || [])]; let droppedPhones = 0;
  for (const p of incoming.phones || []) {
    const d = decodePhone(p);
    if (have.has(matchKey(d.number))) continue;
    if (phones.length >= CONTACT_LIMITS.phones) { droppedPhones++; continue; }
    phones.push(p); have.add(matchKey(d.number));
  }
  value.phones = phones;
  for (const k of ['organization', 'email', 'address', 'notes']) {
    if (!incoming[k]) continue;
    if (!value[k]) value[k] = incoming[k];
    else if (fold(value[k]) !== fold(incoming[k])) conflicts.push(k);
  }
  if (incoming.name && fold(incoming.name) !== fold(existing.name)) conflicts.push('name');
  value.categoryIds = [...new Set([...(existing.categoryIds || []), ...(incoming.categoryIds || [])])].slice(0, CONTACT_LIMITS.categories);
  value.favorite = existing.favorite === true;
  const changed = CONTENT_FIELDS.some((k) => JSON.stringify(value[k] ?? null) !== JSON.stringify(existing[k] ?? null));
  return { value, changed, conflicts, droppedPhones };
}

// ------------------------------------------------------------------ deterministic ids (retry-safe)
export function fnv64(str) {
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
/** Fields that define WHAT was imported (favourite is household state, not import content). */
export const IMPORT_FIELDS = Object.freeze(['name', 'organization', 'email', 'address', 'notes', 'phones', 'categoryIds']);
/** Same content (order-sensitive arrays, nulls normalised). */
export const sameContent = (a, b, fields = IMPORT_FIELDS) => !!a && !!b && fields.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
/**
 * V6.4 B rev 2 — what occupies an import id (the create was refused because the document exists):
 *  'already'  the live document IS this import result (lost response / retry / another device) → nothing to do;
 *  'deleted'  it was imported and later soft-deleted → NOT restored (only contacts.delete may restore);
 *  'kept'     it exists but differs (edited since, or a different import) → the existing data is kept;
 *  'hidden'   it exists but cannot be read (deleted, and the caller lacks contacts.delete).
 * `existing` = the stored document, or the string 'hidden' when the read was denied.
 */
export function classifyOccupied(existing, value) {
  if (existing === 'hidden') return 'hidden';
  if (!existing) return null;                                   // nothing there: the create failed for another reason
  if (existing.deleted === true) return 'deleted';
  return existing.source === 'vcf' && sameContent(existing, value) ? 'already' : 'kept';
}
/** Same record → same id on every device / retry; `copy` separates intentional copies (Keep separate only). */
export const importId = (value, copy = 0) => `vc_${fnv64(`${fold(value.name)}|${phonesOf(value).map((p) => matchKey(p.number)).sort().join(',')}#${copy}`)}`;
