/**
 * Life Savings — asset & event model. PURE.
 *
 * WHAT DO I OWN?  An asset holds a QUANTITY in its own unit (money minor units of its
 * currency, or metal milligrams). Quantity changes only through append-only EVENTS; the
 * balance is the deterministic sum of events. Metadata edits never move money.
 *
 * Privacy = Finance's model: audience 'household' (savings.view) or readers [uids]
 * (owner + explicitly shared members). The Home owner has NO implicit access.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { normalizeText, isCurrencyCode } from '../../core/utils/validate.js';
import { isCalendarDate } from '../expenses/calendar.js';
import { parseMinor, parseGrams } from './quantity.js';

export const SAVINGS_SCHEMA_VERSION = 1;
export const ASSET_TYPES = Object.freeze(['cash', 'bank', 'gold', 'silver', 'fx', 'investment', 'other']);
export const METAL_TYPES = Object.freeze(['gold', 'silver']);
/** Purity keys: gold in karats; silver in millesimal fineness. */
export const PURITIES = Object.freeze({ gold: ['24', '22', '21', '18'], silver: ['999', '925', '900', '800'] });
export const DEFAULT_PURITY = Object.freeze({ gold: '21', silver: '999' });
export const PURITY_FRACTION = Object.freeze({ 24: [24, 24], 22: [22, 24], 21: [21, 24], 18: [18, 24], 999: [999, 1000], 925: [925, 1000], 900: [900, 1000], 800: [800, 1000] });
export const ZAKAT_TREATMENTS = Object.freeze(['included', 'excluded']);
export const EVENT_TYPES = Object.freeze(['opening', 'contribution', 'withdrawal', 'adjustment', 'transfer_in', 'transfer_out']);
export const VISIBILITIES = Object.freeze(['household', 'private', 'shared']);
export const LIMITS = Object.freeze({ name: 60, institution: 60, note: 200, notes: 1000, sharedWith: 5, allocations: 6 });
export const TYPE_ICONS = Object.freeze({ cash: '💵', bank: '🏦', gold: '🥇', silver: '🥈', fx: '💱', investment: '📈', other: '💼' });

export const isMetal = (type) => METAL_TYPES.includes(type);
export const unitOf = (asset) => (isMetal(asset.type) ? 'mg' : 'minor');

const fail = (detail) => new AppError(ErrorCode.VALIDATION, { detail });
const optText = (v, max) => { const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; return s ? s.slice(0, max) : null; };

// ---- privacy ---------------------------------------------------------------------------
export function assetReaders(a) {
  if (a.visibility === 'household') return [];
  return [...new Set([a.ownerUid, ...(a.visibility === 'shared' ? a.sharedWith || [] : [])].filter(Boolean))].sort();
}
export const accessOf = (a) => ({ audience: a.visibility === 'household' ? 'household' : 'restricted', readers: assetReaders(a) });

/** Zakat allocations: [{ uid, bps }] summing to exactly 10,000 (100 %). Never guessed. */
export function validateAllocations(list) {
  if (!Array.isArray(list) || !list.length) return 'savings.validation.allocationRequired';
  if (list.length > LIMITS.allocations) return 'savings.validation.allocationTooMany';
  const uids = new Set();
  let sum = 0;
  for (const a of list) {
    if (!a || typeof a.uid !== 'string' || !a.uid || uids.has(a.uid)) return 'savings.validation.allocationInvalid';
    if (!Number.isInteger(a.bps) || a.bps <= 0 || a.bps > 10000) return 'savings.validation.allocationInvalid';
    uids.add(a.uid); sum += a.bps;
  }
  return sum === 10000 ? null : 'savings.validation.allocationSum';
}
/** '60' → 6000 bps; '33.33' → 3333. */
export function percentToBps(raw) {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(raw || '').trim());
  if (!m) return null;
  const v = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return v > 0 && v <= 10000 ? v : null;
}

// ---- assets ------------------------------------------------------------------------------
/**
 * input: { name, type, scope:'home'|'personal', ownerUid, visibility, sharedWith, currency,
 *          metal purity, institution, notes, zakatTreatment, allocations, opening (string) }
 */
