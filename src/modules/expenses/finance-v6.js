/**
 * HomeHub V6 Finance — PURE domain model (no Firebase, no DOM). Decisions (approved V6 specs):
 *  S1  Opening = ONE movement `op_{walletId}` dated `wallet.openingDate`: balance > 0 → toWalletId,
 *      balance < 0 → fromWalletId (|balance|), 0 → no document. Never income.
 *  F1  Cutoff = start of `openingDate` (Home date): balance sums ONLY records dated ≥ openingDate
 *      (the opening record is one of them — counted once). Wallets without openingDate (pre-V6)
 *      keep the V5 formula (no cutoff).
 *  S4  No pending state: a Visa purchase is recorded when entered (posted); reconcile handles timing.
 *      Visa = paymentMethod 'debit_card' on a wallet with role 'bank' — one expense, never a liability.
 *  Budget  ONE manual household cap per period; periods half-open [start, endExclusive), immutable,
 *      non-overlapping (serialized head); NO carry-forward; no adjustments in remaining (D5).
 *      Attribution: open period containing the date; a closed one → current open period + lateEntry
 *      (R1); none → unbudgeted (R2). Household aggregates use household-audience records only (U5).
 *      Zakat-payment expenses (`zk_*`, category 'zakat') are NOT budgeted — V5 behaviour preserved
 *      pending owner decision OD-3 (single predicate: `budgetEligible`).
 *  S3  Refunds: movement `{expenseId}_rf{n}` + ledger `refundLedgers/{expenseId}` {refundSeq (monotonic),
 *      refundedMinor (active sum), rev}. Σ ≤ original; void only the LATEST CREATED refund, reason
 *      required; refundSeq never decreases (ids never reused).
 *  S2  Savings pairing: money assets compare qty (minor units) with amountMinor; metal (mg) compares
 *      costMinor; mg is never compared with money.
 */
import { isCalendarDate, addDays } from './calendar.js';

export const V6_TYPES = Object.freeze(['opening', 'income', 'refund', 'reconciliation']);
export const ACCOUNT_ROLES = Object.freeze(['bank', 'cash', 'other']);
export const REASON_MAX = 200;
const fail = (detail) => Object.assign(new Error(detail), { code: 'validation', detail });
const active = (r) => r && r.status !== 'void';
const isInt = (n) => Number.isSafeInteger(n);

// ---------------------------------------------------------------- accounts / balances
export const openingId = (walletId) => `op_${walletId}`;
/** S1: the opening movement fields (null when the opening balance is 0). */
export function openingFields(wallet, balanceMinor) {
  if (!wallet || !isCalendarDate(wallet.openingDate)) throw fail('finance.v6.openingDate');
  if (!isInt(balanceMinor)) throw fail('finance.validation.amountInvalid');
  if (balanceMinor === 0) return null;
  return { type: 'opening', amountMinor: Math.abs(balanceMinor), currency: wallet.currency, date: wallet.openingDate,
    fromWalletId: balanceMinor < 0 ? wallet.id : null, toWalletId: balanceMinor > 0 ? wallet.id : null };
}
/** F1: one sum. Wallets without openingDate (pre-V6) keep the V5 formula. */
export function accountBalance(wallet, { expenses = [], movements = [] }) {
  const id = wallet.id; const cut = isCalendarDate(wallet.openingDate) ? wallet.openingDate : null;
  const inRange = (r) => active(r) && (!cut || (typeof r.date === 'string' && r.date >= cut));
  let bal = 0;
  for (const mv of movements) {
    if (!inRange(mv)) continue;
    if (mv.toWalletId === id) bal += mv.amountMinor;
    if (mv.fromWalletId === id) bal -= mv.amountMinor;
  }
  for (const e of expenses) if (inRange(e) && e.walletId === id) bal -= e.amountMinor;
  return bal;
}
/** Household spendable = Σ active household Bank + Cash (private / personal excluded). */
export function spendable(wallets, data) {
  return wallets.filter((w) => w.active === true && w.visibility === 'household' && (w.role === 'bank' || w.role === 'cash'))
    .reduce((s, w) => s + accountBalance(w, data), 0);
}
/** A new record touching a wallet must not predate its opening (F1 guard). */
export function datedOk(wallet, date) { return !isCalendarDate(wallet.openingDate) || date >= wallet.openingDate; }
/** S4 / invariant 4: Visa debit only on a bank account. */
export function paymentOk(paymentMethod, wallet) { return paymentMethod !== 'debit_card' || (wallet && wallet.role === 'bank'); }

