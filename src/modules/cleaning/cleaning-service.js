/** getCleaningStore(ctx): the scope-bound cleaning store for the CURRENT Home. */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { todayIn } from '../expenses/calendar.js';
import { createCleaningStore } from './cleaning-store.js';
import { cleaningRepository } from './cleaning-repository.js';

export function getCleaningStore(ctx) {
  const scope = ctx && ctx.scope; const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  const store = scope.resource('cleaning', (s) => createCleaningStore({ homeId: s.homeId, uid: s.uid, repo: cleaningRepository, today: () => todayIn(state.home.timezone) }));
  store.ensure({ canView: state.permissions.can('cleaning.view') });
  return store;
}

// Phase 5.4d: navigation focus (pure; re-exported so callers still use the Cleaning service).
import { setCleaningFocus, takeCleaningFocus } from './cleaning-focus.js';
export { setCleaningFocus, takeCleaningFocus };

/** Device Details → live Cleaning section ({ el, dispose }), or null without cleaning.view. */
export async function deviceCleaningSection(ctx, device, { onNavigate }) {
  const state = ctx.getState();
  if (!state.permissions.can('cleaning.view')) return null;
  const store = getCleaningStore(ctx);
  const { buildDeviceCleaningSection } = await import('./device-cleaning-section.js');
  return buildDeviceCleaningSection({ store, state, device, onNavigate, setFocus: setCleaningFocus });
}
