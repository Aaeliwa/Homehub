/**
 * V6.3 Cleaning bulk operations — PURE (no Firebase, no DOM). The store executes the plans with the
 * EXISTING audited writes (occurrence + log batch per item; task updates), so the rules check every
 * single write. Nothing here touches rooms or devices: plans only name cleaning tasks / occurrences.
 *
 *  - Mark All Done: exactly the pending items currently SHOWN by a routine (Today's / Quick), captured
 *    at confirmation and re-validated against live data at commit.
 *  - Reset task progress: the schedule restarts today. Recurring tasks get startDate = today, so earlier
 *    dates (and progress on them) are no longer part of the schedule (the model ignores occurrences
 *    dated before startDate; the rules refuse NEW occurrences before it). Progress already recorded for
 *    today or later is undone with the existing inverse action (reopen / unclaim / resume → audited).
 *  - Restore default tasks: room / device template tasks get their original definition back (stable
 *    ids r_/d_<source>_<key>; archived defaults are reactivated; missing ones created), then their
 *    progress is reset. Custom tasks are kept unless the caller explicitly asks to remove (archive) them.
 */
import { ACTION_FROM, mayAct, occurrenceId, resetActionFor } from './cleaning-model.js';
import { buildSetupPlan, planWrites, buildGeneratedTask, generatableAs, periodDays, roomTemplateFor, deviceTemplateFor, generatedTaskId } from './cleaning-integration.js';

export const BULK_MAX = 200;
/** V6.3.0.1: reset generation of a task (absent = 0). Bumped by every progress reset / default restore. */
export const genOf = (tk) => (tk && Number.isInteger(tk.resetGen) ? tk.resetGen : 0);   // one confirmation never writes more than this many items
const PENDING = new Set(ACTION_FROM.complete);   // open / claimed / postponed / skipped

/** Items of a routine view that this user may complete now (status pending, task active, eligible). */
export function completableItems(items, { uid, can, isChild }) {
  const seen = new Set(); const out = [];
  for (const it of items) {
    if (!it || !it.task || it.task.active !== true || it.state === 'inactive') continue;
    const status = it.occ ? it.occ.status : 'open';
    if (!PENDING.has(status) || !mayAct(it.task, { uid, can, isChild })) continue;
    const key = it.occId || occurrenceId(it.task.id, it.date);
    if (seen.has(key)) continue; seen.add(key);
    const gen = genOf(it.task);   // V6.3.0.1: captured at confirmation; enforced by the rules at commit
    out.push({ key, taskId: it.task.id, date: it.date, gen, extra: { taskGen: gen, ...(it.occId ? { occId: it.occId, triggerEventId: it.triggerEventId || null, triggerSeasonRev: Number.isInteger(it.triggerSeasonRev) ? it.triggerSeasonRev : null } : {}) } });
  }
  return out.slice(0, BULK_MAX);
}

/**
 * Re-check a captured selection against LIVE data right before writing: an item stays only if its task
 * is still active and in schedule, the user may still act and the occurrence is still pending.
 * Returns { todo, already, gone } — `already` = done meanwhile (another tab / device / member).
 */
export function revalidate(selection, { tasks, occurrences, uid, can, isChild }) {
  const taskById = new Map(tasks.map((x) => [x.id, x])); const occById = new Map(occurrences.map((o) => [o.id, o]));
  const todo = []; const already = []; const gone = [];
  for (const it of selection) {
    const task = taskById.get(it.taskId);
    if (!task || task.active !== true || !mayAct(task, { uid, can, isChild }) || (!task.trigger && it.date && it.date < task.startDate)
      || genOf(task) !== (Number.isInteger(it.gen) ? it.gen : genOf(task))) { gone.push(it); continue; }   // reset since confirmation → never applied
    const occ = occById.get(it.key) || null; const status = occ ? occ.status : 'open';
    if (status === 'done') already.push(it); else if (PENDING.has(status)) todo.push(it); else gone.push(it);
  }
  return { todo, already, gone };
}

/** Inverse actions for progress recorded on or after `fromDate` (same rights as the per-item undo). */
function undoProgress(genById, occurrences, fromDate) {
  return occurrences.filter((o) => genById.has(o.taskId) && !(o.dueDate < fromDate) && resetActionFor(o))
    .map((o) => ({ key: o.id, taskId: o.taskId, date: o.dueDate, action: resetActionFor(o), extra: { occId: o.id, taskGen: genById.get(o.taskId) } }));
}

/**
 * Reset task progress plan for `tasks` (active ones). Recurring, non-device-triggered tasks whose
 * schedule started before today move their startDate to today; one-off tasks due in the past are
 * history (left alone); device-triggered tasks keep their trigger basis. Returns
 * { patches: [{ id, data }], undo: [{ key, taskId, date, action, extra }] }.
 */
