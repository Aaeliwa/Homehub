/**
 * Portable contacts JSON — "AI Import / Export JSON" (V6.4.1 Stage A). Pure, local, no network.
 *
 * Contract (one standard form; export OMITS absent / empty values, import treats null as absent):
 *   { "schema": "homehub.contacts", "version": 1, "items": [ {
 *       "name": string (required, ≤ 120),
 *       "organization"?: string ≤ 120, "email"?: string ≤ 254, "address"?: string ≤ 300, "notes"?: string ≤ 1000,
 *       "favorite"?: boolean,
 *       "phones"?: [ { "label"?: "mobile"|"home"|"work"|"whatsapp"|"fax"|"other"|<custom ≤ 30>, "number": string ≤ 40 } ] (≤ 10),
 *       "categories"?: [ string ≤ 40 ] (≤ 10; category NAMES — suggested categories match in English OR Arabic),
 *       "avatarUrl"?: https URL ≤ 500,
 *       "menus"?: [ { "type": "image"|"pdf"|"web"|"drive", "label"?: string ≤ 40, "url": https URL ≤ 500 } ] (≤ 10)
 *   } ] }
 * Never contains ids, audit fields, timestamps, roles, deleted records, household identifiers or Calendar data.
 *
 * Import safety: ≤ 1 MB, ≤ 500 items, nesting ≤ 6; UTF-8 only; the top level must be EXACTLY
 * { schema, version, items } with the known schema / version (anything else rejects the whole file). Items are
 * read key-by-key from an allow-list (own properties only — nothing is spread, so "__proto__" / "constructor"
 * keys are just unknown fields → the item is invalid). Values are type-checked here and then validated by the
 * SAME validators as manual / .vcf contacts (validateContact, contact-media) inside buildPreview.
 */
import { CONTACT_LIMITS, PHONE_LABELS, decodePhone, mergeValue, sortContacts, phonesOf, categoryLabel } from './contact-model.js';
import { menusOf, MENU_KINDS, MEDIA_LIMITS, sameMedia } from './contact-media.js';
import { VCF_LIMITS } from './vcard.js';

export const JSON_SCHEMA = 'homehub.contacts';
export const JSON_VERSION = 1;
export const JSON_LIMITS = Object.freeze({ bytes: VCF_LIMITS.bytes, items: VCF_LIMITS.records, depth: 6 });
export const ITEM_KEYS = Object.freeze(['name', 'organization', 'phones', 'email', 'address', 'notes', 'favorite', 'categories', 'avatarUrl', 'menus']);
const TOP_KEYS = ['schema', 'version', 'items'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

/** Maximum {} / [] nesting outside strings — checked BEFORE JSON.parse (no deep-recursion surprises). */
export function nestingDepth(text) {
  let d = 0; let max = 0; let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') { d++; if (d > max) max = d; if (max > 64) return max; }
    else if (c === '}' || c === ']') d--;
  }
  return max;
}
function decode(input) {
  if (typeof input === 'string') return input.replace(/^﻿/, '');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
}
const byteLength = (s) => new TextEncoder().encode(s).length;

/**
 * Parse a contacts JSON file → { fileErrors: [code], records } (records shaped like parseVcf's so the .vcf
 * preview / duplicate / plan pipeline is reused unchanged). A fileError means NOTHING can be imported.
 */
export function parseContactsJson(input) {
  const fail = (code, extra = {}) => ({ fileErrors: [code], records: [], ...extra });
  if (input && typeof input !== 'string' && (input.byteLength ?? input.length) > JSON_LIMITS.bytes) return fail('tooLarge');
  let text;
  try { text = decode(input); } catch { return fail('encoding'); }
  if (byteLength(text) > JSON_LIMITS.bytes) return fail('tooLarge');
  if (!text.trim()) return fail('empty');
  if (nestingDepth(text) > JSON_LIMITS.depth) return fail('tooDeep');
  let doc;
  try { doc = JSON.parse(text); } catch { return fail('notJson'); }
  if (!plain(doc)) return fail('notObject');
  const extraTop = Object.keys(doc).filter((k) => !TOP_KEYS.includes(k));
  if (extraTop.length) return fail('unknownTop', { unknown: extraTop.slice(0, 10) });
  if (doc.schema !== JSON_SCHEMA) return fail('schema');
  if (doc.version !== JSON_VERSION) return fail('version');
  if (!Array.isArray(doc.items)) return fail('items');
  if (doc.items.length > JSON_LIMITS.items) return fail('tooMany');
  return { fileErrors: [], records: doc.items.map((it, index) => readItem(it, index)) };
}

