/**
 * Upcoming sources (V6.4.1 Stage B) — app wiring of the hub (upcoming-hub.js) to the module stores. The stores
 * are the existing scope resources shared with the module pages and widgets: no new Firestore listener is
 * created here. Released on Home switch / sign-out with the scope.
 */
import { getCleaningStore } from '../../modules/cleaning/cleaning-service.js';
import { getMaintenanceStore } from '../../modules/maintenance/maintenance-service.js';
import { getDevicesStore } from '../../modules/devices/devices-service.js';
import { getRoomsStore } from '../../modules/rooms/rooms-service.js';
import { getCalendarStore } from '../../modules/calendar/calendar-service.js';
import { getFinanceStore } from '../../modules/expenses/finance-service.js';
import { sourceFlags, anySource } from './access.js';
import { createSources, defaultClock } from './upcoming-hub.js';
export { sourceFlags, anySource };

export const STORE_GETTERS = Object.freeze({ cleaning: getCleaningStore, maintenance: getMaintenanceStore, calendar: getCalendarStore, finance: getFinanceStore,
  devices: getDevicesStore, rooms: getRoomsStore });

export function getUpcomingSources(ctx, { clock = defaultClock } = {}) {
  const state = ctx.getState(); const flags = sourceFlags(state.permissions);
  const sig = Object.entries(flags).filter(([, v]) => v).map(([k]) => k).join(',');
  return ctx.scope.resource(`upcomingSources:${sig}`, () => createSources(ctx, flags, clock, STORE_GETTERS));
}
