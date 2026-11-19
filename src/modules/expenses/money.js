/**
 * Money — PURE. Every amount is stored and summed as an INTEGER number of minor units
 * (piastres for EGP: 12345 = 123.45 EGP). No binary floating point in any total.
 * Strings are parsed digit by digit, never through parseFloat.
 */
export const MAX_MINOR = 100000000000000; // 1e14 minor units (1e12 major), well within 2^53

/**
 * Parse user/CSV input into minor units. Accepts '1234', '1,234.5', '1 234.50', '٣٠٠' (Arabic
 * digits), '1234,50' only when unambiguous is NOT supported (decimal separator must be '.').
 * Returns { value } or { error }. '' → { value: null }.
 */
export function parseMinor(raw, { allowNegative = false, allowZero = true } = {}) {
  if (raw === null || raw === undefined) return { value: null };
  let s = typeof raw === 'number' ? numberToPlain(raw) : String(raw);
  s = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  s = s.replace(/[\s,_'’]/g, '').replace(/٫/g, '.');
  if (s === '') return { value: null };
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return { error: 'finance.validation.amountInvalid' };
  if (m[1] && !allowNegative) return { error: 'finance.validation.amountInvalid' };
  const minor = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) return { error: 'finance.validation.amountInvalid' };
  if (!allowZero && minor === 0) return { error: 'finance.validation.amountZero' };
  return { value: m[1] ? -minor : minor };
}

/** A JS number (e.g. from a JSON/CSV tool) to a plain decimal string without exponent. */
function numberToPlain(n) {
  if (!Number.isFinite(n)) return 'NaN';
  // Round to 2 decimals via string, not arithmetic accumulation.
  return n.toFixed(2);
}

export const isMinor = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_MINOR;

/** Minor → '1234.56' (for inputs). */
export function minorToPlain(minor) {
  if (!Number.isSafeInteger(minor)) return '';
  const neg = minor < 0; const a = Math.abs(minor);
  return `${neg ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export function sumMinor(values) {
  let s = 0;
  for (const v of values) if (Number.isSafeInteger(v)) s += v;
  return s;
}

/** Display only (Intl). The integer is converted once, at the very end. */
export function formatMoney(minor, currency, locale) {
  if (!Number.isSafeInteger(minor)) return '—';
  const major = minor / 100;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'EGP', minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(major);
  } catch {
    return `${minorToPlain(minor)} ${currency || ''}`.trim();
  }
}
