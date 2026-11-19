/**
 * Hash router. Routes:
 *   #/dashboard        Dashboard
 *   #/settings         Settings
 *   #/m/<moduleId>     A module page (or its "coming soon" placeholder)
 *
 * Hash routing keeps deployment to static hosting trivial (no rewrites needed).
 */
const DEFAULT = Object.freeze({ name: 'dashboard', path: '/dashboard', params: {} });

export function parseRoute(hash) {
  const path = (hash || '').replace(/^#/, '') || DEFAULT.path;
  if (path === '/dashboard') return DEFAULT;
  if (path === '/settings') return { name: 'settings', path, params: {} };
  if (path === '/family') return { name: 'family', path, params: {} };
  if (path === '/reminders') return { name: 'reminders', path, params: {} };   // Phase 5.6
  const j = /^\/join\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (j) return { name: 'join', path, params: { code: j[1] } };
  // Phase 5.4a: an optional module sub-view (#/m/<moduleId>/<view>, e.g. #/m/cleaning/advanced).
  const m = /^\/m\/([a-z][a-zA-Z0-9]*)(?:\/([a-z][a-z0-9-]{0,31}))?$/.exec(path);
  if (m) return { name: 'module', path, params: m[2] ? { moduleId: m[1], view: m[2] } : { moduleId: m[1] } };
  return { ...DEFAULT, redirected: true };
}

export function createRouter(onChange) {
  let current = parseRoute(location.hash);
  const handler = () => {
    current = parseRoute(location.hash);
    if (current.redirected) { history.replaceState(null, '', `#${current.path}`); }
    onChange(current);
  };
  window.addEventListener('hashchange', handler);
  return Object.freeze({
    current: () => current,
    navigate(path) {
      if (`#${path}` === location.hash) handler();
      else location.hash = path;
    },
    /**
     * Replace the current route WITHOUT a history entry or a hashchange event, and keep
     * current() in sync. (Phase 2 fix: replaceState alone left current() stale, so after
     * signing out from another page, signing in reopened that page instead of the dashboard.)
     */
    replace(path) {
      history.replaceState(null, '', `#${path}`);
      current = parseRoute(`#${path}`);
    },
    stop: () => window.removeEventListener('hashchange', handler),
  });
}
