/**
 * V6.1.1 — ONE alarm coordinator per chef store (shared by the dashboard and cooking mode, however many
 * panels are mounted). While any timer is ringing (completed, not yet dismissed — persisted, so it
 * survives reloads, tabs and route changes) it plays a short beep every ~4 s; it stops when the last
 * alarm is dismissed or the last view unmounts. If the browser blocks audio, `audioBlocked` is true and
 * `enableSound()` (call it from a click) unlocks it. Nothing can ring while the browser is closed.
 */
import { isRinging } from './timer-model.js';

const coordinators = new WeakMap();
const INTERVAL_MS = 4000;

export function useAlarm(store, { audio = defaultAudio, intervalMs = INTERVAL_MS } = {}) {
  let c = coordinators.get(store);
  if (!c) { c = create(store, audio, intervalMs); coordinators.set(store, c); }
  c.refs += 1; c.update();
  return { coordinator: c, release: () => { c.refs -= 1; if (c.refs <= 0) { c.stop(); coordinators.delete(store); } } };
}

function create(store, audio, intervalMs) {
  let timer = null; const listeners = new Set();
  const c = {
    refs: 0, ringing: [], audioBlocked: false,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    update() {
      const now = Date.now();
      c.ringing = store.getSnapshot().timers.filter((t) => isRinging(t, now));
      if (c.ringing.length && !timer) { ring(); timer = setInterval(ring, intervalMs); }
      else if (!c.ringing.length && timer) { clearInterval(timer); timer = null; }
    },
    async enableSound() { c.audioBlocked = !(await audio.unlock()); for (const fn of listeners) fn(); if (!c.audioBlocked && c.ringing.length) audio.beep(); },
    stop() { if (timer) clearInterval(timer); timer = null; off(); audio.close(); listeners.clear(); },
  };
  function ring() { const ok = audio.beep(); if (ok === false && !c.audioBlocked) { c.audioBlocked = true; for (const fn of listeners) fn(); } }
  const off = store.subscribe(() => c.update());
  return c;
}

/** Web Audio: a short, soft three-pip beep (not a continuous tone). */
const defaultAudio = (() => {
  let ctx = null;
  const get = () => { const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext); if (!AC) return null; ctx = ctx || new AC(); return ctx; };
  return {
    beep() {
      const a = get(); if (!a) return false;
      if (a.state !== 'running') { a.resume().catch(() => {}); return a.state === 'running'; }
      for (let i = 0; i < 3; i++) {
        const o = a.createOscillator(); const g = a.createGain(); const at = a.currentTime + i * 0.25;
        o.frequency.value = 880; g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.12, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
        o.connect(g); g.connect(a.destination); o.start(at); o.stop(at + 0.2);
      }
      return true;
    },
    async unlock() { const a = get(); if (!a) return false; try { await a.resume(); } catch { return false; } return a.state === 'running'; },
    close() { if (ctx) { ctx.close().catch(() => {}); ctx = null; } },
  };
})();
