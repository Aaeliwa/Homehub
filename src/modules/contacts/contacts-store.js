/**
 * Shared Contacts store (V6.4 B). One bounded listener for live contacts + one for categories, per Home
 * scope (disposed on sign-out / Home switch). Every write is CONFIRMED (no optimistic success), revisioned
 * (rev + 1, stale edits refused) and stamped; the Firestore rules re-check permissions on each write.
 */
import { assertValid, createDoc, editPatch, isDeleted, validateCategory, suggestedId, SUGGESTED_CATEGORIES, CONTACT_LIMITS, classifyOccupied, sameContent, importId } from './contact-model.js';
import { MAX_COPY } from './contacts-import.js';

/** Progress / result counters (every bucket counted once). */
export const progressOf = (r) => ({ ...r, done: r.created + r.merged + r.already + r.unchanged + r.kept.length + r.deleted.length + r.hidden.length + r.stale.length + r.failed.length,
  kept: [...r.kept], deleted: [...r.deleted], hidden: [...r.hidden], stale: [...r.stale], failed: [...r.failed] });

const fail = (detail, fields) => Object.assign(new Error(detail), { code: 'validation', detail, fields });
const CC = 'contacts'; const KC = 'contactCategories';
const denied = (e) => e && (e.code === 'permission-denied' || e.code === 'PERMISSION_DENIED');

