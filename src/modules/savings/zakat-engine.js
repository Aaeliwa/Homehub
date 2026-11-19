/**
 * Zakat al-Mal engine — PURE. A calculation ASSISTANT based on the owner's SELECTED
 * methodology; it never issues a ruling. Nothing here is hard-coded as universal truth:
 * every threshold, rate, calendar and policy comes from the profile.
 *
 *   - Per OWNER: an owner's own included assets + their explicit allocation share of
 *     household/shared assets. Other people's private wealth is never combined.
 *   - Nisab: gold (default 85 g of 21K, Egypt-oriented, configurable) | silver (595 g) | manual.
 *   - Hawl: reconstructed from HISTORY (events + price quotes), not from today's balance.
 *       policy 'reset'    — falling below Nisab ends the Hawl; it restarts when Nisab is reached again.
 *       policy 'continue' — dips below Nisab during the year do not end it (only start/end
 *                           are tested); it ends if wealth reaches zero.
 *   - Rate in basis points (default 250 = 2.5 %), applied once, transparently.
 */
import { addDays, diffDays } from '../expenses/calendar.js';
import { applyBps, mulDiv } from './quantity.js';
import { balanceOf } from './savings-model.js';
import { valueOf, metalPrice, latestQuote, freshness } from './valuation.js';
import { hawlEnd } from './hijri.js';

export const NISAB_BASES = Object.freeze(['gold', 'silver', 'manual']);
export const HAWL_CALENDARS = Object.freeze(['hijri', 'gregorian']);
export const BELOW_POLICIES = Object.freeze(['reset', 'continue']);

/** Defaults offered to the intended Egyptian user — LABELLED as a selectable methodology. */
export const DEFAULT_PROFILE = Object.freeze({
  nisabBasis: 'gold', goldMg: 85000, goldPurity: '21', silverMg: 595000, silverPurity: '999',
  manualNisabMinor: null, rateBps: 250, hawlCalendar: 'hijri', belowNisabPolicy: 'reset',
  methodologyNote: null,
});

export function validateProfile(p) {
  const errors = {};
  if (!NISAB_BASES.includes(p.nisabBasis)) errors.nisabBasis = 'savings.validation.invalid';
  if (!Number.isSafeInteger(p.goldMg) || p.goldMg <= 0) errors.goldMg = 'savings.validation.gramsInvalid';
  if (!Number.isSafeInteger(p.silverMg) || p.silverMg <= 0) errors.silverMg = 'savings.validation.gramsInvalid';
  if (!['24', '22', '21', '18'].includes(String(p.goldPurity))) errors.goldPurity = 'savings.validation.purityInvalid';
  if (p.nisabBasis === 'manual' && !(Number.isSafeInteger(p.manualNisabMinor) && p.manualNisabMinor > 0)) errors.manualNisabMinor = 'savings.validation.amountRequired';
  if (!(Number.isInteger(p.rateBps) && p.rateBps > 0 && p.rateBps <= 10000)) errors.rateBps = 'savings.validation.rateInvalid';
  if (!HAWL_CALENDARS.includes(p.hawlCalendar)) errors.hawlCalendar = 'savings.validation.invalid';
  if (!BELOW_POLICIES.includes(p.belowNisabPolicy)) errors.belowNisabPolicy = 'savings.validation.invalid';
  return errors;
}

const msToDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const endOfDay = (date) => Date.parse(`${date}T23:59:59.999Z`);

/** Nisab value at a date. Returns { valueMinor | null, quote, basis, grams, purity, status }. */
export function nisabAt(profile, quotes, date, nowMs = Date.now()) {
  if (profile.nisabBasis === 'manual') return { basis: 'manual', valueMinor: profile.manualNisabMinor, quote: null, status: 'manual' };
  const metal = profile.nisabBasis;
  const mg = metal === 'gold' ? profile.goldMg : profile.silverMg;
  const purity = metal === 'gold' ? profile.goldPurity : profile.silverPurity;
  const q = metalPrice(quotes, metal, purity, date ? endOfDay(date) : Infinity);
  if (!q) return { basis: metal, mg, purity, valueMinor: null, quote: null, status: 'unavailable' };
  return { basis: metal, mg, purity, valueMinor: mulDiv(mg, q.priceMinor, 1000), quote: q, status: date ? 'current' : freshness(q, nowMs) };
}

/** The owner's share of each asset (bps) — explicit only. Excluded assets carry a reason. */
export function ownerHoldings(ownerUid, assets) {
  const included = []; const excluded = [];
  for (const a of assets) {
    if (a.active !== true) continue;
    const mine = a.scope === 'personal' && a.ownerUid === ownerUid;
    const alloc = (a.allocations || []).find((x) => x.uid === ownerUid);
    if (!mine && !alloc && !(a.scope === 'home')) continue; // someone else's personal asset: not ours, not listed
    if (!mine && !alloc) { if (a.zakatTreatment === 'included') excluded.push({ asset: a, reason: 'noAllocation' }); continue; }
    if (a.zakatTreatment !== 'included') { excluded.push({ asset: a, reason: 'markedExcluded' }); continue; }
    included.push({ asset: a, bps: mine ? 10000 : alloc.bps });
  }
  return { included, excluded };
}