function readItem(raw, index) {
  const errors = []; const warnings = []; const unknownFields = [];
  const value = { name: '', organization: null, email: null, address: null, notes: null, favorite: false, phones: [], categoryNames: [] };
  const rec = (ok) => ({ index, version: 'json', ok, value, errors: [...new Set(errors)], warnings, unsupported: [], unknownFields, mediaSkipped: 0 });
  if (!plain(raw)) { errors.push('itemType'); return rec(false); }
  for (const k of Object.keys(raw)) if (!ITEM_KEYS.includes(k)) unknownFields.push(k.slice(0, 40));
  if (unknownFields.length) errors.push('unknownField');
  const str = (k) => { if (!own(raw, k) || raw[k] === null) return null; if (typeof raw[k] !== 'string') { errors.push('fieldType'); return null; } return raw[k]; };
  if (own(raw, 'name') && typeof raw.name !== 'string') errors.push('fieldType');
  value.name = typeof raw.name === 'string' ? raw.name : '';
  for (const k of ['organization', 'email', 'address', 'notes']) value[k] = str(k);
  if (own(raw, 'favorite') && raw.favorite !== null) { if (typeof raw.favorite === 'boolean') value.favorite = raw.favorite; else errors.push('fieldType'); }
  if (own(raw, 'phones') && raw.phones !== null) {
    if (!Array.isArray(raw.phones)) errors.push('phoneType');
    else if (raw.phones.length > CONTACT_LIMITS.phones) errors.push('tooManyPhones');
    else for (const p of raw.phones) {
      if (!plain(p) || Object.keys(p).some((k) => k !== 'label' && k !== 'number') || typeof p.number !== 'string' || (own(p, 'label') && p.label !== null && typeof p.label !== 'string')) { errors.push('phoneType'); continue; }
      value.phones.push({ label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : 'other', number: p.number });
    }
  }
  if (own(raw, 'categories') && raw.categories !== null) {
    if (!Array.isArray(raw.categories) || raw.categories.some((c) => typeof c !== 'string' || !c.trim() || c.length > CONTACT_LIMITS.categoryName)) errors.push('categoryType');
    else if (raw.categories.length > CONTACT_LIMITS.categories) errors.push('tooManyCategories');
    else value.categoryNames = [...new Set(raw.categories.map((c) => c.trim()))];
  }
  if (own(raw, 'avatarUrl') && raw.avatarUrl !== null) {
    if (typeof raw.avatarUrl !== 'string') errors.push('fieldType'); else value.avatarUrl = raw.avatarUrl;      // validated by contact-media
  }
  if (own(raw, 'menus') && raw.menus !== null) {
    if (!Array.isArray(raw.menus)) errors.push('menuType');
    else if (raw.menus.length > MEDIA_LIMITS.menus) errors.push('tooManyMenus');
    else {
      const rows = [];
      for (const m of raw.menus) {
        if (!plain(m) || Object.keys(m).some((k) => !['type', 'label', 'url'].includes(k)) || !MENU_KINDS.includes(m.type) || typeof m.url !== 'string'
          || (own(m, 'label') && m.label !== null && typeof m.label !== 'string')) { errors.push('menuType'); continue; }
        rows.push({ kind: m.type, label: typeof m.label === 'string' ? m.label : '', url: m.url });
      }
      if (rows.length) value.menus = rows;                                    // validated by contact-media
    }
  }
  if (!value.name.trim()) errors.push('noName');
  return rec(!errors.length);
}

// ------------------------------------------------------------------ export
/**
 * Contacts → standard portable JSON (text). categoryName(id) → display name (null = not exported: a removed
 * category). Media are exported as stored, menus as structured objects (never the internal "kind|label|url").
 */
