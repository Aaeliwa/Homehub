/**
 * Context scope (added in Phase 2).
 *
 * One scope exists while the app is READY for a specific (uid, homeId). Module services
 * that hold live Firestore listeners register themselves as scope resources, so:
 *   - every consumer of a module (its page, its dashboard widget) shares ONE instance and
 *     ONE listener for the current Home;
 *   - everything is disposed when the user signs out, the context errors, or the Home
 *     changes — no listener survives its Home, and no data leaks across Homes.
 *
 * Pure: no Firebase, no DOM. main.js owns creation/disposal (see syncScope()).
 */
export function createContextScope({ uid, homeId }) {
  if (!uid || !homeId) throw new TypeError('context scope needs uid and homeId');
  const resources = new Map();
  let disposed = false;

  const scope = Object.freeze({
    uid,
    homeId,
    key: `${uid}/${homeId}`,
    isDisposed: () => disposed,

    /** Get-or-create a named resource. `factory(scope)` may return an object with dispose(). */
    resource(name, factory) {
      if (disposed) throw new Error(`context scope ${name}: already disposed`);
      if (!resources.has(name)) resources.set(name, factory(scope));
      return resources.get(name);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const r of resources.values()) {
        try { if (r && typeof r.dispose === 'function') r.dispose(); } catch { /* keep disposing */ }
      }
      resources.clear();
    },
  });
  return scope;
}