export function createContactsStore({ homeId, uid, repo, canView }) {
  let contacts = []; let categories = []; let truncated = false; const st = {}; let lastError = null; let disposed = false; let importing = false;
  const subs = new Set(); const stops = []; let cache = null;
  const emit = () => { cache = null; for (const fn of subs) fn(snapshot()); };
  function snapshot() {
    if (cache) return cache;
    const s = Object.values(st);
    const status = !canView ? 'denied' : !s.length ? 'idle' : s.includes('error') ? 'error' : s.every((x) => x === 'ready') ? 'ready' : 'loading';
    // rev 2 (B3): `truncated` = the directory holds MORE than maxContacts live contacts, so the loaded list is
    // incomplete — search, duplicate detection and export must say so; imports are refused.
    cache = Object.freeze({ status, error: lastError, contacts, categories, truncated, capacity: CONTACT_LIMITS.maxContacts,
      atLimit: truncated || contacts.length >= CONTACT_LIMITS.maxContacts });
    return cache;
  }
  const watch = (key, start, set) => { st[key] = 'loading'; stops.push(start((d) => { set(d); st[key] = 'ready'; emit(); }, (e) => { st[key] = 'error'; lastError = e; emit(); })); };
  if (canView) {
    watch('c', (on, er) => repo.watchContacts(homeId, on, er), (d) => { const live = d.filter((c) => !isDeleted(c)); truncated = live.length > CONTACT_LIMITS.maxContacts; contacts = live.slice(0, CONTACT_LIMITS.maxContacts); });
    watch('k', (on, er) => repo.watchCategories(homeId, on, er), (d) => { categories = [...d].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.id).localeCompare(b.id)); });
  }
  const guard = () => { if (disposed) throw fail('disposed'); };
  const contact = (id) => contacts.find((c) => c.id === id) || null;
  const live = (id) => { const c = contact(id); if (!c) throw fail('contacts.err.notFound'); return c; };
  /** A refused update whose base revision is no longer current → "changed by someone else" (re-confirm). */
  const stale = async (id, baseRev, e) => {
    if (!denied(e)) return e;
    try { const cur = await repo.read(homeId, id); if (!cur || cur.rev !== baseRev || cur.deleted === true) return fail('contacts.err.stale'); }
    catch (re) { if (denied(re)) return fail('contacts.err.stale'); }   // rev 2: deleted meanwhile (hidden without contacts.delete)
    return e;
  };
  async function update(id, baseRev, data) {
    try { await repo.commit(homeId, [{ mode: 'update', name: CC, id, data }]); }
    catch (e) { throw await stale(id, baseRev, e); }
  }

  const api = {
    subscribe(fn) { subs.add(fn); fn(snapshot()); return () => subs.delete(fn); },
    getSnapshot: snapshot, contact, listenerCount: () => stops.length,
    // ---------------------------------------------------------------- contacts
    async createContact(input) {
      guard(); const value = assertValid(input, { categories });
      if (snapshot().atLimit) throw fail('contacts.err.atLimit');
      const id = repo.newId(homeId, CC);
      await repo.commit(homeId, [{ mode: 'set', name: CC, id, data: createDoc(value, { uid, now: repo.now(), source: 'manual' }) }]);
      return id;
    },
    /** baseRev = the revision the editor was opened with; a newer stored revision → contacts.err.stale. */
    async updateContact(id, input, { baseRev } = {}) {
      guard(); const cur = live(id);
      if (Number.isInteger(baseRev) && cur.rev !== baseRev) throw fail('contacts.err.stale');
      const value = assertValid(input, { categories });
      const patch = editPatch(cur, value, { uid, now: repo.now() });
      if (!patch) return false;
      await update(id, cur.rev, patch);
      return true;
    },
    async setFavorite(id, favorite) {
      guard(); const cur = live(id);
      if ((cur.favorite === true) === (favorite === true)) return false;
      await update(id, cur.rev, { favorite: favorite === true, rev: cur.rev + 1, updatedBy: uid, updatedAt: repo.now() });
      return true;
    },
    async deleteContact(id) {
      guard(); const cur = live(id);
      await update(id, cur.rev, { deleted: true, deletedAt: repo.now(), deletedBy: uid, rev: cur.rev + 1, updatedBy: uid, updatedAt: repo.now() });
    },
    /** { items (≤ deletedList), more: true when older deleted contacts exist beyond the list } */
    async loadDeleted() { const d = await repo.readDeleted(homeId); return { items: d.slice(0, CONTACT_LIMITS.deletedList), more: d.length > CONTACT_LIMITS.deletedList }; },
    async restoreContact(c) {
      guard(); if (!c || c.deleted !== true) throw fail('contacts.err.notFound');
      await update(c.id, c.rev, { deleted: false, deletedAt: null, deletedBy: null, rev: c.rev + 1, updatedBy: uid, updatedAt: repo.now() });
    },
    // ---------------------------------------------------------------- categories
    /** Idempotent: creates only the suggested categories that do not exist yet (stable ids s_<key>). */
    async addSuggestedCategories() {
      guard(); const have = new Set(categories.map((c) => c.id)); let created = 0;
      let order = categories.reduce((m, c) => Math.max(m, c.order ?? 0), -1) + 1;
      for (const key of SUGGESTED_CATEGORIES) {
        const id = suggestedId(key); if (have.has(id)) continue;
        if (categories.length + created >= CONTACT_LIMITS.maxCategories) break;
        try {
          await repo.commit(homeId, [{ mode: 'set', name: KC, id, data: { name: null, key, order: Math.min(999, order++), rev: 1, createdBy: uid, createdAt: repo.now(), updatedBy: uid, updatedAt: repo.now(), schemaVersion: 1 } }]);
          created++;
        } catch (e) { if (!(denied(e) && await repo.exists(homeId, KC, id))) throw e; }   // another device added it: fine
      }
      return created;
    },
    async createCategory(input) {
      guard(); const { value, errors } = validateCategory(input);
      if (errors.name) throw fail(errors.name);
      if (categories.length >= CONTACT_LIMITS.maxCategories) throw fail('contacts.err.tooManyCategories');
      const id = repo.newId(homeId, KC);
      const order = Math.min(999, categories.reduce((m, c) => Math.max(m, c.order ?? 0), -1) + 1);
      await repo.commit(homeId, [{ mode: 'set', name: KC, id, data: { name: value.name, key: null, order, rev: 1, createdBy: uid, createdAt: repo.now(), updatedBy: uid, updatedAt: repo.now(), schemaVersion: 1 } }]);
      return id;
    },
    async renameCategory(id, input) {
      guard(); const cur = categories.find((c) => c.id === id); if (!cur) throw fail('contacts.err.categoryGone');
      const { value, errors } = validateCategory(input); if (errors.name) throw fail(errors.name);
      await repo.commit(homeId, [{ mode: 'update', name: KC, id, data: { name: value.name, rev: cur.rev + 1, updatedBy: uid, updatedAt: repo.now() } }]);
    },
    /** Removes the CATEGORY only; contacts keep everything else (the id is ignored on display). */
    async deleteCategory(id) {
      guard();
      await repo.commit(homeId, [{ mode: 'delete', name: KC, id }]);
    },
    // ---------------------------------------------------------------- import
    /**
     * Execute a confirmed plan (planImport). One write per contact. Never overwrites, restores or silently
     * duplicates (rev 2):
     *  - a create whose id is occupied is VERIFIED by reading the document (classifyOccupied):
     *    already (it is this import result) · kept (exists, different) · deleted (soft-deleted, not restored)
     *    · hidden (exists but unreadable); only an explicit "keep separate" op moves on to the next copy id;
     *  - a merge whose target changed since the preview is stale — unless the target already holds exactly
     *    the merged result at baseRev + 1 (a retry after a lost response) → already.
     * Returns { total, created, merged, already, unchanged, kept:[op], deleted:[op], hidden:[op], stale:[op],
     *   failed:[op], capacity } — retry failed; "add as separate" for kept / deleted / hidden; review stale.
     */
    async importContacts(ops, { onProgress = () => {} } = {}) {
      guard(); if (importing) throw fail('contacts.import.busy');
      const snap = snapshot();
      if (snap.status !== 'ready') throw fail('contacts.import.notReady');
      if (snap.truncated) throw fail('contacts.import.truncated');          // B3: duplicate checks need the whole directory
      importing = true;
      const res = { total: ops.length, created: 0, merged: 0, already: 0, unchanged: 0, kept: [], deleted: [], hidden: [], stale: [], failed: [] };
      let room = CONTACT_LIMITS.maxContacts - contacts.length;
      const tick = () => onProgress(progressOf(res));
      const occupant = async (id) => { try { return await repo.read(homeId, id); } catch (e) { if (denied(e)) return 'hidden'; throw e; } };
      try {
        tick();
        for (const op of ops) {
          try {
            if (op.error) { res.failed.push({ ...op, detail: op.error }); continue; }
            if (op.kind === 'create') {
              const value = assertValid(op.value, { categories });
              let id = op.id; let copy = op.copy || 0; let outcome = null;
              for (;;) {
                if (room <= 0) { outcome = 'capacity'; break; }
                try { await repo.commit(homeId, [{ mode: 'set', name: CC, id, data: createDoc(value, { uid, now: repo.now(), source: op.source === 'json' ? 'json' : 'vcf' }) }]); outcome = 'created'; room--; break; }
                catch (e) {
                  if (!denied(e)) throw e;
                  const kind = classifyOccupied(await occupant(id), value);
                  if (!kind) throw e;                                          // nothing there: a real denial
                  if (kind === 'already' || !op.separate || copy >= MAX_COPY) { outcome = kind; break; }
                  id = importId(value, ++copy);                                // explicit "keep separate": next copy
                }
              }
              const done = { ...op, id, copy };
              if (outcome === 'created') res.created++;
              else if (outcome === 'already') res.already++;
              else if (outcome === 'capacity') res.failed.push({ ...done, detail: 'contacts.err.atLimit' });
              else res[outcome].push(done);
            } else {
              const cur = contact(op.targetId);
              if (cur && cur.rev === op.baseRev + 1 && op.changed && sameContent(cur, op.value)) { res.already++; continue; }   // lost response
              if (!cur || cur.rev !== op.baseRev) { res.stale.push(op); continue; }     // changed / deleted since the preview
              if (!op.changed) { res.unchanged++; continue; }
              const value = assertValid(op.value, { categories });
              const patch = editPatch(cur, value, { uid, now: repo.now() });
              if (!patch) { res.unchanged++; continue; }
              try { await repo.commit(homeId, [{ mode: 'update', name: CC, id: op.targetId, data: patch }]); res.merged++; }
              catch (e) {
                const latest = await occupant(op.targetId).catch(() => null);
                if (latest && latest !== 'hidden' && latest.rev === op.baseRev + 1 && sameContent(latest, value)) res.already++;
                else if (latest === 'hidden' || (latest && latest.rev !== op.baseRev)) res.stale.push(op);
                else throw e;
              }
            }
          } catch (e) { res.failed.push({ ...op, detail: e && e.detail ? e.detail : denied(e) ? 'contacts.err.denied' : 'contacts.err.network' }); }
          finally { tick(); }
        }
      } finally { importing = false; }
      return res;
    },
    dispose() { disposed = true; for (const s of stops) s(); stops.length = 0; subs.clear(); contacts = []; categories = []; },
  };
  return api;
}
