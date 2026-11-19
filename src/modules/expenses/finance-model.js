/**
 * Finance domain model — PURE (no Firebase, no DOM).
 *
 * Four kinds of money record, never confused:
 *   EXPENSE     homes/{h}/expenses        money genuinely spent (the only thing in "spending")
 *   MOVEMENT    homes/{h}/walletMovements funding (money in from outside), transfer (wallet→wallet),
 *                                          adjustment (cash reconciliation ±). NEVER spending/income totals.
 *   COMMITMENT  homes/{h}/commitments     a scheduled obligation (template). NOT an expense until paid.
 *   CYCLE       homes/{h}/spendingCycles  a rolling N-day budget on ONE wallet.
 *
 * Privacy ("access") is carried on every record so Firestore rules can enforce it and queries
 * can be proven safe:
 *   audience 'household' → readable with expenses.view
 *   readers  [uids]      → readable by those members (owner + shared members of a personal wallet)
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { normalizeText, isCurrencyCode } from '../../core/utils/validate.js';
import { parseMinor, isMinor } from './money.js';
import { isCalendarDate, addDays } from './calendar.js';
import { isRecurrence } from './recurrence.js';

export const FINANCE_SCHEMA_VERSION = 1;
export const LIMITS = Object.freeze({ name: 60, note: 200, merchant: 60, notes: 1000, sharedWith: 5, cycleDays: 31, reason: 200 });

export const EXPENSE_CATEGORIES = Object.freeze([
  { id: 'groceries', icon: '🛒' }, { id: 'food', icon: '🍽️' }, { id: 'transport', icon: '🚕' }, { id: 'fuel', icon: '⛽' },
  { id: 'home', icon: '🏠' }, { id: 'utilities', icon: '💡' }, { id: 'children', icon: '🧸' }, { id: 'education', icon: '🎓' },
  { id: 'health', icon: '💊' }, { id: 'shopping', icon: '🛍️' }, { id: 'entertainment', icon: '🎬' }, { id: 'subscriptions', icon: '🔁' },
  { id: 'rent', icon: '🏢' }, { id: 'mortgage', icon: '🏦' }, { id: 'insurance', icon: '🛡️' }, { id: 'maintenance', icon: '🔧' },
  { id: 'gifts', icon: '🎁' }, { id: 'zakat', icon: '🤲' }, { id: 'other', icon: '💸' },
]);
export const CATEGORY_IDS = Object.freeze(EXPENSE_CATEGORIES.map((c) => c.id));
export const categoryIcon = (id) => (EXPENSE_CATEGORIES.find((c) => c.id === id) || EXPENSE_CATEGORIES.at(-1)).icon;

/** 'visa' is kept ONLY so imported history (CSV isVisa === true) stays valid; not offered for new entries. */
export const PAYMENT_METHODS = Object.freeze(['cash', 'debit_card', 'credit_card', 'bank_transfer', 'digital_wallet', 'other']);
export const IMPORTED_PAYMENT_METHODS = Object.freeze(['visa']);
export const ALL_PAYMENT_METHODS = Object.freeze([...PAYMENT_METHODS, ...IMPORTED_PAYMENT_METHODS]);

export const WALLET_TYPES = Object.freeze(['cash', 'bank', 'card', 'digital', 'allowance', 'other']);
export const WALLET_SCOPES = Object.freeze(['home', 'personal']);
export const VISIBILITIES = Object.freeze(['household', 'private', 'shared']);
/** 'savings' (Phase 5): wallet ↔ Life Savings transfer — one wallet side + a linked savings event. Never spending/income. */
export const MOVEMENT_TYPES = Object.freeze(['funding', 'transfer', 'adjustment', 'savings']);
export const DEFAULT_CYCLE_DAYS = 10;

const UID = /^[A-Za-z0-9_-]{1,128}$/;
const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const isDocId = (v) => typeof v === 'string' && DOC_ID.test(v);

const fail = (detail) => new AppError(ErrorCode.VALIDATION, { detail });
const optText = (v, max, key, errors) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) return null;
  if (s.length > max) errors[key] = `finance.validation.tooLong`;
  return s;
};

// ---- access (privacy) -------------------------------------------------------------------

/** Readers of a wallet: household wallets have none (audience household); personal = owner + shared. */
export function walletReaders(w) {
  if (!w || w.visibility === 'household') return [];
  return [...new Set([w.ownerUid, ...(w.visibility === 'shared' ? (w.sharedWith || []) : [])].filter(Boolean))].sort();
}

