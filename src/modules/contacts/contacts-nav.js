/**
 * Contacts in-page navigation (V6.4.1 Stage A). Contact details and the Import / AI JSON / Categories /
 * Deleted sub-views are entries in the browser history ON THE SAME URL (#/m/contacts), marked
 * { ctNav: { v, id } }. So Android / browser Back and the on-screen "Back to Contacts" return exactly one step
 * to the list — the same page instance, with its search, category, Favourites filter and scroll position —
 * and the hash router never sees these entries (no shell remount, no route change).
 *
 * STATE-DRIVEN and idempotent: on every popstate the page simply shows what history.state says. That is what
 * makes it coexist with the menu viewer's own controller (media-ui.js): a viewer entry copies the state of the
 * entry under it ({ ...history.state, ctViewer }), so popping the viewer lands on the same ctNav → no change.
 * The list entry itself carries { ctList: { q, cat, fav, y } } (written with replaceState just before leaving
 * the list), so coming back — even after a remount, e.g. Back from another module — restores filters / scroll.
 *
 * Every sub-view entry is pushed FROM the list, so the entry under it is always the list: history.back() from a
 * sub-view can never leave Contacts.
 */
export const NAV_KEY = 'ctNav';
export const LIST_KEY = 'ctList';
export const SUB_VIEWS = Object.freeze(['detail', 'import', 'json', 'categories', 'deleted']);
const ID = /^[A-Za-z0-9_-]{6,40}$/;

/** The sub-view a history state describes (validated — a state is never trusted blindly), or null = list. */
export function navOf(state) {
  const n = state && state[NAV_KEY];
  if (!n || typeof n !== 'object' || !SUB_VIEWS.includes(n.v)) return null;
  if (n.v === 'detail') return typeof n.id === 'string' && ID.test(n.id) ? { v: 'detail', id: n.id } : null;
  return { v: n.v };
}
/** Saved list state (filters + scroll), validated. */
export function listOf(state) {
  const l = state && state[LIST_KEY];
  if (!l || typeof l !== 'object') return null;
  return { q: typeof l.q === 'string' ? l.q.slice(0, 200) : '', cat: typeof l.cat === 'string' ? l.cat.slice(0, 60) : 'all', fav: l.fav === true,
    y: Number.isFinite(l.y) && l.y >= 0 ? Math.min(l.y, 1e7) : 0 };
}
const without = (state, ...keys) => { const s = { ...(state || {}) }; for (const k of keys) delete s[k]; return s; };

/**
 * createContactsNav({ onChange(nav) }) — one per mounted Contacts page; dispose() on unmount.
 *   current()          the sub-view now shown by history (null = list)
 *   open(nav, list)    list → sub-view: saves the list state on the list entry, then pushes ONE entry
 *   back()             one step back (history.back() when on a sub-view entry; otherwise just shows the list)
 *   replaceList(list)  keep the list entry's saved state current (no new entry)
 */
export function createContactsNav({ onChange, win = window }) {
  const h = win.history;
  const onPop = () => onChange(navOf(h.state), listOf(h.state));
  win.addEventListener('popstate', onPop);
  return Object.freeze({
    current: () => navOf(h.state),
    savedList: () => listOf(h.state),
    open(nav, list) {
      if (navOf(h.state)) {                                   // already on a sub-view: switch it in place (never stack sub-views)
        h.replaceState({ ...without(h.state, 'ctViewer'), [NAV_KEY]: nav }, '');
        return;
      }
      h.replaceState({ ...without(h.state, 'ctViewer'), [LIST_KEY]: list }, '');
      h.pushState({ ...without(h.state, 'ctViewer', LIST_KEY), [NAV_KEY]: nav }, '');
    },
    back() {
      if (navOf(h.state)) h.back();                          // → popstate → onChange(null, saved list)
      else onChange(null, listOf(h.state));
    },
    replaceList(list) { if (!navOf(h.state)) h.replaceState({ ...without(h.state, 'ctViewer'), [LIST_KEY]: list }, ''); },
    dispose() { win.removeEventListener('popstate', onPop); },
  });
}
