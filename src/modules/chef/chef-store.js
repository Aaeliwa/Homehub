/**
 * Chef store (V6.1): recipes (household) + cooking timers (owner-only). Confirmed writes; one ticker
 * per tab reconciles due timers (idempotent running → completed; a stale revision from another tab is
 * refused). Alarms are de-duplicated per tab session, so every view of the SAME store rings once.
 */
import { validateRecipe, createDoc, editPatch, duplicateInput, isDeleted } from './recipe-model.js';
import { createFields, transition, renamePatch, isDue } from './timer-model.js';

const fail = (detail, fields) => Object.assign(new Error(detail), { code: 'validation', detail, fields });
const RC = 'recipes'; const TC = 'cookingTimers';

export function createChefStore({ homeId, uid, repo, canViewRecipes, nowMs = () => Date.now() }) {
  let importing = false;   // V6.3: one import at a time
  let recipes = []; let timers = []; const st = {}; let lastError = null; let disposed = false;
  const subs = new Set(); const stops = []; let cache = null; let ticker = null; let tickRefs = 0;
  const alerted = new Set(); const alarmSubs = new Set();
  const emit = () => { cache = null; for (const fn of subs) fn(snapshot()); };
  function snapshot() {
    if (cache) return cache;
    const s = Object.values(st);
    cache = Object.freeze({ status: !s.length ? 'idle' : s.includes('error') ? 'error' : s.every((x) => x === 'ready') ? 'ready' : 'loading', error: lastError, recipes, timers });
    return cache;
  }
  // Ring once per tab per RUN: when due locally, or when this tab SEES another tab / device complete it.
  const ring = (t, endsAtMs) => { const key = `${t.id}:${endsAtMs}`; if (alerted.has(key)) return; alerted.add(key); for (const fn of alarmSubs) fn(t); };
  const observe = (next) => {
    const prev = new Map(timers.map((x) => [x.id, x]));
    for (const t of next) { const p = prev.get(t.id); if (t.status === 'completed' && p && p.status === 'running' && alarmSubs.size) ring(t, p.endsAtMs); }
  };
  const watch = (key, start) => { st[key] = 'loading'; stops.push(start((d) => { if (key === 'r') recipes = d; else { observe(d); timers = d; } st[key] = 'ready'; emit(); }, (e) => { st[key] = 'error'; lastError = e; emit(); })); };
  if (canViewRecipes) watch('r', (on, er) => repo.watchRecipes(homeId, on, er));
  watch('t', (on, er) => repo.watchTimers(homeId, uid, on, er));
  const guard = () => { if (disposed) throw fail('disposed'); };
  const recipe = (id) => recipes.find((r) => r.id === id) || null;
  /** A recipe that may still be changed: exists and is not soft-deleted (stale UI can't act on a deleted one). */
  const live = (id) => { const r = recipe(id); if (!r) throw fail('recipes.err.notFound'); if (isDeleted(r)) throw fail('recipes.err.deleted'); return r; };
  const timer = (id) => timers.find((t) => t.id === id) || null;
  const throwFields = (errors) => { if (Object.keys(errors).length) throw fail(Object.keys(errors)[0] === 'title' ? errors.title : Object.values(errors)[0], errors); };
  const denied = (e) => e && (e.code === 'permission-denied' || e.code === 'PERMISSION_DENIED');

  async function tick() {
    const now = nowMs();
    for (const t of timers) {
      if (!isDue(t, now)) continue;
      ring(t, t.endsAtMs);   // once per tab per run
      try { await repo.commit(homeId, [{ mode: 'update', name: TC, id: t.id, data: { ...transition(t, 'complete', now), rev: t.rev + 1, updatedAt: repo.now() } }]); }
      catch { /* another tab / device completed it first (stale revision) — fine */ }
    }
  }

  const api = {
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    getSnapshot: snapshot, recipe, timer, listenerCount: () => stops.length,
    /** Shared ticker: the first view starts it, the last view stops it. */
    useTicker(onAlarm) {
      if (onAlarm) alarmSubs.add(onAlarm);
      if (++tickRefs === 1) { ticker = setInterval(() => { tick(); emit(); }, 1000); queueMicrotask(tick); }
      return () => { if (onAlarm) alarmSubs.delete(onAlarm); if (--tickRefs === 0) { clearInterval(ticker); ticker = null; } };
    },
    // ---- recipes
    async createRecipe(input) {
      guard(); const { value, errors } = validateRecipe(input); throwFields(errors);
      const id = repo.newId(homeId, RC);
      await repo.commit(homeId, [{ mode: 'set', name: RC, id, data: createDoc(value, { uid, now: repo.now() }) }]);
      return id;
    },
    /**
     * V6.3 AI import: create the confirmed items ONE write each (rules check each, same as a manual
     * recipe). Ids are deterministic per preview (ai_<hash>), so a retry or double click can never create
     * a second copy: a refused create whose id already exists counts as `already`. Returns counts + the
     * failed items (for "Retry failed").
     */
    async importRecipes(items, { onProgress = () => {} } = {}) {
      guard(); if (importing) throw fail('recipes.import.busy');
      importing = true; const res = { total: items.length, saved: 0, already: 0, failed: [] };
      try {
        onProgress({ ...res });
        for (const it of items) {
          const { value, errors } = validateRecipe(it.input);
          if (Object.keys(errors).length) { res.failed.push({ ...it, detail: 'recipes.import.invalid' }); onProgress({ ...res, failed: [...res.failed] }); continue; }
          try { await repo.commit(homeId, [{ mode: 'set', name: RC, id: it.id, data: createDoc(value, { uid, now: repo.now() }) }]); res.saved++; }
          catch (e) {
            let exists = recipes.some((r) => r.id === it.id);
            if (!exists && denied(e) && repo.exists) { try { exists = await repo.exists(homeId, RC, it.id); } catch { exists = false; } }
            if (exists) res.already++; else res.failed.push({ ...it, detail: denied(e) ? 'recipes.err.conflict' : 'recipes.import.network' });
          }
          onProgress({ ...res, failed: [...res.failed] });
        }
      } finally { importing = false; }
      return res;
    },
    async editRecipe(id, input) {
      guard(); const cur = live(id);
      const { value, errors } = validateRecipe(input); throwFields(errors);
      const patch = editPatch(cur, value, { uid, now: repo.now() }); if (!patch) return;
      try { await repo.commit(homeId, [{ mode: 'update', name: RC, id, data: patch }]); } catch (e) { if (denied(e)) throw fail('recipes.err.conflict'); throw e; }
    },
    async duplicateRecipe(id, suffix) { guard(); return api.createRecipe(duplicateInput(live(id), suffix)); },
    /** V6.1.1: SOFT delete — hidden everywhere, kept for future references (rules: chef.delete; immutable after). */
    async deleteRecipe(id) {
      guard(); const cur = live(id); const now = repo.now();
      await repo.commit(homeId, [{ mode: 'update', name: RC, id, data: { deletedAt: now, deletedBy: uid, rev: cur.rev + 1, updatedBy: uid, updatedAt: now } }]);
    },
    async archiveRecipe(id, archive) {
      guard(); const cur = live(id); const now = repo.now();
      await repo.commit(homeId, [{ mode: 'update', name: RC, id, data: { archived: !!archive, archivedAt: archive ? now : null, archivedBy: archive ? uid : null, rev: cur.rev + 1, updatedBy: uid, updatedAt: now } }]);
    },
    async toggleFavorite(id) {
      guard(); const cur = live(id);
      const fav = cur.favoritedBy || []; const next = fav.includes(uid) ? fav.filter((x) => x !== uid) : [...fav, uid];
      await repo.commit(homeId, [{ mode: 'update', name: RC, id, data: { favoritedBy: next } }]);
    },
    // ---- timers (owner-only)
    async createTimer(input) {
      guard(); const now = nowMs(); const id = repo.newId(homeId, TC); const ts = repo.now();
      await repo.commit(homeId, [{ mode: 'set', name: TC, id, data: { ownerUid: uid, ...createFields(input, now), rev: 1, createdAt: ts, updatedAt: ts, schemaVersion: 1 } }]);
      return id;
    },
    async timerAction(id, action) {
      guard(); const t = timer(id); if (!t) throw fail('timers.err.notFound');
      try { await repo.commit(homeId, [{ mode: 'update', name: TC, id, data: { ...transition(t, action, nowMs()), rev: t.rev + 1, updatedAt: repo.now() } }]); }
      catch (e) { if (denied(e)) throw fail('timers.err.conflict'); throw e; }
    },
    /** V6.1.1: stop a ringing alarm (persisted). Idempotent: if another tab already stopped it, that's success. */
    async dismissAlarm(id) {
      guard(); const t = timer(id); if (!t || t.status === 'dismissed') return;
      try { await repo.commit(homeId, [{ mode: 'update', name: TC, id, data: { ...transition(t, 'dismiss', nowMs()), rev: t.rev + 1, updatedAt: repo.now() } }]); }
      catch (e) { if (!denied(e)) throw e; }   // stale revision = already dismissed / changed elsewhere
    },
    async renameTimer(id, label) {
      guard(); const t = timer(id); if (!t) throw fail('timers.err.notFound');
      await repo.commit(homeId, [{ mode: 'update', name: TC, id, data: { ...renamePatch(label), rev: t.rev + 1, updatedAt: repo.now() } }]);
    },
    async deleteTimer(id) { guard(); await repo.commit(homeId, [{ mode: 'delete', name: TC, id }]); },
    dispose() { disposed = true; if (ticker) clearInterval(ticker); ticker = null; for (const s of stops) s(); stops.length = 0; subs.clear(); alarmSubs.clear(); },
  };
  return api;
}