/**
 * Access for a record touching these wallets (1 for expenses/cycles, up to 2 for movements).
 * audience 'household' if ANY wallet is household (or there is no wallet: imported/unassigned
 * household history). readers = union of the non-household wallets' readers, so a private
 * owner always sees movements of their own wallet.
 */
export function accessFor(wallets) {
  const list = wallets.filter(Boolean);
  const household = list.length === 0 || list.some((w) => w.visibility === 'household');
  const readers = [...new Set(list.filter((w) => w.visibility !== 'household').flatMap(walletReaders))].sort();
  return { audience: household ? 'household' : 'restricted', readers };
}

export function canReadRecord(record, { uid, canViewHousehold }) {
  if (!record) return false;
  if ((record.audience ?? 'household') === 'household' && canViewHousehold) return true;
  return Array.isArray(record.readers) && record.readers.includes(uid);
}

// ---- wallets ------------------------------------------------------------------------------

export function validateWalletInput(input = {}, { uid, memberUids = [] } = {}) {
  const errors = {};
  const name = normalizeText(input.name);
  if (!name) errors.name = 'finance.validation.nameRequired';
  else if (name.length > LIMITS.name) errors.name = 'finance.validation.tooLong';
  const type = WALLET_TYPES.includes(input.type) ? input.type : null;
  if (!type) errors.type = 'finance.validation.invalid';
  const scope = WALLET_SCOPES.includes(input.scope) ? input.scope : null;
  if (!scope) errors.scope = 'finance.validation.invalid';
  const currency = input.currency;
  if (!isCurrencyCode(currency)) errors.currency = 'finance.validation.currencyInvalid';
  let visibility = scope === 'home' ? 'household' : (VISIBILITIES.includes(input.visibility) && input.visibility !== 'household' ? input.visibility : 'private');
  let ownerUid = scope === 'personal' ? (input.ownerUid || uid) : null;
  if (scope === 'personal' && !UID.test(ownerUid || '')) errors.ownerUid = 'finance.validation.invalid';
  if (scope === 'personal' && memberUids.length && !memberUids.includes(ownerUid)) errors.ownerUid = 'finance.validation.notMember';
  let sharedWith = visibility === 'shared' ? [...new Set((input.sharedWith || []).filter((u) => u && u !== ownerUid))].sort() : [];
  if (sharedWith.length > LIMITS.sharedWith) errors.sharedWith = 'finance.validation.tooManyShared';
  if (sharedWith.some((u) => !UID.test(u) || (memberUids.length && !memberUids.includes(u)))) errors.sharedWith = 'finance.validation.notMember';
  if (visibility === 'shared' && !sharedWith.length) visibility = 'private';
  const opening = parseMinor(input.openingBalance);
  if (opening.error) errors.openingBalance = opening.error;
  return { value: { name, type, scope, ownerUid, visibility, sharedWith, currency, openingBalanceMinor: opening.value ?? null }, errors };
}

export function buildWalletCreate({ input, uid, memberUids, now }) {
  const { value: v, errors } = validateWalletInput(input, { uid, memberUids });
  if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
  const w = { name: v.name, type: v.type, scope: v.scope, ownerUid: v.ownerUid, visibility: v.visibility, sharedWith: v.sharedWith, currency: v.currency };
  return {
    data: { ...w, readers: walletReaders(w), active: true, archivedAt: null, archivedBy: null,
      createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: FINANCE_SCHEMA_VERSION },
    openingBalanceMinor: v.openingBalanceMinor,
  };
}

// ---- expenses -----------------------------------------------------------------------------

export function validateExpenseInput(input = {}) {
  const errors = {};
  const amt = parseMinor(input.amount, { allowZero: false });
  if (amt.error) errors.amount = amt.error;
  else if (amt.value === null) errors.amount = 'finance.validation.amountRequired';
  const category = CATEGORY_IDS.includes(input.category) ? input.category : null;
  if (!category) errors.category = 'finance.validation.categoryRequired';
  const date = input.date;
  if (!isCalendarDate(date)) errors.date = 'finance.validation.dateInvalid';
  const paymentMethod = input.paymentMethod === '' || input.paymentMethod == null ? null : input.paymentMethod;
  if (paymentMethod !== null && !ALL_PAYMENT_METHODS.includes(paymentMethod)) errors.paymentMethod = 'finance.validation.invalid';
  const walletId = input.walletId || null;
  if (walletId !== null && !isDocId(walletId)) errors.walletId = 'finance.validation.invalid';
  const note = optText(input.note, LIMITS.note, 'note', errors);
  const merchant = optText(input.merchant, LIMITS.merchant, 'merchant', errors);
  const paidBy = input.paidBy || null;
  if (paidBy !== null && !UID.test(paidBy)) errors.paidBy = 'finance.validation.invalid';
  const budgetCycleId = input.budgetCycleId || null;
  if (budgetCycleId !== null && !isDocId(budgetCycleId)) errors.budgetCycleId = 'finance.validation.invalid';
  return { value: { amountMinor: amt.value ?? null, category, date, paymentMethod, walletId, note, merchant, paidBy, budgetCycleId }, errors };
}