// ---------------------------------------------------------------- income / reconciliation
export function incomeFields({ wallet, amountMinor, date, today, source }) {
  if (!wallet || wallet.active !== true) throw fail('finance.validation.walletArchived');
  if (!isInt(amountMinor) || amountMinor <= 0) throw fail('finance.validation.amountInvalid');
  if (!isCalendarDate(date) || date > addDays(today, 1)) throw fail('finance.v6.incomeFuture');   // received only
  if (!datedOk(wallet, date)) throw fail('finance.v6.beforeOpening');
  const s = typeof source === 'string' ? source.trim() : '';
  if (s.length > 60) throw fail('finance.validation.tooLong');
  return { type: 'income', amountMinor, currency: wallet.currency, date, fromWalletId: null, toWalletId: wallet.id, source: s || null };
}
/** D5: reconciliation moves the balance only (never income, spending or budget). */
export function reconciliationFields({ wallet, appBalance, actualBalance, date, reason }) {
  if (!isInt(appBalance) || !isInt(actualBalance)) throw fail('finance.validation.amountInvalid');
  const d = actualBalance - appBalance;
  if (d === 0) return null;
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r || r.length > REASON_MAX) throw fail('finance.v6.reasonRequired');
  if (!datedOk(wallet, date)) throw fail('finance.v6.beforeOpening');
  return { type: 'reconciliation', amountMinor: Math.abs(d), currency: wallet.currency, date,
    fromWalletId: d < 0 ? wallet.id : null, toWalletId: d > 0 ? wallet.id : null, reason: r };
}
/** P&L whitelist: only expenses / income / refunds are spending or income. */
export function incomeTotal(movements, { from, toExclusive, householdOnly = true } = {}) {
  return movements.filter((m) => active(m) && m.type === 'income' && (!householdOnly || m.audience === 'household')
    && (!from || m.date >= from) && (!toExclusive || m.date < toExclusive)).reduce((s, m) => s + m.amountMinor, 0);
}

// ---------------------------------------------------------------- budget periods
export const periodId = (startDate) => `p_${startDate.replace(/-/g, '')}`;
export function validatePeriod({ startDate, endDateExclusive, capMinor }, head) {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDateExclusive) || endDateExclusive <= startDate) throw fail('finance.v6.periodDates');
  if (!isInt(capMinor) || capMinor < 0) throw fail('finance.validation.amountInvalid');
  if (head && startDate < head.endDateExclusive) throw fail('finance.v6.periodOverlap');
  return { startDate, endDateExclusive, capMinor };
}
export const periodFor = (periods, date) => periods.find((p) => p.startDate <= date && date < p.endDateExclusive) || null;
/** R1 / R2 attribution. `head` = budgetHead/primary (lastPeriodId). */
export function attribute(periods, head, date) {
  const p = periodFor(periods, date);
  if (!p) return { periodId: null, lateEntry: false };
  if (p.status !== 'closed') return { periodId: p.id, lateEntry: false };
  const cur = head && periods.find((x) => x.id === head.lastPeriodId && x.status !== 'closed');
  return { periodId: cur ? cur.id : null, lateEntry: true };
}
/** Close only after the period has ended in every time zone (rules use the same +12 h bound). */
export const canClose = (period, nowMs) => period.status !== 'closed' && nowMs >= Date.parse(`${period.endDateExclusive}T12:00:00Z`);
/** OD-3 (decided, batch 2): Zakat payments never consume the household budget (they still reduce the account balance). */
export const budgetEligible = (e) => !(String(e.id || '').startsWith('zk_') || e.category === 'zakat');
export function budgetStatus(period, { expenses = [], movements = [] }) {
  const exp = expenses.filter((e) => active(e) && e.periodId === period.id && e.audience === 'household' && budgetEligible(e))
    .reduce((s, e) => s + e.amountMinor, 0);
  const ref = movements.filter((m) => active(m) && m.type === 'refund' && m.periodId === period.id && m.audience === 'household')
    .reduce((s, m) => s + m.amountMinor, 0);
  const zakat = expenses.filter((e) => active(e) && e.periodId === period.id && e.audience === 'household' && !budgetEligible(e))
    .reduce((s, e) => s + e.amountMinor, 0);
  const spent = exp - ref;
  return { capMinor: period.capMinor, grossMinor: exp, refundsMinor: ref, spentMinor: spent, remainingMinor: period.capMinor - spent,
    overspent: spent > period.capMinor, excludedMinor: zakat };
}
/** Batch 2: an audited cap edit — period patch + create-only change record {periodId}_r{rev}, one batch. */
export function capChangePlan(period, { toMinor, reason }) {
  if (!period || period.status === 'closed') throw fail('finance.v6.periodClosed');
  if (!isInt(toMinor) || toMinor < 0) throw fail('finance.validation.amountInvalid');
  if (toMinor === period.capMinor) return null;
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r || r.length > REASON_MAX) throw fail('finance.v6.reasonRequired');
  const rev = period.rev + 1;
  return { id: `${period.id}_r${rev}`, periodPatch: { capMinor: toMinor, rev },
    change: { periodId: period.id, rev, fromMinor: period.capMinor, toMinor, reason: r } };
}
/** Batch 2: one budget model per Home — once V6 accounts or periods exist, wallet cycles are read-only history. */
export const v6Mode = ({ wallets = [], periods = [] }) => periods.length > 0 || wallets.some((w) => !!w.role);
/** Batch 2: closed periods are read-only — an expense attributed to one can't change money fields or be voided. */
export const periodLocked = (periods, periodId) => !!periodId && periods.some((p) => p.id === periodId && p.status === 'closed');
export function closingSnapshot(period, data) { const b = budgetStatus(period, data); return { capMinor: b.capMinor, spentMinor: b.spentMinor, remainingMinor: b.remainingMinor }; }

