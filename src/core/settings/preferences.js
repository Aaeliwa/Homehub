/**
 * Applies user preferences (language, theme) to the document and keeps a small
 * device-level cache so the login screen renders in the right language/theme before
 * anyone is signed in. The authoritative copy is users/{uid}; the cache is only a hint.
 */
import { DEFAULTS, PREFS_CACHE_KEY } from '../../config/app-config.js';
import { isLanguage, isTheme } from '../utils/validate.js';
import { setLanguage } from '../i18n/i18n.js';

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let currentTheme = DEFAULTS.theme;

export function readCachedPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_CACHE_KEY) || '{}');
    return {
      language: isLanguage(raw.language) ? raw.language : DEFAULTS.language,
      theme: isTheme(raw.theme) ? raw.theme : DEFAULTS.theme,
    };
  } catch {
    return { language: DEFAULTS.language, theme: DEFAULTS.theme };
  }
}

function writeCache(prefs) {
  try { localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

function resolvedTheme(theme) {
  if (theme === 'system') return media && media.matches ? 'dark' : 'light';
  return theme;
}

function paintTheme() {
  const t = resolvedTheme(currentTheme);
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#020617' : '#f8fafc');
}

if (media) media.addEventListener('change', () => { if (currentTheme === 'system') paintTheme(); });

/** Apply and cache. Missing values keep the current ones. */
export function applyPreferences({ language, theme } = {}) {
  const cached = readCachedPrefs();
  const next = {
    language: isLanguage(language) ? language : cached.language,
    theme: isTheme(theme) ? theme : cached.theme,
  };
  currentTheme = next.theme;
  paintTheme();
  setLanguage(next.language);
  writeCache(next);
  return next;
}

export function getThemePreference() { return currentTheme; }
export function getResolvedTheme() { return resolvedTheme(currentTheme); }
