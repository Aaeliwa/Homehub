/**
 * Upcoming sources hub (V6.4.1 Stage B) — the reference-counted core, with the module stores INJECTED
 * (`getters`), so it is testable without Firebase. Wiring for the app: upcoming-sources.js.
 * ONE hub per Home scope (and permission set) subscribes to the shared module stores the user may view and
 * owns the ONLY clock for Reminders and Upcoming: one 60 s interval plus a tab-focus check, re-deriving when the
 * Home date changes or when the next Calendar reminder moment passes. Store subscriptions, the interval and the
 * focus listener exist only while at least one consumer is subscribed.
 */
import { todayIn } from '../../modules/expenses/calendar.js';
import { sourceActive, effectiveRoomId, linkedDeviceId } from '../../modules/cleaning/cleaning-integration.js';
import { nowMinutesIn, minClock, nextReminderAt } from './upcoming-model.js';

export const defaultClock = Object.freeze({ setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id), now: () => new Date(),
  onFocus(f) { const h = () => { if (!document.hidden) f(); }; document.addEventListener('visibilitychange', h); return () => document.removeEventListener('visibilitychange', h); } });

export function createSources(ctx, flags, clock = defaultClock, getters = {}) {
  const state = ctx.getState(); const tz = state.home.timezone; const uid = state.identity.uid;
  const can = (p) => state.permissions.can(p);
  const isChild = state.membership.roleId === 'child' || state.membership.relationship === 'child';
  const subs = new Set(); let stores = null; let offs = []; let timer = null; let offFocus = null;
  let day = todayIn(tz, clock.now()); let nowMin = nowMinutesIn(tz, clock.now()); let next = null; let cache = null; let disposed = false;

  function open() {
    // the hub may have been created long before this consumer (e.g. yesterday's tab): start from the real clock
    day = todayIn(tz, clock.now()); nowMin = nowMinutesIn(tz, clock.now());
    const opt = (fn) => { try { return fn(); } catch { return null; } };
    stores = {
      cleaning: flags.cleaning && getters.cleaning ? opt(() => getters.cleaning(ctx)) : null,
      maintenance: flags.maintenance && getters.maintenance ? opt(() => getters.maintenance(ctx)) : null,
      calendar: flags.calendar && getters.calendar ? opt(() => getters.calendar(ctx)) : null,
      finance: flags.finance && getters.finance ? opt(() => getters.finance(ctx)) : null,
      devices: (flags.cleaning || flags.maintenance) && getters.devices ? opt(() => getters.devices(ctx)) : null,
      rooms: flags.cleaning && getters.rooms ? opt(() => getters.rooms(ctx)) : null,
    };
    if (stores.cleaning) stores.cleaning.watchDevices();
    for (const s of Object.values(stores)) if (s) offs.push(s.subscribe(changed));
    timer = clock.setInterval(tick, 60000);
    offFocus = clock.onFocus(tick);
  }
  function close() {
    for (const o of offs) { try { o(); } catch { /* ignore */ } }
    offs = []; stores = null;
    if (timer !== null) { clock.clearInterval(timer); timer = null; }
    if (offFocus) { offFocus(); offFocus = null; }
  }
  function tick() {
    const now = clock.now(); const d = todayIn(tz, now); const m = nowMinutesIn(tz, now);
    const passed = next && `${d} ${minClock(m)}` >= next;
    if (d !== day || passed) { day = d; nowMin = m; changed(); } else nowMin = m;
  }
  function snapshot() {
    if (cache) return cache;
    const s = stores || {};
    const snap = (x) => (x ? x.getSnapshot() : null);
    const cs = snap(s.cleaning); const ms = snap(s.maintenance); const ks = snap(s.calendar); const fs = snap(s.finance);
    const main = [cs, ms, ks, fs].filter(Boolean);
    const status = !stores ? 'idle' : main.some((x) => x.status === 'error') ? 'error' : main.every((x) => x.status === 'ready') ? 'ready' : 'loading';
    const devs = (snap(s.devices) || {}).devices || []; const rms = (snap(s.rooms) || {}).rooms || [];
    const deviceById = (id) => devs.find((d) => d.id === id) || null; const roomById = (id) => rms.find((r) => r.id === id) || null;
    const events = ks && ks.status === 'ready' ? ks.events : null;
    next = events ? nextReminderAt(events, { today: day, nowMin }) : null;
    cache = Object.freeze({
      status, today: day, nowMin, tz, uid, can, isChild, flags, homeId: state.home.id,
      cleaning: cs && cs.status === 'ready' ? { tasks: cs.tasks, occurrences: cs.occurrences, deviceEvents: cs.deviceEvents, deviceStates: cs.deviceStates } : null,
      maintenance: ms && ms.status === 'ready' ? { plans: ms.plans, faults: ms.faults } : null,
      events, commitments: fs && fs.status === 'ready' ? fs.commitments : null,
      sources: { cleaning: !!s.cleaning, maintenance: !!s.maintenance, calendar: !!s.calendar, finance: !!s.finance },
      isVisible: (t) => sourceActive(t, { roomById, deviceById }), roomOf: (t) => effectiveRoomId(t, { deviceById }), deviceOf: linkedDeviceId,
      deviceName: (id) => (deviceById(id) || {}).name || null, roomName: (id) => (roomById(id) || {}).name || null,
      nextReminderAt: next,
    });
    return cache;
  }
  function changed() { cache = null; const v = snapshot(); for (const fn of [...subs]) fn(v); }
  return {
    flags,
    subscribe(fn) {
      if (disposed) throw new Error('disposed');
      subs.add(fn); if (subs.size === 1) open();
      fn(snapshot());
      return () => { if (subs.delete(fn) && subs.size === 0) { close(); cache = null; } };
    },
    getSnapshot: snapshot,
    consumers: () => subs.size,
    active: () => ({ storeSubs: offs.length, timer: timer !== null, focus: !!offFocus }),
    tick,
    dispose() { disposed = true; subs.clear(); close(); },
  };
}