export function progressResetPlan({ tasks, occurrences, today }) {
  // V6.3.0.1: every task in scope moves to the NEXT generation FIRST (one write each); the undo writes carry
  // that generation, and any write decided under the old one (stale tab / device, captured bulk
  // selection, interrupted retry) is refused by the rules — so pre-reset state can never be re-applied.
  const patches = []; const gens = new Map();
  for (const tk of tasks) {
    if (tk.active !== true) continue;
    const r = tk.recurrence || { kind: 'once' };
    if (r.kind === 'once' && !((tk.dueDate || tk.startDate) >= today)) continue;
    const resetGen = genOf(tk) + 1; gens.set(tk.id, resetGen);
    patches.push({ id: tk.id, data: { resetGen, ...(r.kind !== 'once' && !tk.trigger && tk.startDate < today ? { startDate: today } : {}) } });
  }
  return { patches, undo: undoProgress(gens, occurrences, today) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const isCustomTask = (tk) => !tk.source;

/**
 * Restore-defaults plan. Only ACTIVE rooms / devices with a template are considered (never creates
 * tasks for removed sources). Returns { reactivate: [id], patches: [{ id, data }], creates: [{ id, data }],
 * archiveCustom: [id], resetTasks: [task-like] } — idempotent: a second run on restored data is empty
 * except for progress already reset.
 */
export function restoreDefaultsPlan({ rooms = [], devices = [], tasks = [], lang, uid, now, today, removeCustom = false }) {
  const reactivate = []; const patches = []; const archiveCustom = [];
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const kept = removeCustom ? tasks.filter((x) => !isCustomTask(x)) : tasks;
  if (removeCustom) for (const x of tasks) if (isCustomTask(x) && x.active === true) archiveCustom.push(x.id);
  // missing defaults → the existing setup plan (covered-by-title only against the tasks we keep)
  const setup = buildSetupPlan({ rooms, devices, tasks: kept.filter((x) => x.active === true || x.source) });
  const creates = planWrites({ plan: setup, accepted: new Set(setup.pending.flatMap((g) => g.add.map((a) => a.id))), lang, uid, now, today });
  // existing defaults → original definition, schedule from today (staggered like a fresh setup)
  const sp = { n: 0 }; const restored = [];
  const consider = (kind, src, T) => {
    for (const tt of T.tasks) {
      const how = kind === 'room' ? (tt.generate ? 'periodic' : null) : generatableAs(T, tt);
      if (!how) continue;
      const id = generatedTaskId(kind, src.id, tt.key); const cur = byId.get(id); if (!cur) continue;
      const p = periodDays(tt.freq); const offset = p > 1 ? (sp.n++) % Math.min(p, 7) : 0;
      const def = buildGeneratedTask({ kind, source: src, template: T, item: { template: tt }, lang, uid, now, today, offset });
      if (cur.active !== true) reactivate.push(id);
      const want = { title: def.title, instructions: def.instructions, roomId: def.roomId, priority: def.priority, assignMode: 'shared', assigneeUids: [], eligibleUids: [],
        ...(cur.trigger ? {} : { recurrence: def.recurrence, startDate: def.startDate }), dueDate: null, endDate: null, estimatedMinutes: def.estimatedMinutes };
      const data = {}; for (const [k, v] of Object.entries(want)) if (!same(cur[k] ?? null, v)) data[k] = v;
      // a recurring task's schedule restarts (no earlier start date kept even when the definition matched)
      if (!cur.trigger && cur.startDate < today && !('startDate' in data)) data.startDate = def.startDate;
      if (Object.keys(data).length) patches.push({ id, data });
      restored.push({ ...cur, ...data, active: true });
    }
  };
  for (const r of rooms) { if (r.active === false) continue; const T = roomTemplateFor(r); if (T) consider('room', r, T); }
  for (const d of devices) { if (d.active === false) continue; const T = deviceTemplateFor(d); if (T) consider('device', d, T); }
  return { reactivate, patches, creates, archiveCustom, resetTasks: restored };
}

/** Progress to undo for restored defaults (dates on / after today). */
export const restoreUndo = (restoredTasks, occurrences, today) => undoProgress(new Map(restoredTasks.map((x) => [x.id, genOf(x) + 1])), occurrences, today);
/** V6.3.0.1: the restored defaults' generation bump, merged with their definition patch (one write per task). */
export function restoreGenPatches(plan) {
  const def = new Map(plan.patches.map((p) => [p.id, p.data]));
  return plan.resetTasks.map((x) => ({ id: x.id, data: { ...(def.get(x.id) || {}), resetGen: genOf(x) + 1 } }));
}
