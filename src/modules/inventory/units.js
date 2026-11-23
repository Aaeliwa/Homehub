/**
 * Pantry units (V6.5 Phase 01) — PURE, integer-only.
 *
 * Every authoritative quantity is an integer number of MILLI base units:
 *   count  → base unit 'piece' : 1 piece = 1,000 milli-pieces   (pieces are WHOLE: multiples of 1,000 only)
 *   mass   → base unit 'g'     : 1 g = 1,000 milli-grams, 1 kg = 1,000,000 milli-grams
 *   volume → base unit 'ml'    : 1 ml = 1,000 milli-litres-of-ml, 1 l = 1,000,000
 * A user-facing quantity ("1.5 kg") is parsed from its decimal TEXT (never through floating point) into base
 * milli-units; display divides by the unit factor with integer arithmetic. Only same-dimension conversions
 * exist (no density, no cup / spoon guesses). Bounded: 0 ≤ value ≤ MAX_BASE_MILLI.
 */
export const DIMENSIONS = Object.freeze(['count', 'mass', 'volume']);
/** milli-base-units per ONE user unit. */
export const UNITS = Object.freeze({
  piece: Object.freeze({ dim: 'count', perUnit: 1000 }),
  g: Object.freeze({ dim: 'mass', perUnit: 1000 }),
  kg: Object.freeze({ dim: 'mass', perUnit: 1000000 }),
  ml: Object.freeze({ dim: 'volume', perUnit: 1000 }),
  l: Object.freeze({ dim: 'volume', perUnit: 1000000 }),
});
export const BASE_UNIT = Object.freeze({ count: 'piece', mass: 'g', volume: 'ml' });
/** 10^12 milli-base: one million kg / litres, one billion pieces. Far below Number.MAX_SAFE_INTEGER (9·10^15). */
export const MAX_BASE_MILLI = 1000000000000;
const DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };

const fail = (detail) => Object.assign(new Error(detail), { code: 'validation', detail });
export const isUnit = (u) => typeof u === 'string' && Object.prototype.hasOwnProperty.call(UNITS, u);
export const isDimension = (d) => DIMENSIONS.includes(d);
export const dimensionOf = (u) => (isUnit(u) ? UNITS[u].dim : null);
export const unitsFor = (dim) => Object.keys(UNITS).filter((u) => UNITS[u].dim === dim);
export const unitFits = (dim, u) => isDimension(dim) && dimensionOf(u) === dim;
export const isWholeOnly = (u) => dimensionOf(u) === 'count';
/** A valid stored base amount for a dimension (bounded integer; whole pieces for count). */
export function isBaseMilli(v, dim) {
  return Number.isSafeInteger(v) && v >= 0 && v <= MAX_BASE_MILLI && (dim !== 'count' || v % 1000 === 0);
}

/**
 * Parse a user quantity typed in `unit` into base milli-units.
 * Accepts Western / Arabic-Indic digits, '.', '٫' or ',' as the decimal mark, up to the unit's precision
 * (kg / l: 6 decimals = 1 milli-g / milli-ml; g / ml: 3 decimals; piece: whole numbers only).
 * Throws pantry.err.amount (shape), .wholePieces, .tooLarge, .positive (0 when !allowZero), .unit.
 */
export function parseQuantity(text, unit, { allowZero = false } = {}) {
  if (!isUnit(unit)) throw fail('pantry.err.unit');
  let s = typeof text === 'number' ? String(text) : typeof text === 'string' ? text : '';
  s = s.trim().replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d]).replace(/[٫,]/g, '.');
  if (!/^\d{1,13}(\.\d+)?$/.test(s)) throw fail('pantry.err.amount');
  const [whole, frac = ''] = s.split('.');
  const scale = String(UNITS[unit].perUnit).length - 1;          // decimals representable exactly in milli-base
  if (frac.replace(/0+$/, '').length > scale) throw fail(isWholeOnly(unit) ? 'pantry.err.wholePieces' : 'pantry.err.precision');
  if (isWholeOnly(unit) && /[1-9]/.test(frac)) throw fail('pantry.err.wholePieces');
  const fracDigits = (frac + '0'.repeat(scale)).slice(0, scale);
  // whole × perUnit + fraction, all in integers (whole ≤ 13 digits × ≤ 10^6 → < 2^53 is checked below)
  const big = BigInt(whole) * BigInt(UNITS[unit].perUnit) + BigInt(fracDigits || '0');
  if (big > BigInt(MAX_BASE_MILLI)) throw fail('pantry.err.tooLarge');
  const v = Number(big);
  if (v === 0 && !allowZero) throw fail('pantry.err.positive');
  return v;
}

/** Same-dimension conversion of base milli into a decimal STRING in `unit` (exact, trailing zeros trimmed). */
export function formatQuantity(baseMilli, unit) {
  if (!isUnit(unit)) throw fail('pantry.err.unit');
  if (!Number.isSafeInteger(baseMilli) || baseMilli < 0) throw fail('pantry.err.amount');
  const per = UNITS[unit].perUnit; const scale = String(per).length - 1;
  const whole = Math.floor(baseMilli / per); const rem = baseMilli % per;
  if (!rem) return String(whole);
  return `${whole}.${String(rem).padStart(scale, '0').replace(/0+$/, '')}`;
}
/**
 * Convert between two units of the SAME dimension, as base milli (unchanged) — the dimension check is the point:
 * cross-dimension conversion (piece ↔ g, g ↔ ml) is refused.
 */
export function convertible(fromUnit, toUnit) { return isUnit(fromUnit) && isUnit(toUnit) && UNITS[fromUnit].dim === UNITS[toUnit].dim; }
export function assertConvertible(fromUnit, toUnit) { if (!convertible(fromUnit, toUnit)) throw fail('pantry.err.dimension'); return true; }
/** "1.5 kg" style label parts for display; the unit label itself is translated by the caller. */
export const quantityParts = (baseMilli, unit) => ({ value: formatQuantity(baseMilli, unit), unit });
