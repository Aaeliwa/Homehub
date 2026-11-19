/**
 * V6.2.2 — wallet administration rules (PURE, no DOM / Firestore): Correct Balance, Delete (= archive,
 * never a hard delete) and Restore. One balance formula only: callers pass the balance computed by
 * finance-v6.accountBalance (store.balance).
 */
import { isCalendarDate } from './calendar.js';

const fail = (detail) => Object.assign(new Error(detail), { code: 'validation', detail });
export const REQUIRED_ROLES = Object.freeze(['cash', 'bank']);
export const correctionId = (walletId, seq) => `rc_${walletId}_${seq}`;
const hh = (w) => w.visibility === 'household';

/**
 * Validate a correction. `expectedBeforeMinor` = the balance the user saw; if the live balance differs
 * (another tab / device changed it) the attempt is refused as stale instead of applying a wrong delta.
 * Returns { beforeMinor, afterMinor, deltaMinor, seq, id }.
 */
export function planCorrection({ wallet, currentMinor, actualMinor, expectedBeforeMinor, date, reason, today }) {
  if (!wallet || wallet.active !== true) throw fail('finance.validation.walletArchived');
  if (!Number.isSafeInteger(actualMinor) || Math.abs(actualMinor) > 1e13) throw fail('finance.validation.amountInvalid');
  if (expectedBeforeMinor !== undefined && expectedBeforeMinor !== currentMinor) throw fail('finance.v622.stale');
  const delta = actualMinor - currentMinor;
  if (delta === 0) throw fail('finance.v622.noChange');
  if (!isCalendarDate(date) || (today && date > today)) throw fail('finance.v622.dateInvalid');
  if (isCalendarDate(wallet.openingDate) && date < wallet.openingDate) throw fail('finance.v6.beforeOpening');
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) throw fail('finance.v6.reasonRequired');
  if (r.length > 200) throw fail('finance.validation.tooLong');
  const seq = (Number.isInteger(wallet.correctionSeq) ? wallet.correctionSeq : 0) + 1;
  return { beforeMinor: currentMinor, afterMinor: actualMinor, deltaMinor: delta, seq, id: correctionId(wallet.id, seq), reason: r };
}

/**
 * Can this wallet be deleted (archived)? Blocks: the Home's required Cash / Bank account; active
 * recurring bills that would pay from it (move them first; history is never rewritten). Warnings: remaining balance, shared members, open cycles.
 */
export function removalCheck(wallet, { wallets = [], commitments = [], cycles = [] }, balanceMinor = 0) {
  if (!wallet || wallet.active !== true) return { blocked: 'finance.v622.alreadyDeleted', bills: [], warnings: [] };
  // The Home's Cash / Bank accounts are required (expense choice maps to them): never deleted. Rename or
  // correct the balance instead. (Rules enforce the same.)
  if (hh(wallet) && REQUIRED_ROLES.includes(wallet.role)) return { blocked: `finance.v622.required.${wallet.role}`, bills: [], warnings: [] };
  const bills = commitments.filter((c) => c.active === true && c.walletId === wallet.id);
  const warnings = [];
  if (balanceMinor !== 0) warnings.push('balance');
  if (wallet.visibility === 'shared' && (wallet.sharedWith || []).length) warnings.push('shared');
  if (cycles.some((c) => c.walletId === wallet.id && c.status === 'active')) warnings.push('cycle');
  return { blocked: bills.length ? 'finance.v622.billsUseIt' : null, bills, warnings };
}

/** Restore must not create two active wallets with the same required role. */
export function restoreCheck(wallet, wallets = []) {
  if (!wallet || wallet.active !== false) return { blocked: null };
  if (hh(wallet) && REQUIRED_ROLES.includes(wallet.role)
    && wallets.some((w) => w.id !== wallet.id && w.active === true && hh(w) && w.role === wallet.role)) return { blocked: `finance.v622.duplicateRole.${wallet.role}` };
  return { blocked: null };
}

/** Balance adjustments of one wallet, newest first: { id, date, deltaMinor, beforeMinor?, afterMinor?, reason, by, status }. */
export function adjustmentHistory(movements, walletId) {
  const ts = (x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : typeof x === 'string' ? Date.parse(x) || 0 : 0);
  return movements.filter((m) => m.type === 'reconciliation' && (m.toWalletId === walletId || m.fromWalletId === walletId))
    .map((m) => ({ id: m.id, date: m.date, deltaMinor: m.toWalletId === walletId ? m.amountMinor : -m.amountMinor,
      beforeMinor: Number.isInteger(m.beforeMinor) ? m.beforeMinor : null, afterMinor: Number.isInteger(m.afterMinor) ? m.afterMinor : null,
      reason: m.reason || '', by: m.createdBy, status: m.status, at: ts(m.createdAt) }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.at - a.at || String(b.id).localeCompare(String(a.id)));
}
