/**
 * Ledger calculations — PURE. All sums are integer minor units.
 *
 * Counting rules (the heart of "no double counting"):
 *   spending  = Σ ACTIVE expenses (void excluded). Movements are NEVER spending.
 *   income    = not modelled as a total in Phase 4 (funding is a wallet movement, not income).
 *   balance(w)= Σ movements into w − Σ movements out of w − Σ active expenses paid from w.
 */
import { sumMinor } from './money.js';
import { addDays, diffDays, monthOf } from './calendar.js';

const isActive = (r) => (r.status ?? 'active') !== 'void';

/** createdAt → sortable millis whatever its shape (Timestamp, {seconds}, ISO string, missing). */
export function createdMillis(r) {
  const c = r && r.createdAt;
  if (!c) return 0;
  if (typeof c.toMillis === 'function') return c.toMillis();
  if (typeof c.seconds === 'number') return c.seconds * 1000 + Math.floor((c.nanoseconds || 0) / 1e6);
  const t = Date.parse(c);
  return Number.isNaN(t) ? 0 : t;
}

/** History order: NEWEST transaction date first, then newest createdAt, then id (deterministic). */
export function compareHistory(a, b) {
  if (a.date !== b.date) return (a.date || '') < (b.date || '') ? 1 : -1;
  const d = createdMillis(b) - createdMillis(a);
  if (d) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
export const sortHistory = (expenses) => [...expenses].sort(compareHistory);

/** Group an already-sorted list by date: [{ date, relative: 'today'|'yesterday'|null, items, totalMinor }]. */
export function groupByDate(sorted, today) {
  const groups = [];
  for (const e of sorted) {
    let g = groups.at(-1);
    if (!g || g.date !== e.date) {
      g = { date: e.date, relative: e.date === today ? 'today' : e.date === addDays(today, -1) ? 'yesterday' : null, items: [], totalMinor: 0 };
      groups.push(g);
    }
    g.items.push(e);
    if (isActive(e)) g.totalMinor += e.amountMinor || 0;
  }
  return groups;
}

export const isFixed = (e) => !!e.commitmentId;

export function spendingTotals(expenses, { month } = {}) {
  const list = expenses.filter((e) => isActive(e) && (!month || monthOf(e.date || '') === month));
  const fixed = sumMinor(list.filter(isFixed).map((e) => e.amountMinor));
  const total = sumMinor(list.map((e) => e.amountMinor));
  const byCategory = {};
  for (const e of list) byCategory[e.category || 'other'] = (byCategory[e.category || 'other'] || 0) + e.amountMinor;
  return { totalMinor: total, fixedMinor: fixed, variableMinor: total - fixed, count: list.length, byCategory };
}

export function monthlyTotals(expenses) {
  const m = {};
  for (const e of expenses) if (isActive(e) && e.date) m[monthOf(e.date)] = (m[monthOf(e.date)] || 0) + e.amountMinor;
  return m;
}

export function walletBalance(walletId, { expenses, movements }) {
  let bal = 0;
  for (const mv of movements) {
    if (!isActive(mv)) continue;
    if (mv.toWalletId === walletId) bal += mv.amountMinor;
    if (mv.fromWalletId === walletId) bal -= mv.amountMinor;
  }
  for (const e of expenses) if (isActive(e) && e.walletId === walletId) bal -= e.amountMinor;
  return bal;
}

/**
 * Cycle statistics.
 *   available  = budget + carryIn
 *   spent      = Σ active expenses linked to the cycle
 *   adjustment = Σ reconciliation adjustments tagged to the cycle (in − out)
 *   remaining  = available − spent + adjustment
 *   pace       = spent − available × elapsedDays / days   (negative = under pace)
 *   safePerDay = remaining / daysRemaining (today counts as a remaining day)
 */
export function cycleStats(cycle, { expenses, movements }, today) {
  const available = (cycle.budgetMinor || 0) + (cycle.carryInMinor || 0);
  const spent = sumMinor(expenses.filter((e) => isActive(e) && e.budgetCycleId === cycle.id).map((e) => e.amountMinor));
  let adjustment = 0;
  for (const mv of movements) {
    if (!isActive(mv) || mv.cycleId !== cycle.id || mv.type !== 'adjustment') continue;
    adjustment += mv.toWalletId ? mv.amountMinor : -mv.amountMinor;
  }
  const remaining = available - spent + adjustment;
  const days = cycle.days || diffDays(cycle.startDate, cycle.endDate) + 1;
  const elapsedDays = Math.min(days, Math.max(0, diffDays(cycle.startDate, today) + 1));
  const daysRemaining = Math.max(0, diffDays(today, cycle.endDate) + 1);
  const target = Math.round((available * elapsedDays) / days);
  const pace = spent - target;
  const safePerDay = daysRemaining > 0 ? Math.floor(Math.max(0, remaining) / daysRemaining) : 0;
  const phase = today < cycle.startDate ? 'upcoming' : today > cycle.endDate ? 'ended' : 'running';
  return { availableMinor: available, spentMinor: spent, adjustmentMinor: adjustment, remainingMinor: remaining,
    days, elapsedDays, daysRemaining, targetMinor: target, paceMinor: pace, safePerDayMinor: safePerDay, phase };
}

/** Expected cash for reconciliation = remaining in the cycle (what should physically be left). */
export function reconciliation(expectedMinor, actualMinor) {
  return { expectedMinor, actualMinor, differenceMinor: actualMinor - expectedMinor };
}

/** The cycle (if any) an expense on `date` in `walletId` belongs to: an ACTIVE cycle covering the date. */
export function cycleFor(cycles, walletId, date) {
  return cycles.find((c) => c.status === 'active' && c.walletId === walletId && date >= c.startDate && date <= c.endDate) || null;
}

/** Upcoming commitments within `horizonDays` (overdue ones included first). Not transactions. */
export function upcoming(commitments, today, horizonDays = 120) {
  const limit = addDays(today, horizonDays);
  return commitments.filter((c) => c.active === true && c.nextDueDate && c.nextDueDate <= limit)
    .sort((a, b) => (a.nextDueDate < b.nextDueDate ? -1 : a.nextDueDate > b.nextDueDate ? 1 : String(a.name).localeCompare(String(b.name))))
    .map((c) => ({ ...c, overdue: c.nextDueDate < today, daysUntil: diffDays(today, c.nextDueDate) }));
}

/**
 * History filters (client-side over the loaded, permitted records).
 * f = { query, from, to, category, walletId ('all'|'none'|id), createdBy, paymentMethod, kind ('all'|'fixed'|'variable'), cycleId, showVoid }
 */
export function filterHistory(expenses, f = {}) {
  const q = (f.query || '').trim().toLowerCase();
  return expenses.filter((e) => (f.showVoid || isActive(e))
    && (!f.from || e.date >= f.from) && (!f.to || e.date <= f.to)
    && (!f.category || f.category === 'all' || e.category === f.category)
    && (!f.walletId || f.walletId === 'all' || (f.walletId === 'none' ? !e.walletId : e.walletId === f.walletId))
    && (!f.createdBy || f.createdBy === 'all' || (e.source !== 'import' && e.createdBy === f.createdBy))
    && (!f.paidBy || f.paidBy === 'all' || e.paidBy === f.paidBy)
    && (!f.paymentMethod || f.paymentMethod === 'all' || (e.paymentMethod || 'unknown') === f.paymentMethod)
    && (!f.kind || f.kind === 'all' || (f.kind === 'fixed' ? isFixed(e) : !isFixed(e)))
    && (!f.cycleId || f.cycleId === 'all' || e.budgetCycleId === f.cycleId)
    && (!q || [e.note, e.merchant, e.importedCategory, e.category].some((x) => String(x || '').toLowerCase().includes(q))));
}
