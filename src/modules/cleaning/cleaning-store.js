/**
 * Cleaning live store — ONE per context scope (Phase 5.3). PURE (repository injected).
 * Listeners: tasks + occurrences (window) = 2. Stop on dispose (sign-out / Home change).
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { addDays } from '../expenses/calendar.js';
import { buildTaskCreate, validateTaskInput, TASK_EDITABLE, buildAction, occurrenceId, historyDaysNeeded } from './cleaning-model.js';
import { generatedPayloadProblems } from './cleaning-integration.js';
import { validateTemplate, templateCreateDoc, templatePatch } from './cleaning-custom.js';
const TEMPLATES = 'cleaningCustomTemplates';

const TASKS = 'cleaningTasks'; const OCC = 'cleaningOccurrences'; const LOG = 'cleaningLog';
const ROUTINES = 'cleaningRoutines'; const SETTINGS = 'cleaningSettings';
const DEV_EVENTS = 'cleaningDeviceEvents'; const DEV_STATE = 'cleaningDeviceState'; const DEV_SEASONS = 'cleaningDeviceSeasons';
export const DEVICE_EVENT_WINDOW_DAYS = 120;   // usage history kept live (older uses stay in Firestore)
const fail = (detail) => new AppError(ErrorCode.VALIDATION, { detail });
import { revalidate, restoreUndo, restoreGenPatches, genOf } from './cleaning-ops.js';
const denied = (e) => e && (e.code === 'permission-denied' || e.code === ErrorCode.PERMISSION_DENIED);

export function createCleaningStore({ homeId, uid, repo, today }) {
  if (!homeId || !uid) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  let tasks = []; let occurrences = []; const st = { t: 'idle', o: 'idle' };
  let stopT = null; let stopO = null; let disposed = false; let lastError = null; let cache = null; let windowDays = 0;
  // Phase 5.4a (Advanced): only while the Advanced screen is used.
  let stopR = null; let stopS = null; let routineDay = null; let routine = undefined; let settingsDoc = undefined;
  // Phase 5.4b: device usage events + season states (started once the Home has device-triggered tasks).
  let stopE = null; let stopD = null; let deviceEvents = []; let deviceStates = new Map();
  // Phase 5.4c: custom templates (only while the Templates / AI import views are used).
  let stopTpl = null; let templates = undefined;
  const listeners = new Set();
  const emit = () => { cache = null; for (const fn of [...listeners]) fn(snapshot()); };
  const guard = () => { if (disposed) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE); };
  function snapshot() {
    if (cache) return cache;
    const s = [st.t, st.o].filter((x) => x !== 'idle');
    cache = Object.freeze({ status: !s.length ? 'idle' : s.includes('error') ? 'error' : s.every((x) => x === 'ready') ? 'ready' : 'loading', error: lastError, tasks, occurrences,
      routine, routineDay, settings: settingsDoc,   // routine/settings: undefined = loading, null = none
      deviceEvents, deviceStates, templates });   // templates: undefined = not loaded
    return cache;
  }
  // Occurrence history window: enough to schedule 'after' tasks from their last completion
  // (e.g. every 3 months → ~100 days), bounded by MAX_RANGE_DAYS. Re-subscribes only when it grows.
  function watchWindow() {
    const need = historyDaysNeeded(tasks);
    if (stopO && need <= windowDays) return;
    if (stopO) stopO();
    windowDays = need; st.o = 'loading';
    stopO = repo.watchOccurrences(homeId, addDays(today(), -need), (d) => { occurrences = d; st.o = 'ready'; emit(); }, (e) => { st.o = 'error'; lastError = e; emit(); });
  }
  /** Phase 5.4b: device listeners only when some task has a device trigger (others gain no listeners). */
  function watchDevices(force = false) {
    if (stopE || !repo.watchDeviceEvents) return;
    if (!force && !tasks.some((t) => t.trigger)) return;
    const since = new Date(Date.parse(`${addDays(today(), -DEVICE_EVENT_WINDOW_DAYS)}T00:00:00Z`));
    stopE = repo.watchDeviceEvents(homeId, since, (d) => { deviceEvents = d; emit(); }, (e) => { lastError = e; emit(); });
    stopD = repo.watchDeviceStates(homeId, (d) => { deviceStates = new Map(d.map((x) => [x.id, x])); emit(); }, (e) => { lastError = e; emit(); });
  }
  const task = (id) => tasks.find((t) => t.id === id) || null;
  const occ = (taskId, date) => occurrences.find((o) => o.id === occurrenceId(taskId, date)) || null;

  let bulkBusy = false;   // V6.3: one bulk operation at a time in this tab
  const api = {
    homeId,
    ensure({ canView }) {
      guard();
      if (canView && !stopT) {
        st.t = 'loading'; st.o = 'loading';
        stopT = repo.watchTasks(homeId, (d) => { tasks = d; st.t = 'ready'; watchWindow(); watchDevices(); emit(); }, (e) => { st.t = 'error'; lastError = e; emit(); });
        watchWindow();
      }
    },
    subscribe(fn) { guard(); listeners.add(fn); fn(snapshot()); return () => listeners.delete(fn); },
    getSnapshot: snapshot, task, occ,
    now: () => repo.now(),   // server timestamp sentinel for writes built outside the store (setup plan)
    listenerCount: () => (stopT ? 1 : 0) + (stopO ? 1 : 0) + (stopR ? 1 : 0) + (stopS ? 1 : 0) + (stopE ? 1 : 0) + (stopD ? 1 : 0) + (stopTpl ? 1 : 0),

    async createTask(input, { memberUids }) {
      guard();
      const id = repo.newId(homeId);
      await repo.commit(homeId, [{ mode: 'set', name: TASKS, id, data: buildTaskCreate({ input, uid, memberUids, now: repo.now() }) }]);
      return id;
    },
    async updateTask(id, input, { memberUids, baseGen = null }) {
      guard();
      const cur = task(id); if (!cur) throw fail('cleaning.validation.notFound');
      // V6.3.0.1: a form opened before a reset must not write the old schedule back over it
      if (Number.isInteger(baseGen) && genOf(cur) !== baseGen) throw fail('cleaning.validation.conflict');
      const { value: v, errors } = validateTaskInput({ ...cur, ...input }, { memberUids, generated: !!(cur.source || cur.templateRef) });
      if (Object.keys(errors).length) throw fail(Object.keys(errors).join(','));
      const patch = {};
      for (const k of TASK_EDITABLE) if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(v[k] ?? null)) patch[k] = v[k];
      if (!Object.keys(patch).length) return false;
      await repo.commit(homeId, [{ mode: 'update', name: TASKS, id, data: { ...patch, updatedBy: uid, updatedAt: repo.now() } }]);
      return true;
    },
    async archiveTask(id) { guard(); await repo.commit(homeId, [{ mode: 'update', name: TASKS, id, data: { active: false, archivedAt: repo.now(), archivedBy: uid, updatedBy: uid, updatedAt: repo.now() } }]); },
    async restoreTask(id) { guard(); await repo.commit(homeId, [{ mode: 'update', name: TASKS, id, data: { active: true, archivedAt: null, archivedBy: null, updatedBy: uid, updatedAt: repo.now() } }]); },

    /**
     * claim | complete | unclaim | reopen — ONE batch: occurrence (rev n → n+1) + audit log entry.
     * A rules denial means someone else acted first (or no permission): 'cleaning.validation.conflict'.
     */
    async act(taskId, date, action, notes, extra = {}) {
      guard();
      const t = task(taskId); if (!t) throw fail('cleaning.validation.notFound');
      // Phase 5.4b: device-triggered items address their exact occurrence id.
      const current = extra.occId ? occurrences.find((o) => o.id === extra.occId) || null : occ(taskId, date);
      const b = buildAction({ task: t, date, occ: current, action, uid, notes, now: repo.now(), ...extra });
      try {
        await repo.commit(homeId, [
          { mode: b.create ? 'set' : 'update', name: OCC, id: b.id, data: b.data },
          { mode: 'set', name: LOG, id: b.log.id, data: b.log.data },
        ]);
      } catch (e) { if (denied(e)) throw fail('cleaning.validation.conflict'); throw e; }
      return b.id;
    },
    history: (occurrenceId_) => repo.readLog(homeId, occurrenceId_),
    historyWindowDays: () => windowDays,
    /**
     * Phase 5.3.2 hotfix: commit a reviewed setup plan ONE TASK PER WRITE.
     * v5.7.1 sent every task in a single batched write; Firestore applies its rule limits to the
     * whole batch, so a realistic household's setup was rejected as a whole — and the SDK's
     * optimistic copies (tasks briefly visible) were rolled back. Now:
     *   - every task is its own write; progress counts only CONFIRMED (awaited) saves;
     *   - a failure never undoes saved tasks; the rest continue (a network error stops new attempts);
     *   - a rejected create is classified by a server read: exists → already added (concurrent
     *     setup, not an error); absent → genuine failure (reported with its task id);
     *   - payloads are pre-checked with the rules' constraints and never sent if invalid;
     *   - deterministic ids: retrying never duplicates.
     */
    _applySetupRaw(writes) { return api.applySetup(writes, { concurrency: 1 }); },
    async applySetup(writes, { onProgress = () => {}, concurrency = 4 } = {}) {
      guard();
      const result = { total: writes.length, saved: 0, alreadyExisted: 0, failed: [], remaining: 0 };
      const queue = [];
      for (const w of writes) {
        if (task(w.id)) { result.alreadyExisted++; continue; }              // already present (or declined)
        const problems = generatedPayloadProblems(w);
        if (problems.length) { result.failed.push({ id: w.id, title: w.data.title, reason: 'invalid', detail: problems.join(',') }); continue; }
        queue.push(w);
      }
      let stopped = false; let next = 0;
      const report = () => onProgress({ ...result, failed: [...result.failed] });
      report();
      const worker = async () => {
        while (!stopped && next < queue.length) {
          const w = queue[next++];
          try {
            await repo.commit(homeId, [{ mode: 'set', name: TASKS, id: w.id, data: w.data }]);   // resolves only after the server accepts
            result.saved++;
          } catch (e) {
            if (denied(e)) {
              let exists = false;
              try { exists = await repo.taskExists(homeId, w.id); } catch { exists = false; }
              if (exists) result.alreadyExisted++;
              else result.failed.push({ id: w.id, title: w.data.title, reason: 'denied' });
            } else {
              result.failed.push({ id: w.id, title: w.data.title, reason: 'network' });
              stopped = true;                                                   // offline / unavailable: stop new attempts
            }
          }
          report();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
      result.remaining = queue.length - next;                                   // never attempted (after a network stop)
      report();
      return result;
    },

    // ---------------------------------------------------------------- Phase 5.4a (Advanced)
    /** Start the settings listener and the routine listener for `day` (re-targets when the day changes). */
    ensureAdvanced(day) {
      guard();
      if (!stopS) stopS = repo.watchSettings(homeId, (d) => { settingsDoc = d; emit(); }, (e) => { lastError = e; settingsDoc = null; emit(); });
      if (day && day !== routineDay) {
        if (stopR) stopR();
        routineDay = day; routine = undefined;
        stopR = repo.watchRoutine(homeId, day, (d) => { routine = d; emit(); }, (e) => { lastError = e; routine = null; emit(); });
      }
    },
    /**
     * Save the day's plan ONCE (create-only, id = the day). If someone else saved it first, the
     * create is refused; a server read confirms the plan exists → treated as success (theirs is used).
     */
    async createRoutine(day, keys, settings) {
      guard();
      try {
        await repo.commit(homeId, [{ mode: 'set', name: ROUTINES, id: day, data: {
          date: day, items: keys.slice(0, 200), catchUpMax: settings.catchUpMax, startHour: settings.startHour,
          createdBy: uid, createdAt: repo.now(), schemaVersion: 1 } }]);
        return 'created';
      } catch (e) {
        if (denied(e)) { let exists = false; try { exists = await repo.routineExists(homeId, day); } catch { exists = false; } if (exists) return 'existing'; }
        throw e;
      }
    },
    async saveSettings(values) {
      guard();
      await repo.commit(homeId, [{ mode: 'set', name: SETTINGS, id: 'general', data: {
        catchUpMax: values.catchUpMax, startHour: values.startHour, updatedBy: uid, updatedAt: repo.now(), schemaVersion: 1 } }]);
    },
    /**
     * Whole-room / multi-task action: ONE confirmed write per task (never a big batch), progress
     * counts confirmed saves only, a failure never undoes earlier saves; honest result.
     */
    async actMany(items, action, { onProgress = () => {}, extra = {} } = {}) {
      guard();
      const res = { total: items.length, saved: 0, failed: [] };
      onProgress({ ...res });
      for (const it of items) {
        try { await api.act(it.taskId, it.date, it.action || action, it.notes || null, { ...extra, ...(it.extra || {}) }); res.saved++; }   // 5.4b: per-item occurrence id; V6.1: optional per-item action (reset)
        catch (e) { res.failed.push({ taskId: it.taskId, date: it.date, detail: e && e.detail ? e.detail : 'error' }); }
        onProgress({ ...res, failed: [...res.failed] });
      }
      return res;
    },
    loadLogSince: (sinceDate) => repo.readLogSince(homeId, sinceDate),

    // ---------------------------------------------------------------- V6.3 bulk operations
    /** Is a Mark All Done / reset / restore running in this tab? (double clicks never start a second one) */
    bulkBusy: () => bulkBusy,
    /**
     * Mark All Done on a CAPTURED selection (cleaning-ops.completableItems). Re-validated against live
     * data first; then one audited write per item (rules check each). An item done meanwhile (another
     * tab / device / member) counts as `already`, never as a second completion. Re-run = retry.
     */
    async completeSelection(selection, { can, isChild, onProgress = () => {} } = {}) {
      guard(); if (bulkBusy) throw fail('cleaning.bulk.busy');
      bulkBusy = true;
      const { todo, already, gone } = revalidate(selection, { tasks, occurrences, uid, can, isChild });
      const res = { total: selection.length, saved: 0, already: already.length, skipped: gone.length, failed: [] };
      try {
        onProgress({ ...res });
        for (const it of todo) {
          try { await api.act(it.taskId, it.date, 'complete', null, it.extra || {}); res.saved++; }
          catch (e) {
            const o = occurrences.find((x) => x.id === it.key);
            if (o && o.status === 'done') res.already++; else res.failed.push({ ...it, detail: e && e.detail ? e.detail : 'error' });
          }
          onProgress({ ...res, failed: [...res.failed] });
        }
      } finally { bulkBusy = false; }
      return res;
    },
    /** Run task updates (V6.3 resets). Only cleaningTasks documents are written. */
    async _patchTasks(list, res, onProgress) {
      for (const p of list) {
        // V6.3.0.1: an already-applied generation (retry / other device did it) is success, not a second bump
        const live = task(p.id);
        if (Number.isInteger(p.data.resetGen) && live && genOf(live) === p.data.resetGen && Object.keys(p.data).every((k) => JSON.stringify(live[k] ?? null) === JSON.stringify(p.data[k]))) {
          res.saved++; onProgress({ ...res, failed: [...res.failed] }); continue;
        }
        try { await repo.commit(homeId, [{ mode: 'update', name: TASKS, id: p.id, data: { ...p.data, updatedBy: uid, updatedAt: repo.now() } }]); res.saved++; }
        catch (e) { res.failed.push({ kind: 'patch', item: p, detail: denied(e) ? 'cleaning.validation.conflict' : 'network' }); }
        onProgress({ ...res, failed: [...res.failed] });
      }
    },
    async _undo(list, res, onProgress) {
      for (const it of list) {
        const o = occurrences.find((x) => x.id === it.key);
        if (!o || o.status === 'open') { res.saved++; onProgress({ ...res, failed: [...res.failed] }); continue; }   // already undone (retry / other tab)
        try { await api.act(it.taskId, it.date, it.action, null, it.extra || {}); res.saved++; }
        catch (e) {
          // V6.3.0.1: another device's reset undid it at the same time (same generation) → that is success
          const now = occurrences.find((x) => x.id === it.key);
          if (now && now.status === 'open' && (now.taskGen ?? 0) === (it.extra && Number.isInteger(it.extra.taskGen) ? it.extra.taskGen : 0)) res.saved++;
          else res.failed.push({ kind: 'undo', item: it, detail: e && e.detail ? e.detail : 'error' });
        }
        onProgress({ ...res, failed: [...res.failed] });
      }
    },
    /**
     * Reset task progress (cleaning-ops.progressResetPlan): undo today's / later progress with the audited
     * inverse actions, then restart recurring schedules today. Failed steps are returned as a plan
     * ({ patches, undo }) so "Retry" repeats ONLY them (never undoes progress made after the reset).
     */
    async resetProgress(plan, { onProgress = () => {} } = {}) {
      guard(); if (bulkBusy) throw fail('cleaning.bulk.busy');
      bulkBusy = true; const res = { total: plan.undo.length + plan.patches.length, saved: 0, failed: [] };
      // V6.3.0.1: generation first, then undo under the new generation. Undo of a task whose bump failed is
      // not attempted (it would be refused) — it stays in the retry plan together with its patch.
      try {
        onProgress({ ...res }); await api._patchTasks(plan.patches, res, onProgress);
        const notBumped = new Set(res.failed.filter((f) => f.kind === 'patch').map((f) => f.item.id));
        for (const it of plan.undo) if (notBumped.has(it.taskId)) { res.failed.push({ kind: 'undo', item: it, detail: 'cleaning.validation.conflict' }); onProgress({ ...res, failed: [...res.failed] }); }
        await api._undo(plan.undo.filter((it) => !notBumped.has(it.taskId)), res, onProgress);
      } finally { bulkBusy = false; }
      return { ...res, retry: { undo: res.failed.filter((f) => f.kind === 'undo').map((f) => f.item), patches: res.failed.filter((f) => f.kind === 'patch').map((f) => f.item) } };
    },
    /**
     * Restore default tasks (cleaning-ops.restoreDefaultsPlan): archive custom tasks only when asked,
     * reactivate archived defaults, create missing ones (deterministic ids; existing = already there),
     * restore definitions, then reset the defaults' progress. Never writes rooms / devices.
     */
    async restoreDefaults(plan, { today, onProgress = () => {} } = {}) {
      guard(); if (bulkBusy) throw fail('cleaning.bulk.busy');
      bulkBusy = true;
      const res = { total: plan.archiveCustom.length + plan.reactivate.length + plan.creates.length + plan.patches.length, saved: 0, already: 0, failed: [] };
      try {
        onProgress({ ...res });
        for (const [list, active, kind] of [[plan.archiveCustom, false, 'archive'], [plan.reactivate, true, 'reactivate']]) {
          for (const id of list) {
            try { await repo.commit(homeId, [{ mode: 'update', name: TASKS, id, data: active ? { active: true, archivedAt: null, archivedBy: null, updatedBy: uid, updatedAt: repo.now() }
              : { active: false, archivedAt: repo.now(), archivedBy: uid, updatedBy: uid, updatedAt: repo.now() } }]); res.saved++; }
            catch (e) { res.failed.push({ kind, item: id, detail: denied(e) ? 'cleaning.validation.conflict' : 'network' }); }
            onProgress({ ...res, failed: [...res.failed] });
          }
        }
        if (plan.creates.length) {
          const c = await api._applySetupRaw(plan.creates);
          res.saved += c.saved; res.already += c.alreadyExisted; for (const f of c.failed) res.failed.push({ kind: 'create', item: plan.creates.find((w) => w.id === f.id), detail: f.reason });
          onProgress({ ...res, failed: [...res.failed] });
        }
        // V6.3.0.1: definition + generation bump in ONE write per restored default, then undo under the new generation
        const patches = restoreGenPatches(plan);
        res.total += patches.length - plan.patches.length;
        await api._patchTasks(patches, res, onProgress);
        const notBumped = new Set(res.failed.filter((f) => f.kind === 'patch').map((f) => f.item.id));
        const undo = restoreUndo(plan.resetTasks, occurrences, today).filter((it) => !notBumped.has(it.taskId));
        res.total += undo.length;
        await api._undo(undo, res, onProgress);
      } finally { bulkBusy = false; }
      return res;
    },

    // ---------------------------------------------------------------- Phase 5.4b (devices)
    watchDevices: () => watchDevices(true),
    newEventId: () => repo.newEventId(homeId),
    /**
     * Record a device use. The CALLER keeps `eventId` and reuses it on retry, so a retry or a
     * double click can never create two events (create-only id). Confirmed before resolving.
     */
    async logUse(deviceId, { eventId, note = null }) {
      guard();
      const n = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      try {
        await repo.commit(homeId, [{ mode: 'set', name: DEV_EVENTS, id: eventId, data: {
          deviceId, kind: 'use', voidsEventId: null, note: n || null, actorUid: uid, at: repo.now(), schemaVersion: 1 } }]);
        return 'created';
      } catch (e) {
        if (denied(e)) { let exists = false; try { exists = await repo.eventExists(homeId, eventId); } catch { exists = false; } if (exists) return 'existing'; }
        throw e;
      }
    },
    /** Correct a mistaken use: a NEW audited 'void' event (<eventId>_void, at most one). Nothing is deleted. */
    async voidUse(deviceId, eventId, note = null) {
      guard();
      const n = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      try {
        await repo.commit(homeId, [{ mode: 'set', name: DEV_EVENTS, id: `${eventId}_void`, data: {
          deviceId, kind: 'void', voidsEventId: eventId, note: n || null, actorUid: uid, at: repo.now(), schemaVersion: 1 } }]);
      } catch (e) { if (denied(e)) throw fail('cleaning.device.voidConflict'); throw e; }
    },
    /**
     * Switch a device's season. ONE batch: state (rev n → n+1) + its append-only season entry
     * <deviceId>_s<n+1>. A concurrent / stale toggle is refused by the rules → 'seasonConflict'.
     */
    async setSeason(deviceId, state, note = null) {
      guard();
      const cur = deviceStates.get(deviceId) || null;
      if (cur && cur.state === state) throw fail('cleaning.device.seasonUnchanged');
      const rev = (cur ? cur.rev || 0 : 0) + 1; const now = repo.now();
      const n = typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
      try {
        await repo.commit(homeId, [
          { mode: cur ? 'update' : 'set', name: DEV_STATE, id: deviceId, data: { state, rev, updatedBy: uid, updatedAt: now, ...(cur ? {} : { schemaVersion: 1 }) } },
          { mode: 'set', name: DEV_SEASONS, id: `${deviceId}_s${rev}`, data: { deviceId, rev, state, note: n || null, actorUid: uid, at: now, schemaVersion: 1 } },
        ]);
      } catch (e) { if (denied(e)) throw fail('cleaning.device.seasonConflict'); throw e; }
      return rev;
    },
    seasonHistory: (deviceId) => repo.readSeasonLog(homeId, deviceId),

    // ---------------------------------------------------------------- Phase 5.4c (custom templates)
    ensureTemplates() {
      guard();
      if (stopTpl) return;
      stopTpl = repo.watchTemplates(homeId, (d) => { templates = d; emit(); }, (e) => { lastError = e; templates = []; emit(); });
    },
    template: (id) => (templates || []).find((t) => t.id === id) || null,
    async createTemplate(input) {
      guard();
      const { value, errors } = validateTemplate(input);
      if (Object.keys(errors).length) throw fail(Object.values(errors)[0], errors);
      const id = repo.newTemplateId(homeId);
      await repo.commit(homeId, [{ mode: 'set', name: TEMPLATES, id, data: templateCreateDoc(value, { uid, now: repo.now() }) }]);
      return id;
    },
    /** Edit / archive / reactivate: rev n → n+1. A concurrent edit makes this one fail → 'templateConflict'. */
    async changeTemplate(id, change) {
      guard();
      const cur = api.template(id); if (!cur) throw fail('cleaning.validation.notFound');
      let patch;
      if (change === 'archive' || change === 'reactivate') patch = templatePatch(cur, change, { uid, now: repo.now() });
      else {
        const { value, errors } = validateTemplate({ ...cur, ...change });
        if (Object.keys(errors).length) throw fail(Object.values(errors)[0], errors);
        patch = templatePatch(cur, value, { uid, now: repo.now() });
      }
      try { await repo.commit(homeId, [{ mode: 'update', name: TEMPLATES, id, data: patch }]); }
      catch (e) { if (denied(e)) throw fail('cleaning.tpl.err.conflict'); throw e; }
    },
    duplicateTemplate(id) {
      const cur = api.template(id); if (!cur) throw fail('cleaning.validation.notFound');
      const { pack, title, titleEn, instructions, minutes, priority, target, recurrence, trigger } = cur;
      return api.createTemplate({ pack, title: `${title}`.slice(0, 112) + ' (2)', titleEn, instructions, minutes, priority, target, recurrence, trigger });
    },
    /**
     * Create documents ONE PER REQUEST (template apply, AI import). Progress counts confirmed saves only;
     * a rejected create is classified by a server read (exists → already there, e.g. another member or a
     * retry); a network error stops new attempts; saved documents are never undone. Ids are
     * deterministic, so a retry never duplicates.
     */
    async createManyConfirmed(name, writes, { onProgress = () => {} } = {}) {
      guard();
      const result = { total: writes.length, saved: 0, alreadyExisted: 0, failed: [], remaining: 0 };
      onProgress({ ...result });
      let i = 0; let stopped = false;
      for (; i < writes.length && !stopped; i++) {
        const w = writes[i];
        try { await repo.commit(homeId, [{ mode: 'set', name, id: w.id, data: w.data }]); result.saved++; }
        catch (e) {
          if (denied(e)) {
            let exists = false; try { exists = await repo.docExists(homeId, name, w.id); } catch { exists = false; }
            if (exists) result.alreadyExisted++; else result.failed.push({ id: w.id, title: w.data.title, reason: 'denied' });
          } else { result.failed.push({ id: w.id, title: w.data.title, reason: 'network' }); stopped = true; }
        }
        onProgress({ ...result, failed: [...result.failed] });
      }
      result.remaining = writes.length - i;
      onProgress({ ...result, failed: [...result.failed] });
      return result;
    },

    dispose() { disposed = true; if (stopT) stopT(); if (stopO) stopO(); if (stopR) stopR(); if (stopS) stopS(); if (stopE) stopE(); if (stopD) stopD(); if (stopTpl) stopTpl(); stopR = stopS = stopE = stopD = stopTpl = null; stopT = stopO = null; listeners.clear(); tasks = []; occurrences = []; cache = null; },
  };
  return Object.freeze(api);
}
