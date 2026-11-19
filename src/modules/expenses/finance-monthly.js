/**
 * V6.2 — daily Finance, PURE. Months are the Home-local 'YYYY-MM' of the transaction's own `date`
 * (never createdAt). Monthly KPIs are household, budget-eligible spending (Zakat excluded) minus
 * refunds dated in that month. Balances are all-time and computed elsewhere (accountBalance).
 *
 * Monthly budget baseline: homes/{h}/financeMonthly/{YYYY-MM} = { budgetMinor|null, categoryLimits }.
 * A month without its own document INHERITS the latest earlier setting (a setting, not money: no
 * carry-forward of unspent amounts). Editing writes THAT month's document, so earlier months keep
 * their own stable denominator.
 */
import { budgetEligible } from './finance-v6.js';

const active = (x) => x && x.status !== 'void';
const household = (x) => x.audience === 'household';
export const monthOfDate = (d) => String(d || '').slice(0, 7);

/** The budget setting for a month: its own doc, else the latest earlier one (inherited), else none. */
export function effectiveMonthly(docs, ym) {
  const own = docs.find((d) => d.id === ym);
  if (own) return { ...own, inherited: false };
  const prev = docs.filter((d) => d.id < ym).sort((a, b) => b.id.localeCompare(a.id))[0];
  return prev ? { ...prev, inherited: true, inheritedFrom: prev.id } : { id: null, budgetMinor: null, categoryLimits: {}, inherited: false };
}

/** role of an account id among V6 accounts ('cash' | 'bank' | null). */
const roleOf = (accounts, id) => { const a = accounts.find((w) => w.id === id); return a ? a.role : null; };

/** Spending summary for a set of expense records (+ refunds of them) — used per month and per vacation. */
export function summarize(expenses, refunds, accounts) {
  const out = { totalMinor: 0, cashMinor: 0, bankMinor: 0, otherMinor: 0, byCategory: {}, count: 0 };
  const add = (cat, role, amt) => {
    out.totalMinor += amt; out.byCategory[cat] = (out.byCategory[cat] || 0) + amt;
    if (role === 'cash') out.cashMinor += amt; else if (role === 'bank') out.bankMinor += amt; else out.otherMinor += amt;
  };
  const byId = new Map(expenses.map((e) => [e.id, e]));
  for (const e of expenses) { out.count++; add(e.category, roleOf(accounts, e.walletId), e.amountMinor); }
  for (const r of refunds) { const e = byId.get(r.refundOf); add(e ? e.category : 'other', roleOf(accounts, r.toWalletId), -r.amountMinor); }
  return out;
}

/** Household, budget-eligible spending whose own date matches `pred` (and refunds dated likewise). */
export function selectSpending({ expenses = [], movements = [] }, pred) {
  const exp = expenses.filter((e) => active(e) && household(e) && budgetEligible(e) && pred(e.date));
  const all = new Map(expenses.map((e) => [e.id, e]));
  const refunds = movements.filter((m) => active(m) && m.type === 'refund' && household(m) && pred(m.date)
    && (!all.get(m.refundOf) || budgetEligible(all.get(m.refundOf))));
  return { exp, refunds, allExpenses: expenses };
}
export function monthStats(snap, accounts, ym) {
  const { exp, refunds, allExpenses } = selectSpending(snap, (d) => monthOfDate(d) === ym);
  const s = summarize(exp, [], accounts);
  // refunds may refer to an expense from an earlier month: resolve category against ALL expenses
  const byId = new Map(allExpenses.map((e) => [e.id, e]));
  for (const r of refunds) {
    const e = byId.get(r.refundOf); const cat = e ? e.category : 'other'; const role = roleOf(accounts, r.toWalletId);
    s.totalMinor -= r.amountMinor; s.byCategory[cat] = (s.byCategory[cat] || 0) - r.amountMinor;
    if (role === 'cash') s.cashMinor -= r.amountMinor; else if (role === 'bank') s.bankMinor -= r.amountMinor; else s.otherMinor -= r.amountMinor;
  }
  return s;
}