export function validateAssetInput(input = {}, { uid, memberUids = [], homeCurrency = 'EGP' } = {}) {
  const errors = {};
  const name = normalizeText(input.name);
  if (!name) errors.name = 'savings.validation.nameRequired';
  else if (name.length > LIMITS.name) errors.name = 'savings.validation.tooLong';
  const type = ASSET_TYPES.includes(input.type) ? input.type : null;
  if (!type) errors.type = 'savings.validation.typeInvalid';
  const scope = input.scope === 'home' ? 'home' : 'personal';
  const ownerUid = scope === 'personal' ? (input.ownerUid || uid) : null;
  if (scope === 'personal' && memberUids.length && !memberUids.includes(ownerUid)) errors.ownerUid = 'savings.validation.notMember';
  let visibility = scope === 'home' ? 'household' : (input.visibility === 'shared' ? 'shared' : 'private');
  let sharedWith = visibility === 'shared' ? [...new Set((input.sharedWith || []).filter((u) => u && u !== ownerUid))].sort() : [];
  if (sharedWith.length > LIMITS.sharedWith) errors.sharedWith = 'savings.validation.tooManyShared';
  if (memberUids.length && sharedWith.some((u) => !memberUids.includes(u))) errors.sharedWith = 'savings.validation.notMember';
  if (visibility === 'shared' && !sharedWith.length) visibility = 'private';
  // Unit: metals are always grams (valued in the home currency); money types hold their own currency.
  let currency = null; let purity = null;
  if (type && isMetal(type)) {
    purity = PURITIES[type].includes(String(input.purity)) ? String(input.purity) : null;
    if (!purity) errors.purity = 'savings.validation.purityInvalid';
  } else if (type) {
    currency = type === 'cash' || type === 'bank' || type === 'investment' || type === 'other' ? (input.currency || homeCurrency) : input.currency;
    if (!isCurrencyCode(currency)) errors.currency = 'savings.validation.currencyInvalid';
    if (type === 'fx' && currency === homeCurrency) errors.currency = 'savings.validation.fxSameAsHome';
  }
  const zakatTreatment = ZAKAT_TREATMENTS.includes(input.zakatTreatment) ? input.zakatTreatment : 'included';
  // Household assets need an explicit allocation to be included in anyone's Zakat.
  let allocations = [];
  if (scope === 'home' && zakatTreatment === 'included' && Array.isArray(input.allocations) && input.allocations.length) {
    allocations = input.allocations.map((a) => ({ uid: a.uid, bps: a.bps }));
    const e = validateAllocations(allocations);
    if (e) errors.allocations = e;
  }
  const opening = type && isMetal(type) ? parseGrams(input.opening) : parseMinor(input.opening);
  if (opening.error) errors.opening = opening.error;
  return {
    value: { name, type, scope, ownerUid, visibility, sharedWith, currency, purity, zakatTreatment, allocations,
      institution: optText(input.institution, LIMITS.institution), notes: optText(input.notes, LIMITS.notes), openingQty: opening.value ?? null },
    errors,
  };
}

export function buildAssetCreate({ input, uid, memberUids, homeCurrency, now }) {
  const { value: v, errors } = validateAssetInput(input, { uid, memberUids, homeCurrency });
  if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
  const a = { name: v.name, type: v.type, scope: v.scope, ownerUid: v.ownerUid, visibility: v.visibility, sharedWith: v.sharedWith,
    currency: v.currency, purity: v.purity, institution: v.institution, notes: v.notes,
    zakatTreatment: v.zakatTreatment, allocations: v.allocations };
  return {
    data: { ...a, ...accessOf(a), active: true, archivedAt: null, archivedBy: null,
      createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: SAVINGS_SCHEMA_VERSION },
    openingQty: v.openingQty,
  };
}

/** Metadata-only edits (no quantity). ownerUid / type / unit never change after creation. */
export const ASSET_EDITABLE = Object.freeze(['name', 'institution', 'notes', 'zakatTreatment', 'allocations', 'purity', 'visibility', 'sharedWith']);

// ---- events ------------------------------------------------------------------------------
/** qty is SIGNED in the asset unit: + into the asset, − out of it. */
export const SIGN = Object.freeze({ opening: 1, contribution: 1, transfer_in: 1, withdrawal: -1, transfer_out: -1, adjustment: 0 });

export function buildEvent({ asset, type, qty, date, note = null, transferId = null, walletId = null, costMinor = null, costCurrency = null, uid, now }) {
  if (!EVENT_TYPES.includes(type)) throw fail('type');
  if (!Number.isSafeInteger(qty) || qty === 0) throw fail('savings.validation.amountRequired');
  if (SIGN[type] === 1 && qty < 0) throw fail('sign');
  if (SIGN[type] === -1 && qty > 0) throw fail('sign');
  if (!isCalendarDate(date)) throw fail('savings.validation.dateInvalid');
  if (asset.active !== true) throw fail('savings.validation.assetArchived');
  return {
    assetId: asset.id, type, qty, unit: unitOf(asset), currency: asset.currency || null, date,
    note: optText(note, LIMITS.note), transferId, walletId, costMinor, costCurrency,
    ...accessOf(asset), status: 'active',
    createdBy: uid, createdAt: now, schemaVersion: SAVINGS_SCHEMA_VERSION,
  };
}

/** Balance on (and including) `date`, or overall. Deterministic sum of events. */
export function balanceOf(assetId, events, date = null) {
  let q = 0;
  for (const e of events) if (e.assetId === assetId && (e.status ?? 'active') === 'active' && (!date || e.date <= date)) q += e.qty;
  return q;
}

export function sortActivity(events) {
  const ms = (e) => { const c = e.createdAt; return c ? (c.toMillis ? c.toMillis() : c.seconds ? c.seconds * 1000 : Date.parse(c) || 0) : 0; };
  return [...events].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : ms(b) - ms(a) || (a.id < b.id ? 1 : -1)));
}