/** Field set every NEW expense carries (imported history carries the same + originalRow/importedCategory/importBatchId). */
export function buildExpenseCreate({ input, uid, wallet, currency, commitment = null, now }) {
  const { value: v, errors } = validateExpenseInput(input);
  if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
  if (v.walletId && (!wallet || wallet.id !== v.walletId)) throw fail('finance.validation.walletUnavailable');
  if (wallet && wallet.active !== true) throw fail('finance.validation.walletArchived');
  const cur = wallet ? wallet.currency : currency;
  return {
    amountMinor: v.amountMinor, currency: cur, date: v.date, category: v.category, note: v.note, merchant: v.merchant,
    paymentMethod: v.paymentMethod, walletId: v.walletId, budgetCycleId: v.budgetCycleId, paidBy: v.paidBy,
    commitmentId: commitment ? commitment.id : null, commitmentDueDate: commitment ? commitment.nextDueDate : null,
    ...accessFor(wallet ? [wallet] : []),
    status: 'active', voidedAt: null, voidedBy: null, voidReason: null, source: 'app',
    createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: FINANCE_SCHEMA_VERSION,
  };
}

/** Editable after creation. Wallet changes re-derive access. Amount/date/category/etc. */
export const EXPENSE_EDITABLE = Object.freeze(['amountMinor', 'date', 'category', 'note', 'merchant', 'paymentMethod', 'walletId', 'budgetCycleId', 'paidBy']);

export function buildExpenseEdit({ original, input, uid, wallet, now }) {
  const { value: v, errors } = validateExpenseInput(input);
  if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
  if (v.walletId && (!wallet || wallet.id !== v.walletId)) throw fail('finance.validation.walletUnavailable');
  const patch = {};
  for (const k of EXPENSE_EDITABLE) if ((original[k] ?? null) !== (v[k] ?? null)) patch[k] = v[k];
  if ('walletId' in patch) {
    if (wallet && wallet.active !== true) throw fail('finance.validation.walletArchived');
    Object.assign(patch, accessFor(wallet ? [wallet] : []));
    if (wallet && wallet.currency !== (original.currency || wallet.currency)) throw fail('finance.validation.currencyMismatch');
  }
  if (!Object.keys(patch).length) return null;
  return { ...patch, updatedBy: uid, updatedAt: now };
}

/** Corrections never delete: an expense is VOIDED (kept, excluded from totals, reason recorded). */
export function buildExpenseVoid({ uid, now, reason }) {
  const r = normalizeText(reason || '').slice(0, LIMITS.reason) || null;
  return { status: 'void', voidedAt: now, voidedBy: uid, voidReason: r, updatedBy: uid, updatedAt: now };
}
export const buildExpenseRestore = ({ uid, now }) => ({ status: 'active', voidedAt: null, voidedBy: null, voidReason: null, updatedBy: uid, updatedAt: now });

// ---- movements (funding / transfer / adjustment) -------------------------------------------

export function buildMovementCreate({ type, amount, date, fromWallet = null, toWallet = null, note, cycleId = null, uid, now }) {
  if (!MOVEMENT_TYPES.includes(type)) throw fail('type');
  const amt = parseMinor(amount, { allowZero: false });
  if (amt.error || amt.value === null) throw fail(amt.error || 'finance.validation.amountRequired');
  if (!isCalendarDate(date)) throw fail('finance.validation.dateInvalid');
  if (type === 'funding' && (!toWallet || fromWallet)) throw fail('funding needs a destination only');
  if (type === 'transfer') {
    if (!fromWallet || !toWallet) throw fail('transfer needs two wallets');
    if (fromWallet.id === toWallet.id) throw fail('finance.validation.sameWallet');
    if (fromWallet.currency !== toWallet.currency) throw fail('finance.validation.currencyMismatch');
  }
  if (type === 'adjustment' && (!!fromWallet === !!toWallet)) throw fail('adjustment needs exactly one wallet');
  for (const w of [fromWallet, toWallet]) if (w && w.active !== true) throw fail('finance.validation.walletArchived');
  const ws = [fromWallet, toWallet].filter(Boolean);
  const errors = {};
  const n = optText(note, LIMITS.note, 'note', errors);
  if (Object.keys(errors).length) throw fail('note');
  return {
    type, amountMinor: amt.value, currency: ws[0].currency, date,
    fromWalletId: fromWallet ? fromWallet.id : null, toWalletId: toWallet ? toWallet.id : null,
    cycleId: cycleId || null, note: n, ...accessFor(ws),
    status: 'active', voidedAt: null, voidedBy: null,
    createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: FINANCE_SCHEMA_VERSION,
  };
}