/** Progress against a baseline; null budget → no percentage (never divide by a balance). */
export function progress(spentMinor, budgetMinor) {
  if (!Number.isInteger(budgetMinor) || budgetMinor <= 0) return null;
  return { spentMinor, budgetMinor, pct: Math.round((spentMinor * 100) / budgetMinor), over: spentMinor > budgetMinor, remainingMinor: budgetMinor - spentMinor };
}
/**
 * V6.4 Dashboard tile: the CURRENT month's budget from the same authoritative selectors as the Monthly tab
 * (effectiveMonthly + monthStats: household, budget-eligible spending minus refunds, by each record's own
 * date). Never a wallet balance, never a 10-day / period budget. Pure integer minor units:
 *  - no budget (null / missing) → { hasBudget: false, spentMinor } — no percentage, no remaining
 *  - budget 0 → remaining = −spent, percentage null (no division by zero)
 *  - pct = round(spent / budget × 100), the REAL value (may exceed 100); fillPct is clamped to 0–100
 *    for the bar only; refunds larger than spending give spent < 0 → pct < 0 shown as 0 %, fill 0.
 */
export function monthBudget(snap, ym) {
  const spentMinor = monthStats(snap, [], ym).totalMinor;
  const setting = effectiveMonthly(snap.monthly || [], ym);
  const b = setting.budgetMinor;
  if (!Number.isInteger(b) || b < 0) return { ym, hasBudget: false, budgetMinor: null, spentMinor, remainingMinor: null, pct: null, fillPct: 0, over: false };
  const remainingMinor = b - spentMinor;
  const pct = b > 0 ? Math.max(0, Math.round((spentMinor * 100) / b)) : null;
  return { ym, hasBudget: true, budgetMinor: b, spentMinor, remainingMinor, pct, fillPct: pct === null ? (spentMinor > 0 ? 100 : 0) : Math.min(100, pct), over: spentMinor > b, inherited: !!setting.inherited };
}

/** Only categories WITH a configured limit (none → empty list, no empty bars). */
export function categoryProgress(stats, limits = {}) {
  return Object.entries(limits || {}).filter(([, v]) => Number.isInteger(v) && v > 0)
    .map(([cat, limit]) => ({ cat, ...progress(stats.byCategory[cat] || 0, limit) }))
    .sort((a, b) => b.pct - a.pct || a.cat.localeCompare(b.cat));
}

/** Newest first: date desc, then createdAt desc, then id (stable tie-break). */
export function newestFirst(list) {
  const ts = (x) => (x && x.createdAt && typeof x.createdAt.toMillis === 'function' ? x.createdAt.toMillis() : typeof x.createdAt === 'string' ? Date.parse(x.createdAt) || 0 : 0);
  return list.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || ts(b) - ts(a) || String(b.id).localeCompare(String(a.id)));
}
/** Transaction name = note (or merchant). Case-insensitive, across ALL loaded months. */
export const nameOf = (e) => e.note || e.merchant || '';
export function matchesName(e, q, catLabel = () => '') {
  const s = String(q || '').trim().toLowerCase(); if (!s) return true;
  return [nameOf(e), e.merchant, catLabel(e.category)].some((x) => x && String(x).toLowerCase().includes(s));
}
/**
 * History filters: text search spans ALL months; a work / vacation interval defines its OWN date range
 * (so a January vacation is found while viewing November); only with neither does the selected month
 * apply. Search and interval combine (search first, then the interval).
 * `cal`: null | { mode: 'work' | 'vacation', ivs: [{start,end}] }.
 */
export function historyRows(expenses, { q = '', ym, cal = null, catLabel } = {}) {
  const searching = String(q || '').trim() !== '';
  let rows = expenses.filter((e) => active(e) && (searching ? matchesName(e, q, catLabel) : cal ? true : monthOfDate(e.date) === ym));
  if (cal) rows = rows.filter((e) => cal.ivs.some((i) => i.start <= e.date && e.date <= i.end));
  return { rows: newestFirst(rows), scope: searching ? 'all' : cal ? 'interval' : 'month' };
}

/** Bills: due today or overdue (actionable), and upcoming within the selected month. */
export function bills(commitments, today, ym) {
  const live = commitments.filter((c) => c.active === true && c.nextDueDate);
  return {
    due: live.filter((c) => c.nextDueDate <= today).sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate)),
    upcoming: live.filter((c) => c.nextDueDate > today && monthOfDate(c.nextDueDate) <= ym).sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate)),
  };
}
export function shiftYm(ym, n) { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }
/** V6.2.1 History-tab narrowing (after historyRows): category and wallet ('all' = no filter). */
export function narrow(rows, { category = 'all', walletId = 'all' } = {}) {
  return rows.filter((e) => (!category || category === 'all' || e.category === category) && (!walletId || walletId === 'all' || e.walletId === walletId));
}