function wealthAt(holdings, events, quotes, date, homeCurrency) {
  let total = 0; const lines = []; const unvalued = [];
  for (const { asset, bps } of holdings) {
    const qty = balanceOf(asset.id, events, date);
    const v = valueOf(asset, qty, quotes, { homeCurrency, atMs: endOfDay(date) });
    if (v.valueMinor === null) { if (qty) unvalued.push(asset); continue; }
    const share = applyBps(v.valueMinor, bps);
    total += share;
    lines.push({ asset, bps, qty, valueMinor: v.valueMinor, shareMinor: share, quote: v.quote });
  }
  return { total, lines, unvalued };
}

/**
 * Full assessment for one owner as of `today`.
 * Change points = every relevant event date + every relevant quote date + today.
 */
export function assess({ ownerUid, profile: rawProfile, assets, events, quotes, today, homeCurrency = 'EGP', nowMs = Date.now() }) {
  const profile = { ...DEFAULT_PROFILE, ...(rawProfile || {}) };
  const { included, excluded } = ownerHoldings(ownerUid, assets);
  const ids = new Set(included.map((h) => h.asset.id));
  const evs = events.filter((e) => ids.has(e.assetId) && (e.status ?? 'active') === 'active');
  const points = new Set([today]);
  for (const e of evs) if (e.date <= today) points.add(e.date);
  for (const q of quotes) { const d = msToDate(q.observedAt); if (d <= today) points.add(d); }
  const dates = [...points].sort();

  // Walk history; build Hawl cycles.
  const series = dates.map((d) => {
    const w = wealthAt(included, evs, quotes, d, homeCurrency);
    const n = nisabAt(profile, quotes, d, nowMs);
    const state = n.valueMinor === null ? 'unknown' : w.total >= n.valueMinor ? 'above' : 'below';
    return { date: d, wealth: w.total, nisab: n.valueMinor, state };
  });

  let start = null; const completed = []; let unknownSeen = false;
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    if (p.state === 'unknown') { unknownSeen = true; continue; }
    // Complete any cycles whose end falls on or before this point.
    while (start) {
      const end = hawlEnd(start, profile.hawlCalendar).date;
      if (end > p.date) break;
      const atEnd = series.filter((x) => x.date <= end).at(-1);
      completed.push({ start, end, wealthAtEnd: atEnd ? atEnd.wealth : 0, nisabAtEnd: atEnd ? atEnd.nisab : null, aboveAtEnd: !!atEnd && atEnd.state === 'above' });
      start = atEnd && atEnd.state === 'above' ? end : null;
    }
    if (p.state === 'above' && !start) start = p.date;
    if (p.state === 'below' && start && (profile.belowNisabPolicy === 'reset' || p.wealth <= 0)) start = null;
  }

  const nisabNow = nisabAt(profile, quotes, null, nowMs);
  const current = wealthAt(included, evs, quotes, today, homeCurrency);
  // A completed Hawl that ended ABOVE Nisab: Zakat may be due on the wealth AT ITS END.
  const lastDue = completed.filter((c) => c.aboveAtEnd).at(-1) || null;
  let due = null;
  if (lastDue) {
    const atEnd = wealthAt(included, evs, quotes, lastDue.end, homeCurrency);
    due = { start: lastDue.start, end: lastDue.end, zakatableMinor: atEnd.total, nisabMinor: lastDue.nisabAtEnd,
      estimateMinor: applyBps(atEnd.total, profile.rateBps), lines: atEnd.lines };
  }
  const status = nisabNow.valueMinor === null ? 'unknown' : due ? 'complete' : start ? 'inProgress' : 'belowNisab';
  const end = start ? hawlEnd(start, profile.hawlCalendar) : null;
  const zakatable = current.total;
  return {
    ownerUid, profile, status,
    hawlStart: start, hawlEnd: end ? end.date : null, hawlMethod: end ? end.method : null,
    daysElapsed: start ? diffDays(start, today) : 0, daysTotal: end ? diffDays(start, end.date) : 0,
    nisab: nisabNow, aboveNisab: nisabNow.valueMinor !== null && zakatable >= nisabNow.valueMinor,
    breakdown: current.lines, unvalued: current.unvalued, excluded,
    zakatableMinor: zakatable, rateBps: profile.rateBps,
    estimateMinor: nisabNow.valueMinor !== null && zakatable >= nisabNow.valueMinor ? applyBps(zakatable, profile.rateBps) : 0,
    completedCycles: completed, due, historyIncomplete: unknownSeen, series,
  };
}

export { addDays };
