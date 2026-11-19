/**
 * Quantities & precision — PURE.
 *   money      integer MINOR units of its currency (EGP piastres, USD cents) — same as Finance
 *   metal      integer MILLIGRAMS (0.001 g)
 *   metal price  integer minor units of the valuation currency PER GRAM
 *   FX rate    integer minor units of the valuation currency PER 1 WHOLE unit of the foreign currency
 * Products use BigInt and round half-up once, at the end.
 */
import { parseMinor } from '../expenses/money.js';

export { parseMinor };
export const MAX_MG = 1000000000000; // 1,000 tonnes — far beyond any household

/** '50', '12.345', '٥٠' → milligrams. */
export function parseGrams(raw) {
  if (raw === null || raw === undefined) return { value: null };
  let s = String(raw).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[\s,_]/g, '').replace(/٫/g, '.');
  if (s === '') return { value: null };
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return { error: 'savings.validation.gramsInvalid' };
  const mg = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
  if (!Number.isSafeInteger(mg) || mg > MAX_MG) return { error: 'savings.validation.gramsInvalid' };
  return { value: mg };
}

export function mgToPlain(mg) {
  const neg = mg < 0; const a = Math.abs(mg);
  const frac = String(a % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${Math.trunc(a / 1000)}${frac ? `.${frac}` : ''}`;
}

/** round(a × b / d) half-up, exact for any safe-integer inputs. */
export function mulDiv(a, b, d) {
  const n = BigInt(a) * BigInt(b);
  const D = BigInt(d);
  const neg = (n < 0n) !== (D < 0n);
  const an = n < 0n ? -n : n; const ad = D < 0n ? -D : D;
  const q = (an * 2n + ad) / (ad * 2n); // half-up
  return Number(neg ? -q : q);
}

/** Value (minor units of valuation currency) of metal mg at price-per-gram minor. */
export const metalValue = (mg, pricePerGramMinor) => mulDiv(mg, pricePerGramMinor, 1000);
/** Value of foreign money (minor units of its own currency, 2 decimals) at a rate per whole unit. */
export const fxValue = (qtyMinor, rateMinorPerUnit) => mulDiv(qtyMinor, rateMinorPerUnit, 100);
/** basis points: 250 = 2.5 %. */
export const applyBps = (minor, bps) => mulDiv(minor, bps, 10000);
