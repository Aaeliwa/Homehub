/**
 * Pure input validators shared by forms and services. Firestore rules enforce the same
 * limits server-side; these exist for friendly UI feedback only.
 */
import { LIMITS, LANGUAGES, THEMES } from '../../config/app-config.js';

export function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Returns an i18n error key, or null when valid. */
export function validateDisplayName(value) {
  const v = normalizeText(value);
  if (!v) return 'validation.displayNameRequired';
  if (v.length > LIMITS.displayName) return 'validation.displayNameTooLong';
  return null;
}

export function validateHomeName(value) {
  const v = normalizeText(value);
  if (!v) return 'validation.homeNameRequired';
  if (v.length > LIMITS.homeName) return 'validation.homeNameTooLong';
  return null;
}

export function validateEmail(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return 'validation.emailRequired';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'validation.emailInvalid';
  return null;
}

export function isCurrencyCode(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

export function isLanguage(value) { return LANGUAGES.includes(value); }
export function isTheme(value) { return THEMES.includes(value); }

export function isWeekday(value) {
  return Number.isInteger(value) && value >= 0 && value <= 6;
}
