/**
 * Development logger. Every line is prefixed with [HomeHub].
 *
 * Debug/info output is enabled on localhost, with ?debug=1 in the URL, or when
 * localStorage['homehub:debug'] === '1'. Warnings and errors are always printed.
 * Application behaviour never depends on whether logging is enabled.
 *
 * NEVER pass passwords, ID tokens, or other credentials to the logger.
 */
const PREFIX = '[HomeHub]';

function detectDebug() {
  try {
    if (typeof location !== 'undefined') {
      if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return true;
      if (new URLSearchParams(location.search).get('debug') === '1') return true;
    }
    if (typeof localStorage !== 'undefined' && localStorage.getItem('homehub:debug') === '1') return true;
  } catch { /* storage may be blocked */ }
  return false;
}

const enabled = detectDebug();

export const log = Object.freeze({
  enabled,
  info: (...args) => { if (enabled) console.info(PREFIX, ...args); },
  debug: (...args) => { if (enabled) console.debug(PREFIX, ...args); },
  warn: (...args) => console.warn(PREFIX, ...args),
  error: (...args) => console.error(PREFIX, ...args),
});
