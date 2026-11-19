/**
 * Generic recurrence engine — PURE. A rule is { unit: 'day'|'week'|'month'|'year', interval }.
 * Covers weekly, every 2 weeks, monthly, quarterly (3 months), semiannual (6), annual (12 months
 * or 1 year), every 2 years, and custom intervals. Month/year steps keep the ANCHOR day
 * (Jan 31 → Feb 28/29 → Mar 31), so dates never drift.
 */
import { addDays, daysInMonth, isCalendarDate } from './calendar.js';

export const RECURRENCE_UNITS = Object.freeze(['day', 'week', 'month', 'year']);
export const MAX_INTERVAL = 36;

/** Presets offered in the UI (prefill only). */
export const RECURRENCE_PRESETS = Object.freeze({
  weekly: { unit: 'week', interval: 1 },
  biweekly: { unit: 'week', interval: 2 },
  monthly: { unit: 'month', interval: 1 },
  quarterly: { unit: 'month', interval: 3 },
  semiannual: { unit: 'month', interval: 6 },
  annual: { unit: 'year', interval: 1 },
  biennial: { unit: 'year', interval: 2 },
});

export function isRecurrence(r) {
  return !!r && RECURRENCE_UNITS.includes(r.unit) && Number.isInteger(r.interval) && r.interval >= 1 && r.interval <= MAX_INTERVAL;
}

export function presetOf(r) {
  for (const [k, v] of Object.entries(RECURRENCE_PRESETS)) if (r && v.unit === r.unit && v.interval === r.interval) return k;
  return 'custom';
}

/** Next due date after `date`. anchorDay = the commitment's original day of month (1–31). */
export function advance(date, rule, anchorDay) {
  if (!isCalendarDate(date) || !isRecurrence(rule)) throw new TypeError('advance: invalid input');
  if (rule.unit === 'day') return addDays(date, rule.interval);
  if (rule.unit === 'week') return addDays(date, 7 * rule.interval);
  const [y, m] = date.split('-').map(Number);
  const months = rule.unit === 'month' ? rule.interval : 12 * rule.interval;
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12); const nm = (total % 12) + 1;
  const day = Math.min(anchorDay || Number(date.slice(8, 10)), daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Occurrences per year (exact rational kept as numerator/denominator to avoid float drift). */
export function perYear(rule) {
  if (rule.unit === 'year') return { n: 1, d: rule.interval };
  if (rule.unit === 'month') return { n: 12, d: rule.interval };
  if (rule.unit === 'week') return { n: 52, d: rule.interval };
  return { n: 365, d: rule.interval };
}

/**
 * Suggested monthly reserve for a commitment (Phase-5/sinking-fund ready):
 * amount × occurrences-per-year ÷ 12, rounded to the nearest minor unit.
 * e.g. 12,000 EGP yearly → 1,000 EGP/month.
 */
export function monthlyReserveMinor(amountMinor, rule) {
  const { n, d } = perYear(rule);
  return Math.round((amountMinor * n) / (12 * d));
}
