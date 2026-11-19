/** getCalendarStore(ctx): the scope-bound Calendar store for the CURRENT Home (null without calendar.view). */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { createCalendarStore } from './calendar-store.js';
import { calendarRepository } from './calendar-repository.js';

export function getCalendarStore(ctx, { optional = false } = {}) {
  const scope = ctx && ctx.scope; const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) { if (optional) return null; throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE); }
  if (!state.permissions.can('calendar.view')) { if (optional) return null; throw new AppError(ErrorCode.PERMISSION_DENIED); }
  return scope.resource('calendar', (s) => createCalendarStore({ homeId: s.homeId, uid: s.uid, timezone: state.home.timezone || 'Africa/Cairo', repo: calendarRepository }));
}
