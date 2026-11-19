/**
 * Hijri (Umm al-Qura) helpers — PURE, deterministic, no network.
 * Uses Intl's 'islamic-umalqura' calendar (ICU). Hawl completion = the same Hijri day/month
 * one Hijri year later (≈354–355 days). If the runtime lacks the calendar, falls back to a
 * documented 354-day lunar year.
 */
import { addDays, diffDays } from '../expenses/calendar.js';
import { advance } from '../expenses/recurrence.js';

const FMT = (() => { try { return new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' }); } catch { return null; } })();
export const LUNAR_YEAR_DAYS = 354;
export const hasHijri = () => !!FMT && /\d/.test(FMT.format(new Date(0)));

export function toHijri(date) {
  if (!hasHijri()) return null;
  const [y, m, d] = date.split('-').map(Number);
  const p = Object.fromEntries(FMT.formatToParts(new Date(Date.UTC(y, m - 1, d))).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(String(x.value).replace(/\D/g, ''))]));
  return { year: p.year, month: p.month, day: p.day };
}

/** Gregorian date of the same Hijri day one lunar year later (day 30 → last day of month). */
export function addHijriYear(date) {
  const h = toHijri(date);
  if (!h) return { date: addDays(date, LUNAR_YEAR_DAYS), method: 'approx354' };
  let best = null;
  for (let i = 350; i <= 360; i++) {
    const c = addDays(date, i); const ch = toHijri(c);
    if (ch.year === h.year + 1 && ch.month === h.month) {
      if (ch.day === h.day) return { date: c, method: 'umalqura' };
      if (ch.day < h.day) best = c; // month shorter than original day → its last day
    }
  }
  return { date: best || addDays(date, LUNAR_YEAR_DAYS), method: best ? 'umalqura' : 'approx354' };
}

export function hawlEnd(date, calendar) {
  if (calendar === 'gregorian') return { date: advance(date, { unit: 'year', interval: 1 }, Number(date.slice(8, 10))), method: 'gregorian' };
  return addHijriYear(date);
}
export { diffDays };

export function formatHijri(date, locale) {
  try {
    const [y, m, d] = date.split('-').map(Number);
    return new Intl.DateTimeFormat(`${locale}-u-ca-islamic-umalqura`, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  } catch { return ''; }
}
