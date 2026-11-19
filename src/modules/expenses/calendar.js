/**
 * Calendar dates — PURE. Financial dates are 'YYYY-MM-DD' strings (date-only, no time zone),
 * the same philosophy as Devices. All arithmetic happens in UTC on the date itself, so a
 * date never shifts. "Today" is computed in the HOME's time zone.
 */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarDate(v) {
  const m = typeof v === 'string' && DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const toUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (s, n) => fromUtc(toUtc(s) + n * 86400000);
/** Whole days from a to b (b − a). */
export const diffDays = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
export const monthOf = (s) => s.slice(0, 7);
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Today's date in a time zone, e.g. 'Africa/Cairo'. */
export function todayIn(timeZone, now = new Date()) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function formatDateLong(s, locale, opts = {}) {
  if (!isCalendarDate(s)) return s || '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC', ...opts }).format(new Date(toUtc(s)));
}
export function formatDateShort(s, locale) {
  if (!isCalendarDate(s)) return s || '';
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(toUtc(s)));
}
export function formatMonth(ym, locale) {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
}
