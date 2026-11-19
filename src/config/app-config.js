/**
 * Application-wide constants. Pure data: no Firebase, no DOM.
 */
export const APP = Object.freeze({
  name: 'HomeHub',
  version: '6.4.0-c',
  phase: '4A',
  /** Version of the document shapes written by this code (users, homes, settings). */
  schemaVersion: 1,
});

/** Defaults applied at first-time setup and when a preference has never been chosen. */
export const DEFAULTS = Object.freeze({
  language: 'ar',
  theme: 'system',
  currency: 'EGP',
  timezone: 'Africa/Cairo',
  /** 0 = Sunday … 6 = Saturday. Saturday is the common week start in Egypt. */
  weekStartsOn: 6,
});

export const LIMITS = Object.freeze({
  displayName: 60,
  homeName: 80,
});

export const LANGUAGES = Object.freeze(['ar', 'en']);
export const THEMES = Object.freeze(['system', 'light', 'dark']);

/** Currencies offered in Home settings. Rules accept any ISO-4217 style 3-letter code. */
export const CURRENCIES = Object.freeze(['EGP', 'USD', 'EUR', 'GBP', 'SAR', 'AED', 'KWD', 'QAR']);

/** localStorage key for the device-level preference cache (used before sign-in only). */
export const PREFS_CACHE_KEY = 'homehub:prefs';