// ---- spending cycles ----------------------------------------------------------------------

export function buildCycleCreate({ wallet, startDate, days = DEFAULT_CYCLE_DAYS, budget, carryInMinor = 0, previousCycleId = null, uid, now }) {
  if (!wallet || wallet.active !== true) throw fail('finance.validation.walletUnavailable');
  if (!isCalendarDate(startDate)) throw fail('finance.validation.dateInvalid');
  if (!Number.isInteger(days) || days < 1 || days > LIMITS.cycleDays) throw fail('finance.validation.cycleDays');
  const b = parseMinor(budget, { allowZero: false });
  if (b.error || b.value === null) throw fail(b.error || 'finance.validation.amountRequired');
  if (!isMinor(carryInMinor)) throw fail('carryIn');
  return {
    walletId: wallet.id, currency: wallet.currency, startDate, endDate: addDays(startDate, days - 1), days,
    budgetMinor: b.value, carryInMinor, previousCycleId, status: 'active',
    closedAt: null, closedBy: null, closeOutcome: null, closingRemainingMinor: null, nextCycleId: null,
    ...accessFor([wallet]),
    createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: FINANCE_SCHEMA_VERSION,
  };
}

// ---- commitments ----------------------------------------------------------------------------

export function validateCommitmentInput(input = {}) {
  const errors = {};
  const name = normalizeText(input.name);
  if (!name) errors.name = 'finance.validation.nameRequired';
  else if (name.length > LIMITS.name) errors.name = 'finance.validation.tooLong';
  const amt = parseMinor(input.amount, { allowZero: false });
  if (amt.error) errors.amount = amt.error; else if (amt.value === null) errors.amount = 'finance.validation.amountRequired';
  const category = CATEGORY_IDS.includes(input.category) ? input.category : null;
  if (!category) errors.category = 'finance.validation.categoryRequired';
  const recurrence = input.recurrence && { unit: input.recurrence.unit, interval: Number(input.recurrence.interval) };
  if (!isRecurrence(recurrence)) errors.recurrence = 'finance.validation.recurrenceInvalid';
  if (!isCalendarDate(input.nextDueDate)) errors.nextDueDate = 'finance.validation.dateInvalid';
  const paymentMethod = input.paymentMethod || null;
  if (paymentMethod !== null && !PAYMENT_METHODS.includes(paymentMethod)) errors.paymentMethod = 'finance.validation.invalid';
  const walletId = input.walletId || null;
  const notes = optText(input.notes, LIMITS.notes, 'notes', errors);
  return { value: { name, amountMinor: amt.value ?? null, category, recurrence, nextDueDate: input.nextDueDate, paymentMethod, walletId, notes }, errors };
}

export function buildCommitmentCreate({ input, wallet, currency, uid, now }) {
  const { value: v, errors } = validateCommitmentInput(input);
  if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
  if (v.walletId && (!wallet || wallet.id !== v.walletId || wallet.active !== true)) throw fail('finance.validation.walletUnavailable');
  return {
    name: v.name, amountMinor: v.amountMinor, currency: wallet ? wallet.currency : currency, category: v.category,
    recurrence: v.recurrence, anchorDay: Number(v.nextDueDate.slice(8, 10)), nextDueDate: v.nextDueDate,
    paymentMethod: v.paymentMethod, walletId: v.walletId, notes: v.notes, lastPaidDate: null,
    ...accessFor(wallet ? [wallet] : []),
    active: true, archivedAt: null, archivedBy: null,
    createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: FINANCE_SCHEMA_VERSION,
  };
}

/**
 * Paying a commitment creates exactly ONE expense whose id is deterministic:
 *   cm_{commitmentId}_{dueDate}
 * A second attempt for the same due date targets the same id and is rejected (create on an
 * existing document), so a double click or two devices can never double-count.
 */
export const paymentExpenseId = (commitmentId, dueDate) => `cm_${commitmentId}_${dueDate.replace(/-/g, '')}`;
