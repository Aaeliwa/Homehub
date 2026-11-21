/**
 * Reminders feed (Phase 5.6; V6.4.1 Stage B) — shared by the bell and the Reminders page. Built on the Home's
 * ONE Upcoming sources hub (see core/upcoming/upcoming-sources.js): it holds the store subscriptions and the
 * single clock (Home date change, next Calendar reminder moment, tab focus). This feed adds only the user's
 * own presentation state (read / dismissed / snoozed) and preferences. dispose() releases its subscriptions;
 * the hub stops its clock when its last consumer leaves.
 */
import { AppError, ErrorCode } from '../errors/app-error.js';
import { createRemindersStore } from './reminders-store.js';
import { remindersRepository } from './reminders-repository.js';
import { deriveReminders, applyState, counts } from './reminders-model.js';
import { getUpcomingSources } from '../upcoming/upcoming-sources.js';
import { canSeeReminders } from '../upcoming/access.js';

/** Who has Reminders at all: any of its sources (V6.4.1 Stage B: Calendar and Finance commitments too). */
export { canSeeReminders };

export function getRemindersStore(ctx) {
  const scope = ctx && ctx.scope; const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  if (!canSeeReminders(state.permissions)) throw new AppError(ErrorCode.PERMISSION_DENIED);
  return scope.resource('reminders', (s) => createRemindersStore({ homeId: s.homeId, uid: s.uid, repo: remindersRepository }));
}

export function createRemindersFeed(ctx, onChange) {
  const rstore = getRemindersStore(ctx);
  const hub = getUpcomingSources(ctx);
  let cache = null; let src = null; let rs = rstore.getSnapshot(); let ready = false;
  function compute() {
    if (!ready || !src) return;
    const loading = src.status === 'loading' || src.status === 'idle' || rs.status === 'loading';
    const error = src.status === 'error' || rs.status === 'error';
    const items = loading || error ? [] : applyState(deriveReminders({
      cleaning: src.cleaning, maintenance: src.maintenance, events: src.events, commitments: src.commitments, nowMin: src.nowMin,
      today: src.today, tz: src.tz, uid: src.uid, can: src.can, isChild: src.isChild, prefs: rs.prefs,
      isVisible: src.isVisible, roomOf: src.roomOf, deviceOf: src.deviceOf,
    }), rs.states, src.today);
    cache = { status: error ? 'error' : loading ? 'loading' : 'ready', items, counts: counts(items), prefs: rs.prefs, states: rs.states, today: src.today,
      sources: src.sources, deviceName: src.deviceName, roomName: src.roomName };
    onChange(cache);
  }
  const offs = [rstore.subscribe((s) => { rs = s; compute(); }), hub.subscribe((s) => { src = s; compute(); })];
  ready = true; compute();
  return { get: () => cache, store: rstore, dispose() { for (const o of offs.splice(0)) o(); } };
}