export function exportContactsJson(contacts, { categoryName = () => null, locale = 'en' } = {}) {
  const items = sortContacts(contacts, locale).map((c) => {
    const o = { name: c.name };
    for (const k of ['organization', 'email', 'address', 'notes']) if (c[k]) o[k] = c[k];
    if (c.favorite === true) o.favorite = true;
    const phones = phonesOf(c).map((p) => ({ label: p.label, number: p.number }));
    if (phones.length) o.phones = phones;
    const cats = (c.categoryIds || []).map(categoryName).filter(Boolean);
    if (cats.length) o.categories = cats;
    if (c.avatarUrl) o.avatarUrl = c.avatarUrl;
    const menus = menusOf(c).map((m) => (m.label ? { type: m.kind, label: m.label, url: m.url } : { type: m.kind, url: m.url }));
    if (menus.length) o.menus = menus;
    return o;
  });
  return `${JSON.stringify({ schema: JSON_SCHEMA, version: JSON_VERSION, items }, null, 2)}\n`;
}
export const jsonFileName = (base) => `${String(base || 'contacts').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 60) || 'contacts'}.json`;

// ------------------------------------------------------------------ AI helpers (copied / downloaded by the user; nothing is sent anywhere)
export const EXAMPLE = Object.freeze({ schema: JSON_SCHEMA, version: JSON_VERSION, items: [
  { name: 'Dr. Sara Hassan', organization: 'Nile Clinic', phones: [{ label: 'work', number: '+20 2 2345 6789' }, { label: 'mobile', number: '+20 100 123 4567' }],
    email: 'clinic@example.com', categories: ['Doctors'], notes: 'Sunday and Wednesday evenings' },
  { name: 'مطعم الشام', phones: [{ label: 'mobile', number: '01229876543' }], categories: ['مطاعم'], favorite: true,
    avatarUrl: 'https://images.example.com/sham/logo.png', menus: [{ type: 'image', label: 'Page 1', url: 'https://images.example.com/sham/menu-1.jpg' }] },
] });
export const exampleText = () => `${JSON.stringify(EXAMPLE, null, 2)}\n`;
export const SCHEMA_DOC = Object.freeze({
  $comment: 'HomeHub portable contacts — schema homehub.contacts, version 1. Omit unknown values; never invent them.',
  type: 'object', additionalProperties: false, required: ['schema', 'version', 'items'],
  properties: {
    schema: { const: JSON_SCHEMA }, version: { const: JSON_VERSION },
    items: { type: 'array', maxItems: JSON_LIMITS.items, items: { type: 'object', additionalProperties: false, required: ['name'], properties: {
      name: { type: 'string', minLength: 1, maxLength: CONTACT_LIMITS.name },
      organization: { type: 'string', maxLength: CONTACT_LIMITS.organization }, email: { type: 'string', maxLength: CONTACT_LIMITS.email },
      address: { type: 'string', maxLength: CONTACT_LIMITS.address }, notes: { type: 'string', maxLength: CONTACT_LIMITS.notes }, favorite: { type: 'boolean' },
      phones: { type: 'array', maxItems: CONTACT_LIMITS.phones, items: { type: 'object', additionalProperties: false, required: ['number'], properties: {
        label: { type: 'string', maxLength: CONTACT_LIMITS.phoneLabel, examples: PHONE_LABELS }, number: { type: 'string', maxLength: CONTACT_LIMITS.phoneNumber } } } },
      categories: { type: 'array', maxItems: CONTACT_LIMITS.categories, items: { type: 'string', minLength: 1, maxLength: CONTACT_LIMITS.categoryName } },
      avatarUrl: { type: 'string', format: 'uri', pattern: '^https://', maxLength: MEDIA_LIMITS.url },
      menus: { type: 'array', maxItems: MEDIA_LIMITS.menus, items: { type: 'object', additionalProperties: false, required: ['type', 'url'], properties: {
        type: { enum: MENU_KINDS }, label: { type: 'string', maxLength: MEDIA_LIMITS.menuLabel }, url: { type: 'string', pattern: '^https://', maxLength: MEDIA_LIMITS.url } } } },
    } } },
  },
});
export const schemaText = () => `${JSON.stringify(SCHEMA_DOC, null, 2)}\n`;
export function aiPrompt() {
  return [
    'Convert the contact information I give you into ONE JSON document for the HomeHub app.',
    '',
    'Rules — follow all of them:',
    '1. Output ONLY valid JSON (no Markdown, no code fences, no comments, no text before or after).',
    `2. Use exactly this top level: {"schema":"${JSON_SCHEMA}","version":${JSON_VERSION},"items":[...]} — no other top-level keys.`,
    '3. Each item may contain ONLY: name, organization, phones, email, address, notes, favorite, categories, avatarUrl, menus.',
    '4. NEVER guess or invent anything. If a value is not stated in my text, leave the key out. Do not guess country codes, e-mail addresses, websites or categories.',
    '5. "name" is required (as written). Keep Arabic and other scripts exactly as given.',
    '6. "phones": [{"label":"mobile|home|work|whatsapp|fax|other","number":"…"}] — copy the digits exactly as given (keep a leading + only if it is written).',
    '7. "categories": only names I mention (for example Doctors, Restaurants, Pharmacies). Do not create new ones.',
    '8. "avatarUrl" and "menus[].url": only full https:// links that appear in my text. "menus": [{"type":"image|pdf|web|drive","label":"…","url":"https://…"}].',
    `9. Limits: name 120, organization 120, email 254, address 300, notes 1000 characters; at most ${CONTACT_LIMITS.phones} phones, ${CONTACT_LIMITS.categories} categories and ${MEDIA_LIMITS.menus} menus per contact; at most ${JSON_LIMITS.items} contacts.`,
    '10. One item per person or business. Do not merge different people.',
    '',
    'Schema (JSON Schema):',
    schemaText().trim(),
    '',
    'My contact information:',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ explicit, field-by-field merge (JSON only)
export const TAKEABLE = Object.freeze(['name', 'organization', 'email', 'address', 'notes', 'avatarUrl', 'menus']);
/**
 * Merge a validated incoming value into an existing contact. Default = the .vcf rules (existing values are
 * KEPT; empty fields are filled; new numbers added; categories united). Media follow the same rule: a picture
 * / menu list is only ADDED when the contact has none — an existing one is replaced ONLY for fields the user
 * ticked in `take` (explicit per-field confirmation). Returns { value, changed, conflicts, droppedPhones }.
 */
export function mergeJson(existing, incoming, take = new Set()) {
  const m = mergeValue(existing, incoming);
  const value = { ...m.value }; const conflicts = [...m.conflicts];
  for (const k of ['avatarUrl', 'menus']) {
    if (!(k in incoming) || sameMedia(k, existing[k], incoming[k])) continue;
    const has = k === 'menus' ? Array.isArray(existing.menus) && existing.menus.length > 0 : !!existing.avatarUrl;
    if (!has) value[k] = incoming[k]; else conflicts.push(k);
  }
  for (const k of conflicts) if (take.has(k) && TAKEABLE.includes(k) && incoming[k] != null) value[k] = incoming[k];
  const changed = m.changed || ['name', 'organization', 'email', 'address', 'notes'].some((k) => (value[k] ?? null) !== (existing[k] ?? null))
    || ['avatarUrl', 'menus'].some((k) => k in value && !sameMedia(k, existing[k], value[k]));
  return { value, changed, conflicts, droppedPhones: m.droppedPhones };
}
/** For the preview: per conflicting field, the existing and the file value (display strings). */
export function conflictPairs(existing, incoming, t = (k) => k) {
  const show = (k, v) => (k === 'menus' ? (Array.isArray(v) ? t('contacts.json.nMenus', { n: v.length }) : '') : String(v ?? ''));
  return mergeJson(existing, incoming).conflicts.filter((k) => TAKEABLE.includes(k)).map((k) => ({ field: k, current: show(k, existing[k]), file: show(k, incoming[k]) }));
}
/** Display name of a stored category in the exporter's language (suggested ones translated, renamed ones as named). */
export const exportCategoryName = (cat, t) => (cat ? categoryLabel(cat, t) : null);
export { decodePhone };
