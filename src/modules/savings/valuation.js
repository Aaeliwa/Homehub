/**
 * Valuation — PURE. WHAT IS IT WORTH NOW?
 *
 * Prices are append-only QUOTES (homes/{h}/priceQuotes): { kind: 'metal'|'fx', key, priceMinor,
 * currency (valuation currency), source: 'manual'|<provider id>, observedAt (ms) }.
 *   metal key  'gold-21', 'gold-24', 'silver-999' …  priceMinor = valuation-currency minor per GRAM
 *   fx key     'USD'                                  priceMinor = valuation-currency minor per 1 USD
 * Quantities are never overwritten by prices; value = quantity × quote in effect.
 */
import { metalValue, fxValue, mulDiv } from './quantity.js';
import { PURITY_FRACTION, isMetal } from './savings-model.js';

export const FRESH_MS = 24 * 3600 * 1000; // a quote older than this is "stale"
export const metalKey = (metal, purity) => `${metal}-${purity}`;
export const quoteKeyFor = (asset, homeCurrency) => (isMetal(asset.type) ? metalKey(asset.type, asset.purity)
  : asset.currency && asset.currency !== homeCurrency ? asset.currency : null);

/** Latest quote for key observed at or before `atMs` (default: any). */
export function latestQuote(quotes, key, atMs = Infinity) {
  let best = null;
  for (const q of quotes) {
    if (q.key !== key || !(q.observedAt <= atMs)) continue;
    if (!best || q.observedAt > best.observedAt || (q.observedAt === best.observedAt && q.id > best.id)) best = q;
  }
  return best;
}

/**
 * A metal price for a purity: a direct quote, else DERIVED from the pure (24K / 999) quote by
 * fineness (clearly marked 'derived'). Never invented when neither exists.
 */
export function metalPrice(quotes, metal, purity, atMs = Infinity) {
  const direct = latestQuote(quotes, metalKey(metal, purity), atMs);
  const pureKey = metal === 'gold' ? '24' : '999';
  const pure = purity === pureKey ? null : latestQuote(quotes, metalKey(metal, pureKey), atMs);
  if (direct && (!pure || direct.observedAt >= pure.observedAt)) return { ...direct, derived: false };
  if (pure) {
    const [n, d] = PURITY_FRACTION[purity];
    return { ...pure, key: metalKey(metal, purity), priceMinor: mulDiv(pure.priceMinor, n, d), derived: true, derivedFrom: pure.key };
  }
  return null;
}

/** 'current' | 'stale' | 'unavailable'; source 'manual' is shown as Manual (never "Live"). */
export function freshness(quote, nowMs) {
  if (!quote) return 'unavailable';
  return nowMs - quote.observedAt <= FRESH_MS ? 'current' : 'stale';
}
export const isLive = (quote, nowMs) => !!quote && quote.source !== 'manual' && freshness(quote, nowMs) === 'current';

/**
 * Value of a quantity of an asset in the home currency.
 * Returns { valueMinor | null, quote | null, status: 'native'|'current'|'stale'|'unavailable' }.
 * Assets already in the home currency need no quote ('native').
 */
export function valueOf(asset, qty, quotes, { homeCurrency, atMs = Infinity, nowMs = Date.now() }) {
  if (!isMetal(asset.type) && (!asset.currency || asset.currency === homeCurrency)) return { valueMinor: qty, quote: null, status: 'native' };
  const quote = isMetal(asset.type) ? metalPrice(quotes, asset.type, asset.purity, atMs) : latestQuote(quotes, asset.currency, atMs);
  if (!quote) return { valueMinor: null, quote: null, status: 'unavailable' };
  const valueMinor = isMetal(asset.type) ? metalValue(qty, quote.priceMinor) : fxValue(qty, quote.priceMinor);
  return { valueMinor, quote, status: atMs === Infinity ? freshness(quote, nowMs) : 'current' };
}

/**
 * Total of VISIBLE assets only (the caller passes what the member can read).
 * Unvalued assets are listed separately — never silently counted as 0.
 */
export function portfolio(assets, balances, quotes, opts) {
  const byType = {}; const unvalued = []; let total = 0; let stale = false;
  for (const a of assets) {
    if (a.active !== true) continue;
    const qty = balances[a.id] || 0;
    const v = valueOf(a, qty, quotes, opts);
    if (v.valueMinor === null) { unvalued.push(a); continue; }
    if (v.status === 'stale') stale = true;
    total += v.valueMinor;
    byType[a.type] = (byType[a.type] || 0) + v.valueMinor;
  }
  return { totalMinor: total, byType, unvalued, stale };
}

export function buildQuote({ kind, key, price, currency, uid, nowMs, now, source = 'manual', note = null }) {
  return { kind, key, priceMinor: price, currency, source, observedAt: nowMs, note, createdBy: uid, createdAt: now, schemaVersion: 1 };
}
