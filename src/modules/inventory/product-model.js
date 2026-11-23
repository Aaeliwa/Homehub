/**
 * Pantry product catalog (V6.5 Phase 01) — PURE model. Mirrors the pantryProducts rules exactly.
 *
 * Identity: a household-scoped document id (never derived from the name). A product has an English and / or an
 * Arabic name — at least one; a missing translation is never invented. Two tracking modes, fixed at creation:
 *   quantity  — dimension (count / mass / volume) + display unit; stock is an integer of base milli-units:
 *               stockMilli = 0, presence = null. An optional low-stock threshold minMilli (same base unit).
 *   presence  — "have / running low / out" only: stockMilli = null, presence = null (not recorded yet).
 * Phase 01 NEVER changes stock: stockMilli / presence / stockRev are written once at creation (0 / null / 0) and
 * are immutable here (Phase 02 adds a separate, movement-proven stock branch with its own sequence stockRev;
 * metadata edits use `rev`, so the two never compete for one counter).
 */
import { isDimension, unitFits, isBaseMilli, parseQuantity, formatQuantity, MAX_BASE_MILLI } from './units.js';

export const CATEGORIES = Object.freeze(['produce', 'dairy', 'meat', 'bakery', 'grains', 'canned', 'frozen', 'drinks', 'snacks', 'spices',
  'condiments', 'cleaning', 'personal', 'baby', 'other']);
export const LOCATIONS = Object.freeze(['pantry', 'fridge', 'freezer', 'cupboard', 'bathroom', 'laundry', 'other']);
export const TRACK_MODES = Object.freeze(['quantity', 'presence']);
export const LIMITS = Object.freeze({ name: 80, note: 200, alias: 40, aliases: 8, maxProducts: 500, archivedList: 200 });
/** Every key of a product document, in schema order (the rules use exactKeys over the same list). */
export const DOC_KEYS = Object.freeze(['nameEn', 'nameAr', 'category', 'location', 'trackMode', 'dimension', 'displayUnit', 'minMilli', 'aliases', 'note',
  'stockMilli', 'presence', 'stockRev', 'archived', 'archivedAt', 'archivedBy', 'rev', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'schemaVersion']);
/** Catalog (metadata) fields a Phase 01 edit may change. trackMode is fixed; dimension only while no stock was ever recorded. */
export const EDITABLE = Object.freeze(['nameEn', 'nameAr', 'category', 'location', 'dimension', 'displayUnit', 'minMilli', 'aliases', 'note']);
export const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

const fail = (detail, fields) => Object.assign(new Error(detail), { code: 'validation', detail, fields });
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (s) => (typeof s === 'string' ? s.replace(CTRL, '').replace(/\s+/g, ' ').trim() : '');

// ------------------------------------------------------------------------------------------------ search
const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
/**
 * Search key: case-folded English (Latin accents removed), Arabic without diacritics (tashkeel, superscript alef)
 * or tatweel, alef forms (أ إ آ ٱ) → ا, ى → ي, ة → ه, ؤ → و, ئ → ي, Arabic-Indic digits → 0-9, single spaces.
 * Used only for matching — names are stored exactly as typed (trimmed).
 */
export function normalizeText(s) {
  return clean(String(s ?? '')).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ٰٟۖ-ۭ]/g, '').replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]).toLowerCase().replace(/\s+/g, ' ').trim();
}
const haystack = (p) => normalizeText([p.nameEn, p.nameAr, ...(p.aliases || []), p.note].filter(Boolean).join(' '));
/** Every word of the query must occur (in any order) in the names, aliases or note. */
export function matches(p, q) {
  const words = normalizeText(q).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = haystack(p);
  return words.every((w) => hay.includes(w));
}
/** Name in the UI language, falling back to the other one (never empty for a valid product). */
export const displayName = (p, lang) => (lang === 'ar' ? p.nameAr || p.nameEn : p.nameEn || p.nameAr) || '';
export const otherName = (p, lang) => { const a = displayName(p, lang); const b = lang === 'ar' ? p.nameEn : p.nameAr; return b && b !== a ? b : null; };
export function sortProducts(list, lang) {
  const coll = new Intl.Collator(lang === 'ar' ? 'ar' : 'en', { sensitivity: 'base', numeric: true });
  return [...list].sort((a, b) => coll.compare(displayName(a, lang), displayName(b, lang)) || String(a.id).localeCompare(String(b.id)));
}
/** Products whose normalized EN or AR name equals one of the candidate's names (a warning, not a block). */
export function similarProducts(value, products, exceptId = null) {
  const keys = [value.nameEn, value.nameAr].filter(Boolean).map(normalizeText);
  if (!keys.length) return [];
  return products.filter((p) => p.id !== exceptId && [p.nameEn, p.nameAr].filter(Boolean).map(normalizeText).some((k) => keys.includes(k)));
}

// ------------------------------------------------------------------------------------------------ validation
/** "rice, أرز ,  basmati" or an array → trimmed, de-duplicated (by search key), bounded list. */
export function parseAliases(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,،\n]/) : [];
  const out = []; const seen = new Set();
  for (const r of raw) { const a = clean(r).replace(/\|/g, ''); if (!a) continue; const k = normalizeText(a); if (seen.has(k)) continue; seen.add(k); out.push(a); }
  return out;
}
/**
 * validateProduct(input, { current }) → { value, errors }.
 * input: { nameEn, nameAr, category, location, trackMode, dimension, displayUnit, minQty (text in displayUnit) | minMilli, aliases, note }.
 * `current` (edit): trackMode is taken from it (fixed); a dimension change is refused once stock was recorded.
 */
