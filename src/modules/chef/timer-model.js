/**
 * Cooking timers (V6.1) — PURE. Remaining time is DERIVED from absolute timestamps (never decremented):
 * running: remaining = endsAtMs − now; paused: remaining = remainingMsAtPause. Only transitions are
 * persisted (no per-second writes). Completion is an idempotent running → completed transition.
 * V6.1.1: `completed` = the alarm is RINGING (persisted) until the owner stops it: completed → dismissed.
 */
export const MAX_MS = 24 * 3600 * 1000; export const MIN_MS = 1000;
const fail = (d) => Object.assign(new Error(d), { code: 'validation', detail: d });
export function durationMs({ h = 0, m = 0, s = 0 }) {
  const n = [h, m, s].map((x) => (x === '' || x == null ? 0 : Number(x)));
  if (n.some((x) => !Number.isInteger(x) || x < 0) || n[1] > 59 || n[2] > 59) throw fail('timers.err.duration');
  const ms = ((n[0] * 60 + n[1]) * 60 + n[2]) * 1000;
  if (ms < MIN_MS || ms > MAX_MS) throw fail('timers.err.duration');
  return ms;
}
export function remainingMs(t, now) {
  if (t.status === 'running') return Math.max(0, t.endsAtMs - now);
  if (t.status === 'paused') return t.remainingMsAtPause;
  if (t.status === 'completed' || t.status === 'dismissed') return 0;
  return t.durationMs;   // idle
}
export const isDue = (t, now) => t.status === 'running' && t.endsAtMs <= now;
/** Ringing = completed and not yet dismissed, or already due (before the completion write lands). */
export const isRinging = (t, now) => t.status === 'completed' || isDue(t, now);
/** Active (dashboard visibility): running, paused, or an alarm still waiting to be stopped. */
export const isActive = (t, now) => t.status === 'running' || t.status === 'paused' || isRinging(t, now);
const label = (l) => { const s = typeof l === 'string' ? l.trim() : ''; if (!s || s.length > 60) throw fail('timers.err.label'); return s; };
export function createFields({ label: l, durationMs: d, recipeId = null, stepId = null, start = true }, now) {
  return { label: label(l), durationMs: d, status: start ? 'running' : 'idle', endsAtMs: start ? now + d : null, remainingMsAtPause: null, recipeId, stepId };
}
/** Transition patches (status + derived fields only). */
export function transition(t, action, now) {
  if (action === 'pause') { if (t.status !== 'running') throw fail('timers.err.state'); return { status: 'paused', remainingMsAtPause: Math.max(0, t.endsAtMs - now), endsAtMs: null }; }
  if (action === 'resume') { if (t.status !== 'paused') throw fail('timers.err.state'); return { status: 'running', endsAtMs: now + t.remainingMsAtPause, remainingMsAtPause: null }; }
  if (action === 'start') { if (t.status !== 'idle') throw fail('timers.err.state'); return { status: 'running', endsAtMs: now + t.durationMs, remainingMsAtPause: null }; }
  if (action === 'restart') return { status: 'running', endsAtMs: now + t.durationMs, remainingMsAtPause: null };
  if (action === 'complete') { if (!isDue(t, now)) throw fail('timers.err.state'); return { status: 'completed', endsAtMs: null, remainingMsAtPause: null }; }
  if (action === 'dismiss') { if (t.status !== 'completed') throw fail('timers.err.state'); return { status: 'dismissed', endsAtMs: null, remainingMsAtPause: null }; }
  throw fail('timers.err.state');
}
export function renamePatch(l) { return { label: label(l) }; }
export function fmt(ms) {
  const s = Math.ceil(ms / 1000); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
}
