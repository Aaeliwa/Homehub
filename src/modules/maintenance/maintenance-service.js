/** getMaintenanceStore(ctx): the scope-bound maintenance store for the CURRENT Home (Phase 5.5). */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { todayIn } from '../expenses/calendar.js';
import { createMaintenanceStore } from './maintenance-store.js';
import { maintenanceRepository } from './maintenance-repository.js';
import { setMaintenanceFocus, takeMaintenanceFocus } from './maintenance-focus.js';
export { setMaintenanceFocus, takeMaintenanceFocus };

export function getMaintenanceStore(ctx) {
  const scope = ctx && ctx.scope; const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  const store = scope.resource('maintenance', (s) => createMaintenanceStore({ homeId: s.homeId, uid: s.uid, repo: maintenanceRepository,
    today: () => todayIn(state.home.timezone), homeCurrency: state.home.currency || null }));
  store.ensure({ canView: state.permissions.can('maintenance.view') });
  return store;
}

/** Device Details → live Maintenance section ({ el, dispose }), or null without maintenance.view. */
export async function deviceMaintenanceSection(ctx, device, { onNavigate }) {
  const state = ctx.getState();
  if (!state.permissions.can('maintenance.view')) return null;
  const store = getMaintenanceStore(ctx);
  const { buildDeviceMaintenanceSection } = await import('./device-maintenance-section.js');
  return buildDeviceMaintenanceSection({ store, state, device, onNavigate, setFocus: setMaintenanceFocus });
}
