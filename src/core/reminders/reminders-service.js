/**
 * Reminders feed (Phase 5.6) — shared by the bell, the page and the dashboard card. Subscribes ONLY
 * to the stores the user may view; re-derives on every source-data change, on tab focus and when the
 * Home calendar date changes (checked every 60 s). dispose() removes every subscription and timer.
 */
import { AppError, ErrorCode } from '../errors/app-error.js';
import { todayIn } from '../../modules/expenses/calendar.js';
import { getCleaningStore } from '../../modules/cleaning/cleaning-service.js';
import { getMaintenanceStore } from '../../modules/maintenance/maintenance-service.js';
import { getDevicesStore } from '../../modules/devices/devices-service.js';
import { getRoomsStore } from '../../modules/rooms/rooms-service.js';
import { sourceActive, effectiveRoomId, linkedDeviceId } from '../../modules/cleaning/cleaning-integration.js';
import { createRemindersStore } from './reminders-store.js';
import { remindersRepository } from './reminders-repository.js';
import { deriveReminders, applyState, counts } from './reminders-model.js';

export const canSeeReminders = (perms) => perms.can('cleaning.view') || perms.can('maintenance.view');

export function getRemindersStore(ctx) {
  const scope = ctx && ctx.scope; const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  if (!canSeeReminders(state.permissions)) throw new AppError(ErrorCode.PERMISSION_DENIED);
  return scope.resource('reminders', (s) => createRemindersStore({ homeId: s.homeId, uid: s.uid, repo: remindersRepository }));
}

export function createRemindersFeed(ctx, onChange) {
  const state = ctx.getState(); const perms = state.permissions; const tz = state.home.timezone;
  const can = (p) => perms.can(p);
  const isChild = state.membership.roleId === 'child' || state.membership.relationship === 'child';
  const rstore = getRemindersStore(ctx);
  const cleaning = can('cleaning.view') ? getCleaningStore(ctx) : null;
  const maintenance = can('maintenance.view') ? getMaintenanceStore(ctx) : null;
  let devices = null; let rooms = null;
  try { devices = getDevicesStore(ctx); } catch { devices = null; }
  try { rooms = getRoomsStore(ctx); } catch { rooms = null; }
  if (cleaning) cleaning.watchDevices();
  let day = todayIn(tz); let cache = null;
  const deviceList = () => { const s = devices && devices.getSnapshot(); return (s && s.devices) || []; };
  const roomList = () => { const s = rooms && rooms.getSnapshot(); return (s && s.rooms) || []; };
  function compute() {
    const cs = cleaning && cleaning.getSnapshot(); const ms = maintenance && maintenance.getSnapshot(); const rs = rstore.getSnapshot();
    const loading = (cs && cs.status !== 'ready') || (ms && ms.status !== 'ready') || rs.status === 'loading';
    const error = (cs && cs.status === 'error') || (ms && ms.status === 'error') || rs.status === 'error';
    const devById = (id) => deviceList().find((d) => d.id === id) || null; const roomById = (id) => roomList().find((r) => r.id === id) || null;
    const items = loading || error ? [] : applyState(deriveReminders({
      cleaning: cs ? { tasks: cs.tasks, occurrences: cs.occurrences, deviceEvents: cs.deviceEvents, deviceStates: cs.deviceStates } : null,
      maintenance: ms ? { plans: ms.plans, faults: ms.faults } : null,
      today: day, tz, uid: state.identity.uid, can, isChild, prefs: rs.prefs,
      isVisible: (t) => sourceActive(t, { roomById, deviceById: devById }), roomOf: (t) => effectiveRoomId(t, { deviceById: devById }), deviceOf: linkedDeviceId,
    }), rs.states, day);
    cache = { status: error ? 'error' : loading ? 'loading' : 'ready', items, counts: counts(items), prefs: rs.prefs, states: rs.states, today: day,
      sources: { cleaning: !!cleaning, maintenance: !!maintenance }, deviceName: (id) => (devById(id) || {}).name || null, roomName: (id) => (roomById(id) || {}).name || null };
    onChange(cache);
  }
  const offs = [rstore.subscribe(compute)];
  if (cleaning) offs.push(cleaning.subscribe(compute));
  if (maintenance) offs.push(maintenance.subscribe(compute));
  if (devices) offs.push(devices.subscribe(compute));
  if (rooms) offs.push(rooms.subscribe(compute));
  const tick = () => { const d = todayIn(tz); if (d !== day) { day = d; compute(); } };
  const timer = setInterval(tick, 60000);
  const onVis = () => { if (!document.hidden) tick(); };
  document.addEventListener('visibilitychange', onVis);
  return { get: () => cache, store: rstore, dispose() { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); for (const o of offs) o(); } };
}