// ---------------------------------------------------------------- refunds (S3)
export const refundId = (expenseId, seq) => `${expenseId}_rf${seq}`;
export function refundPlan({ expense, ledger, amountMinor, date, attribution }) {
  if (!expense || !active(expense)) throw fail('finance.v6.refundVoided');
  if (!isInt(amountMinor) || amountMinor <= 0) throw fail('finance.validation.amountInvalid');
  if (!isCalendarDate(date) || date < expense.date) throw fail('finance.v6.refundDate');
  const seq = (ledger ? ledger.refundSeq : 0) + 1; const refunded = (ledger ? ledger.refundedMinor : 0) + amountMinor;
  if (refunded > expense.amountMinor) throw fail('finance.v6.refundTooLarge');
  return {
    id: refundId(expense.id, seq),
    movement: { type: 'refund', amountMinor, currency: expense.currency, date, fromWalletId: null, toWalletId: expense.walletId,
      refundOf: expense.id, refundSeq: seq, periodId: attribution.periodId, voidReason: null },
    ledger: { refundSeq: seq, refundedMinor: refunded, rev: (ledger ? ledger.rev : 0) + 1 },
    ledgerMode: ledger ? 'update' : 'set',
  };
}
export function refundVoidPlan({ refund, ledger, reason, periodOpen }) {
  if (!refund || refund.type !== 'refund' || !active(refund)) throw fail('finance.v6.refundNotActive');
  if (!ledger || refund.refundSeq !== ledger.refundSeq) throw fail('finance.v6.refundNotLatest');
  if (!periodOpen) throw fail('finance.v6.periodClosed');
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r || r.length > REASON_MAX) throw fail('finance.v6.reasonRequired');
  return { refundPatch: { status: 'void', voidReason: r }, ledger: { refundSeq: ledger.refundSeq, refundedMinor: ledger.refundedMinor - refund.amountMinor, rev: ledger.rev + 1 } };
}
/** Once refunded (ever), an expense's money fields are frozen; voiding needs no active refunds. */
export const expenseMoneyLocked = (ledger) => !!ledger && ledger.refundSeq > 0;
export const expenseVoidable = (ledger) => !ledger || ledger.refundedMinor === 0;

// ---------------------------------------------------------------- savings pairing (S2) — mirrors rules
export function savingsPairOk(ev, mv) {
  if (!ev || !mv || mv.type !== 'savings' || ev.transferId !== mv.savingsTransferId) return false;
  const dirOk = ev.type === 'transfer_in' ? (mv.fromWalletId === ev.walletId && mv.toWalletId == null)
    : ev.type === 'transfer_out' ? (mv.toWalletId === ev.walletId && mv.fromWalletId == null) : false;
  if (!dirOk) return false;
  if (ev.unit === 'minor') return ev.currency === mv.currency && ev.qty === (ev.type === 'transfer_in' ? mv.amountMinor : -mv.amountMinor) && ev.costMinor == null;
  if (ev.unit === 'mg') return ev.type === 'transfer_in' && ev.qty > 0 && ev.costMinor === mv.amountMinor && ev.costCurrency === mv.currency;   // never mg vs money
  return false;
}