export function validateProduct(input = {}, { current = null } = {}) {
  const errors = {};
  const nameEn = clean(input.nameEn); const nameAr = clean(input.nameAr);
  if (!nameEn && !nameAr) errors.name = 'pantry.err.name';
  if (nameEn.length > LIMITS.name) errors.nameEn = 'pantry.err.tooLong';
  if (nameAr.length > LIMITS.name) errors.nameAr = 'pantry.err.tooLong';
  const category = CATEGORIES.includes(input.category) ? input.category : null; if (!category) errors.category = 'pantry.err.category';
  const location = LOCATIONS.includes(input.location) ? input.location : null; if (!location) errors.location = 'pantry.err.location';
  const note = clean(input.note); if (note.length > LIMITS.note) errors.note = 'pantry.err.tooLong';
  const aliases = parseAliases(input.aliases);
  if (aliases.length > LIMITS.aliases) errors.aliases = 'pantry.err.tooManyAliases';
  if (aliases.some((a) => a.length > LIMITS.alias)) errors.aliases = 'pantry.err.tooLong';
  const trackMode = current ? current.trackMode : input.trackMode;
  if (!TRACK_MODES.includes(trackMode)) errors.trackMode = 'pantry.err.mode';
  if (current && input.trackMode !== undefined && input.trackMode !== current.trackMode) errors.trackMode = 'pantry.err.modeLocked';
  let dimension = null; let displayUnit = null; let minMilli = null;
  if (trackMode === 'quantity') {
    dimension = isDimension(input.dimension) ? input.dimension : null;
    if (!dimension) errors.dimension = 'pantry.err.dimension';
    if (current && dimension && dimension !== current.dimension && (current.stockRev || 0) !== 0) errors.dimension = 'pantry.err.dimensionLocked';
    displayUnit = unitFits(dimension, input.displayUnit) ? input.displayUnit : null;
    if (dimension && !displayUnit) errors.displayUnit = 'pantry.err.unit';
    if (Number.isSafeInteger(input.minMilli) || input.minMilli === null) {
      minMilli = input.minMilli;
    } else if (input.minQty !== undefined && input.minQty !== null && String(input.minQty).trim() !== '') {
      if (displayUnit) { try { minMilli = parseQuantity(input.minQty, displayUnit); } catch (e) { errors.minQty = e.detail || 'pantry.err.amount'; } }
    }
    if (minMilli !== null && dimension && (!isBaseMilli(minMilli, dimension) || minMilli === 0)) errors.minQty = errors.minQty || 'pantry.err.amount';
  }
  const value = { nameEn: nameEn || null, nameAr: nameAr || null, category, location, trackMode, dimension, displayUnit, minMilli: minMilli ?? null,
    aliases: aliases.slice(0, LIMITS.aliases), note: note || null };
  return { value, errors };
}
export function assertValid(input, opts) {
  const { value, errors } = validateProduct(input, opts);
  const keys = Object.keys(errors);
  if (keys.length) throw fail(errors[keys[0]], errors);
  return value;
}

// ------------------------------------------------------------------------------------------------ documents
/** A new product: Phase 01 stock state (quantity: 0 base milli; presence: not recorded), stockRev 0, rev 1. */
export function createDoc(v, { uid, now }) {
  const quantity = v.trackMode === 'quantity';
  return { nameEn: v.nameEn, nameAr: v.nameAr, category: v.category, location: v.location, trackMode: v.trackMode,
    dimension: quantity ? v.dimension : null, displayUnit: quantity ? v.displayUnit : null, minMilli: quantity ? v.minMilli : null,
    aliases: [...v.aliases], note: v.note,
    stockMilli: quantity ? 0 : null, presence: null, stockRev: 0,
    archived: false, archivedAt: null, archivedBy: null,
    rev: 1, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
}
/** Metadata-only update mask: changed EDITABLE fields + rev + 1 + stamp; null when nothing changed. Never a stock field. */
export function editPatch(cur, v, { uid, now }) {
  const p = {};
  for (const k of EDITABLE) if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(v[k] ?? null)) p[k] = v[k] ?? null;
  if (!Object.keys(p).length) return null;
  return { ...p, rev: (cur.rev || 0) + 1, updatedBy: uid, updatedAt: now };
}
export const archivePatch = (cur, { uid, now }) => ({ archived: true, archivedAt: now, archivedBy: uid, rev: (cur.rev || 0) + 1, updatedBy: uid, updatedAt: now });
export const restorePatch = (cur, { uid, now }) => ({ archived: false, archivedAt: null, archivedBy: null, rev: (cur.rev || 0) + 1, updatedBy: uid, updatedAt: now });
export const isArchived = (p) => !!(p && p.archived === true);

/** Threshold text in the product's display unit ("6", "1.5"), or ''. */
export const minText = (p) => (p && p.trackMode === 'quantity' && Number.isSafeInteger(p.minMilli) && p.displayUnit ? formatQuantity(p.minMilli, p.displayUnit) : '');
export { MAX_BASE_MILLI };
