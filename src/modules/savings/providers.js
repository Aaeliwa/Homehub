/**
 * Price providers — replaceable. A provider returns NORMALISED quotes:
 *   { kind, key, priceMinor, currency, observedAt, source, status: 'ok'|'error', error? }
 *
 * Shipped providers:
 *   manual  — the household's own audited quotes (always available).
 *   http    — calls a SERVER endpoint YOU deploy (e.g. a Cloud Function holding any API key).
 *             Disabled until `PRICE_ENDPOINT` is configured. No API key ever lives in the client.
 *
 * Never: scraping websites from the browser, LLM output as a price source, fabricated
 * "live" prices. A provider failure (timeout, network, bad payload, rate limit) yields
 * status 'error' and the UI falls back to the latest manual/last-known quote.
 */
export const PRICE_ENDPOINT = null; // e.g. 'https://<region>-<project>.cloudfunctions.net/prices' — REQUIRES PROVIDER CONFIGURATION

const REQUIRED = ['kind', 'key', 'priceMinor', 'currency', 'observedAt'];
export function validateQuotePayload(q) {
  return !!q && REQUIRED.every((k) => q[k] !== undefined && q[k] !== null)
    && ['metal', 'fx'].includes(q.kind) && typeof q.key === 'string'
    && Number.isSafeInteger(q.priceMinor) && q.priceMinor > 0
    && /^[A-Z]{3}$/.test(q.currency) && Number.isFinite(q.observedAt);
}

export function createHttpProvider({ endpoint = PRICE_ENDPOINT, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  return Object.freeze({
    id: 'http',
    configured: !!endpoint,
    async fetchQuotes(keys) {
      if (!endpoint) return { status: 'unconfigured', quotes: [] };
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      try {
        const res = await fetchImpl(`${endpoint}?keys=${encodeURIComponent(keys.join(','))}`, { signal: ctl && ctl.signal });
        if (res.status === 429) return { status: 'error', error: 'rateLimited', quotes: [] };
        if (!res.ok) return { status: 'error', error: `http${res.status}`, quotes: [] };
        const body = await res.json();
        const quotes = (Array.isArray(body && body.quotes) ? body.quotes : []).filter(validateQuotePayload).map((q) => ({ ...q, source: 'http' }));
        if (!quotes.length) return { status: 'error', error: 'invalidResponse', quotes: [] };
        return { status: 'ok', quotes };
      } catch (e) {
        return { status: 'error', error: e && e.name === 'AbortError' ? 'timeout' : 'network', quotes: [] };
      } finally { if (timer) clearTimeout(timer); }
    },
  });
}
