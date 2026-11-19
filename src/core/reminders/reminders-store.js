/** Reminder presentation store (Phase 5.6): the user's own state + prefs for the current Home. */
import { stateDocId, prefsOf, LOOK_AHEAD } from './reminders-model.js';

const STATES = 'reminderStates'; const PREFS = 'reminderPrefs';
const KIND = { c: 'cleaning', p: 'maintenancePlan', f: 'maintenanceFault' };

export function createRemindersStore({ homeId, uid, repo }) {
  let states = []; let prefsDoc; const st = { s: 'loading', p: 'loading' }; let lastError = null; let disposed = false;
  const subs = new Set(); const stops = []; let cache = null;
  const emit = () => { cache = null; for (const fn of subs) fn(snapshot()); };
  function snapshot() {
    if (cache) return cache;
    const s = Object.values(st);
    cache = Object.freeze({ status: s.includes('error') ? 'error' : s.every((x) => x === 'ready') ? 'ready' : 'loading', error: lastError, states, prefs: prefsOf(prefsDoc) });
    return cache;
  }
  stops.push(repo.watchStates(homeId, uid, (d) => { states = d; st.s = 'ready'; emit(); }, (e) => { lastError = e; st.s = 'error'; emit(); }));
  stops.push(repo.watchPrefs(homeId, uid, (d) => { prefsDoc = d; st.p = 'ready'; emit(); }, (e) => { lastError = e; st.p = 'error'; emit(); }));
  const guard = () => { if (disposed) throw new Error('disposed'); };
  return {
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    getSnapshot: snapshot,
    /** read | dismissed | snoozed (until a Home date). Presentation only — never source data. */
    async mark(key, state, snoozeUntil = null) {
      guard();
      await repo.commit(homeId, [{ mode: 'set', name: STATES, id: stateDocId(uid, key), data: {
        ownerUid: uid, key, state, snoozeUntil: state === 'snoozed' ? snoozeUntil : null, sourceKind: KIND[key[0]], updatedAt: repo.now(), schemaVersion: 1 } }]);
    },
    /** Restore = delete my presentation state for this reminder. */
    async clear(key) { guard(); await repo.commit(homeId, [{ mode: 'delete', name: STATES, id: stateDocId(uid, key) }]); },
    async cleanup(list) { guard(); for (const s of list) { try { await repo.commit(homeId, [{ mode: 'delete', name: STATES, id: s.id }]); } catch { /* best effort */ } } },
    async savePrefs(p) {
      guard();
      if (!LOOK_AHEAD.includes(p.lookAheadDays)) throw Object.assign(new Error('reminders.err.prefs'), { detail: 'reminders.err.prefs' });
      await repo.commit(homeId, [{ mode: 'set', name: PREFS, id: uid, data: { lookAheadDays: p.lookAheadDays, cleaning: !!p.cleaning, maintenancePlans: !!p.maintenancePlans,
        maintenanceFaults: !!p.maintenanceFaults, quietStart: Number.isInteger(p.quietStart) ? p.quietStart : null, quietEnd: Number.isInteger(p.quietEnd) ? p.quietEnd : null,
        updatedAt: repo.now(), schemaVersion: 1 } }]);
    },
    listenerCount: () => stops.length,
    dispose() { disposed = true; for (const s of stops) s(); stops.length = 0; subs.clear(); },
  };
}
