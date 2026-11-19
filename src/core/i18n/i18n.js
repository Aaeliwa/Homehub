/**
 * Internationalisation: Arabic (RTL, default) and English (LTR).
 * t(key, params) looks up the current language, falls back to English, then to the key.
 * Params replace {name} placeholders. Output is plain text — the DOM helper inserts it
 * as a text node, so translations can never inject markup.
 */
import en from './locales/en.js';
import ar from './locales/ar.js';

const DICTIONARIES = Object.freeze({ ar, en });
const LOCALES = Object.freeze({ ar: 'ar-EG', en: 'en-GB' });
let language = 'ar';
const listeners = new Set();

export const SUPPORTED_LANGUAGES = Object.freeze(Object.keys(DICTIONARIES));

export function setLanguage(next) {
  if (!DICTIONARIES[next]) return;
  const changed = next !== language;
  language = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
    document.documentElement.dir = getDirection();
  }
  if (changed) for (const fn of listeners) fn(next);
}

export function getLanguage() { return language; }
export function getDirection() { return language === 'ar' ? 'rtl' : 'ltr'; }
export function getLocale() { return LOCALES[language]; }

export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key, params) {
  const raw = DICTIONARIES[language][key] ?? DICTIONARIES.en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (params[name] !== undefined ? String(params[name]) : m));
}

/**
 * Plural-aware lookup (added in Phase 2): uses `${base}.${rule}` where rule is the CLDR
 * plural category for the current language (Arabic has zero/one/two/few/many/other),
 * falling back to `${base}.other`. {n} is replaced with the localised number.
 */
export function tp(base, n, params = {}) {
  let rule = 'other';
  try { rule = new Intl.PluralRules(getLocale()).select(n); } catch { /* keep other */ }
  if (n === 0) rule = 'zero';
  const key = `${base}.${rule}` in DICTIONARIES[language] ? `${base}.${rule}` : `${base}.other`;
  return t(key, { ...params, n: formatNumber(n) });
}

export function hasKey(key) { return key in DICTIONARIES.en; }

/** Long date in the Home's timezone, in the current UI language. */
export function formatLongDate(date, timeZone) {
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full' }).format(date);
  }
}

/** Hour (0–23) of `date` in the given timezone, used for the greeting. */
export function hourIn(date, timeZone) {
  try {
    const part = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone })
      .formatToParts(date).find((p) => p.type === 'hour');
    return Number(part.value);
  } catch {
    return date.getHours();
  }
}

export function formatNumber(n) {
  return new Intl.NumberFormat(getLocale()).format(n);
}
