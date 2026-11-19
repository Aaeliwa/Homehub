import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplate, templateCreateDoc, templatePatch, buildApplyPlan, customTaskId, templateFromBuiltIn } from '../../src/modules/cleaning/cleaning-custom.js';
import { parsePlan, normalizeItem, buildImportPreview, buildPrompt, SAMPLE_PLAN, fnv64, mapFrequency } from '../../src/modules/cleaning/cleaning-ai-import.js';
import { whenToDef, defToWhen } from '../../src/modules/cleaning/advanced-templates.js';
import { ROOM_TEMPLATES, DEVICE_TEMPLATES } from '../../src/modules/cleaning/cleaning-templates.js';
import { generatableAs } from '../../src/modules/cleaning/cleaning-integration.js';
import { createCleaningStore } from '../../src/modules/cleaning/cleaning-store.js';

const ok = (x) => Object.keys(validateTemplate(x).errors).length === 0;
const D = { pack: 'Kitchen', title: 'مسح السطح', minutes: 5, priority: 'normal', target: 'room', recurrence: { kind: 'after', unit: 'day', interval: 1 } };

test('templates: valid / invalid combinations match the model and rules', () => {
  assert.ok(ok(D)); assert.ok(ok({ ...D, target: 'home', recurrence: { kind: 'weeks', interval: 1, weekdays: [5] } }));
  assert.ok(!ok({ ...D, recurrence: { kind: 'once' } }), 'no dates → never once');
  assert.ok(ok({ ...D, target: 'device' }), 'Phase 5.4d: a periodic device template (plain device link) is valid');
  assert.ok(!ok({ ...D, trigger: { kind: 'afterUse' }, recurrence: { kind: 'onUse' } }), 'trigger needs a device target');
  assert.ok(ok({ ...D, target: 'device', trigger: { kind: 'afterUse' }, recurrence: { kind: 'onUse' } }));
  assert.ok(!ok({ ...D, target: 'device', trigger: { kind: 'afterUse' } }), 'afterUse ⇒ onUse');
  assert.ok(ok({ ...D, target: 'device', trigger: { kind: 'seasonal', phase: 'start' }, recurrence: { kind: 'onSeason' } }));
  assert.ok(!ok({ ...D, target: 'device', trigger: { kind: 'seasonal', phase: 'start' } }), 'season start ⇒ onSeason');
  assert.ok(!ok({ ...D, recurrence: { kind: 'onUse' } }), 'onUse needs a trigger');
  assert.ok(!ok({ ...D, minutes: 0 })); assert.ok(!ok({ ...D, title: 'x'.repeat(121) })); assert.ok(!ok({ ...D, target: 'garage' }));
  assert.equal(validateTemplate({ ...D, pack: '' }).value.pack, 'General');
  for (const w of ['afterDays', 'afterMonths', 'weekly', 'monthly', 'afterUse', 'inSeason', 'seasonStart', 'seasonEnd']) {
    const def = whenToDef(w, { n: 3, weekday: 2, day: 15 });
    assert.ok(ok({ ...D, ...def }), w);
    assert.equal(defToWhen(def).when, w, `${w} round-trips`);
  }
  // Every generatable built-in can be duplicated into a valid custom template.
  for (const T of ROOM_TEMPLATES) for (const tt of T.tasks) assert.ok(ok(templateFromBuiltIn('room', T, tt, 'periodic')), tt.key);
  for (const T of DEVICE_TEMPLATES) for (const tt of T.tasks) { const how = generatableAs(T, tt); if (how) assert.ok(ok(templateFromBuiltIn('device', T, tt, how)), tt.key); }
});

test('template revisions: create rev 1; edit / archive / reactivate → rev + 1', () => {
  const c = templateCreateDoc(validateTemplate(D).value, { uid: 'u', now: 'N' });
  assert.deepEqual([c.rev, c.active, c.archivedAt, c.createdBy], [1, true, null, 'u']);
  assert.deepEqual(templatePatch({ rev: 4 }, 'archive', { uid: 'w', now: 'N' }), { rev: 5, updatedBy: 'w', updatedAt: 'N', active: false, archivedAt: 'N', archivedBy: 'w' });
  assert.deepEqual(templatePatch({ rev: 5 }, 'reactivate', { uid: 'w', now: 'N' }).archivedAt, null);
  assert.equal(templatePatch({ rev: 1 }, { title: 'x' }, { uid: 'u', now: 'N' }).rev, 2);
});

test('apply plan: deterministic id; exists (incl. archived tombstone) / duplicate / invalid; device trigger bound to the device', () => {
  const tpRoom = { id: 'tplA', ...D, rev: 2, active: true }; const tpDev = { id: 'tplB', ...D, target: 'device', trigger: { kind: 'afterUse' }, recurrence: { kind: 'onUse' }, rev: 1, active: true };
  const room = { id: 'kit', name: 'Kitchen', active: true }; const dev = { id: 'af', name: 'AF', active: true };
  let plan = buildApplyPlan({ templates: [tpRoom, tpDev], target: { kind: 'room', item: room }, tasks: [], lang: 'ar', uid: 'u', now: 'N', today: '2026-10-18' });
  assert.deepEqual(plan.map((p) => [p.id, p.status]), [['c_tplA_kit', 'create'], ['c_tplB_kit', 'invalid']]);
  assert.equal(customTaskId('tplA', 'kit'), 'c_tplA_kit');
  const d = plan[0].data;
  assert.deepEqual([d.roomId, d.templateRef, d.estimatedMinutes, d.assignMode, d.startDate, 'trigger' in d], ['kit', { templateId: 'tplA', rev: 2 }, 5, 'shared', '2026-10-18', false]);
  plan = buildApplyPlan({ templates: [tpRoom], target: { kind: 'room', item: room }, tasks: [{ id: 'c_tplA_kit', active: false, title: 'x', roomId: 'kit' }], lang: 'ar', uid: 'u', now: 'N', today: '2026-10-18' });
  assert.equal(plan[0].status, 'exists', 'an archived (declined) task blocks re-creation');
  plan = buildApplyPlan({ templates: [tpRoom], target: { kind: 'room', item: room }, tasks: [{ id: 'm1', active: true, title: '  مسح   السطح ', roomId: 'kit' }], lang: 'ar', uid: 'u', now: 'N', today: '2026-10-18' });
  assert.equal(plan[0].status, 'duplicate');
  plan = buildApplyPlan({ templates: [{ ...tpRoom, active: false }], target: { kind: 'room', item: room }, tasks: [], lang: 'ar', uid: 'u', now: 'N', today: '2026-10-18' });
  assert.equal(plan[0].reason, 'cleaning.tpl.err.archived');
  plan = buildApplyPlan({ templates: [tpRoom], target: { kind: 'room', item: { ...room, active: false } }, tasks: [], lang: 'ar', uid: 'u', now: 'N', today: '2026-10-18' });
  assert.equal(plan[0].reason, 'cleaning.tpl.err.targetInactive');
  plan = buildApplyPlan({ templates: [tpDev], target: { kind: 'device', item: dev }, tasks: [], lang: 'ar', uid: 'u', now: 'N', today: '2026-10-18' });
  assert.deepEqual([plan[0].id, plan[0].data.trigger, plan[0].data.roomId], ['c_tplB_af', { kind: 'afterUse', deviceId: 'af' }, null]);
});

test('parser: size, JSON, fences, depth, dangerous keys (no prototype pollution), top-level contract', () => {
  assert.deepEqual(parsePlan('').errors, ['empty']);
  assert.deepEqual(parsePlan('x'.repeat(100 * 1024 + 1)).errors, ['tooLarge']);
  assert.deepEqual(parsePlan('{oops').errors, ['notJson']);
  assert.ok(parsePlan('```json\n' + JSON.stringify(SAMPLE_PLAN) + '\n```').ok, 'Markdown fences stripped');
  assert.ok(parsePlan('{"schemaVersion":1,"packageType":"homehub-cleaning-plan","tasks":[{"__proto__":{"polluted":true}}]}').errors.includes('dangerousKey'));
  assert.ok(parsePlan('{"constructor":{"prototype":{"x":1}}}').errors.includes('dangerousKey'));
  assert.equal({}.polluted, undefined, 'Object.prototype untouched');
  assert.ok(parsePlan(JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } })).errors.includes('tooDeep'));
  const P = (x) => parsePlan(JSON.stringify({ schemaVersion: 1, packageType: 'homehub-cleaning-plan', tasks: [{}], ...x }));
  assert.ok(P({ homeId: 'hX' }).errors.includes('unknownTopKey'), 'forged home id rejected');
  assert.ok(P({ schemaVersion: 2 }).errors.includes('unsupportedSchemaVersion'));
  assert.ok(P({ packageType: 'other' }).errors.includes('wrongPackageType'));
  assert.ok(P({ tasks: Array(101).fill({}) }).errors.includes('tooManyTasks'));
  assert.ok(P({ tasks: [] }).errors.includes('noItems'));
  assert.ok(parsePlan(JSON.stringify({ ...SAMPLE_PLAN, packageType: 'personal-routine' })).ok, 'standalone package accepted');
});

test('items: whitelist, forged fields, links, control chars, targets, unsupported triggers, frequency bounds', () => {
  const T = { title: 'Wipe', areaType: 'kitchen', frequency: { type: 'daily' }, estimatedMinutes: 5 };
  assert.deepEqual(normalizeItem(T, 'task').reasons, []);
  assert.deepEqual(normalizeItem(T, 'task').norm.recurrence, { kind: 'after', unit: 'day', interval: 1 });
  for (const [x, r] of [[{ id: 'abc' }, 'unknownField'], [{ createdBy: 'u' }, 'unknownField'], [{ title: 'see https://evil.example' }, 'title'],
    [{ note: 'www.x.com' }, 'note'], [{ title: 'a\u0007b' }, 'title'], [{ deviceType: 'fridge' }, 'roomOrDevice'], [{ areaType: 'garagez' }, 'unknownRoomType'],
    [{ estimatedMinutes: 241 }, 'minutes'], [{ estimatedMinutes: 2.5 }, 'minutes'], [{ priority: 'urgent' }, 'priority'],
    [{ frequency: { type: 'interval', unit: 'month', n: 13 } }, 'frequencyRange'], [{ frequency: { type: 'hourly' } }, 'frequency'], [{ triggerType: 'afterUse' }, 'triggerNeedsDevice']]) {
    assert.ok(normalizeItem({ ...T, ...x }, 'task').reasons.some((q) => q.startsWith(r)), `${JSON.stringify(x)} → ${r}`);
  }
  const Dv = { title: 'Basket', deviceType: 'airfryer', estimatedMinutes: 5 };
  assert.ok(normalizeItem({ ...Dv, triggerType: 'conditionBased' }, 'task').reasons.includes('unsupportedTrigger:conditionBased'));
  assert.ok(normalizeItem({ ...Dv, triggerType: 'manual' }, 'task').reasons.includes('unsupportedTrigger:manual'));
  assert.ok(normalizeItem({ ...Dv, triggerType: 'afterUse', frequency: { type: 'daily' } }, 'task').reasons.includes('frequencyNotAllowed'));
  assert.deepEqual(normalizeItem({ ...Dv, triggerType: 'afterCycle' }, 'task').norm.trigger, { kind: 'afterUse' });
  assert.deepEqual(normalizeItem({ ...Dv, triggerType: 'inSeason', frequency: { type: 'interval', unit: 'day', n: 14 } }, 'task').norm.trigger, { kind: 'seasonal', phase: 'active' });
  assert.deepEqual(mapFrequency({ type: 'weekly', weekday: 5 }).recurrence, { kind: 'weeks', interval: 1, weekdays: [5] });
  assert.deepEqual(mapFrequency({ type: 'monthly', day: 31 }).recurrence, { kind: 'months', interval: 1, dayOfMonth: 31 });
  assert.ok(mapFrequency({ type: 'daily', extra: 1 }).error);
});

const rooms = [{ id: 'kit', name: 'Kitchen', type: 'kitchen', active: true }, { id: 'bed', name: 'Bedroom', type: 'master_bedroom', active: true }, { id: 'bath', name: 'Bath', type: 'bathroom', active: true }];
const devices = [{ id: 'af', name: 'Air fryer', subtype: 'air_fryer', roomId: 'kit', active: true }];
const prev = (extra = {}) => buildImportPreview({ parsed: parsePlan(JSON.stringify(SAMPLE_PLAN)).data, rooms, devices, tasks: [], templates: [], lang: 'ar', uid: 'u', now: 'N', today: '2026-10-18', canCreateTasks: true, canEditTemplates: true, ...extra });

test('preview: real household mapping; deterministic ids (idempotent across runs); saved → duplicate; overrides; permissions', () => {
  const a = prev(); const b = prev();
  assert.deepEqual(a.map((x) => [x.kind, x.status]), [['task', 'create'], ['task', 'create'], ['task', 'create'], ['template', 'create']]);
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id), 'same ids on every run (retry / refresh / another member)');
  assert.ok(a.every((x) => /^ai_[0-9a-f]{16}$/.test(x.id)));
  assert.deepEqual([a[0].data.roomId, a[1].data.trigger, a[1].data.roomId, a[2].data.roomId], ['kit', { kind: 'afterUse', deviceId: 'af' }, null, 'bed']);
  assert.ok(a[0].data.estimatedMinutes === 5 && !('id' in a[0].data) && a[0].data.createdBy === 'u');
  assert.equal(a[3].data.target, 'room'); assert.equal(a[3].data.rev, 1);
  const after = prev({ tasks: a.filter((x) => x.kind === 'task').map((x) => ({ id: x.id, ...x.data })), templates: [{ id: a[3].id }] });
  assert.ok(after.every((x) => x.status === 'duplicate'), 'already imported → duplicates, nothing re-created');
  const remap = prev({ mapping: { 'task:2': 'bath' } });
  assert.equal(remap[2].data.roomId, 'bath'); assert.notEqual(remap[2].id, a[2].id, 'a different target is a different task');
  assert.deepEqual(prev({ rooms: [], devices }).filter((x) => x.kind === 'task' && x.status === 'invalid').map((x) => x.reasons[0]), ['noMatchingRoom', 'noMatchingRoom']);
  assert.ok(prev({ canCreateTasks: false }).filter((x) => x.kind === 'task').every((x) => x.reasons[0] === 'noPermission'));
  assert.ok(prev({ canEditTemplates: false }).filter((x) => x.kind === 'template').every((x) => x.reasons[0] === 'noPermission'));
  assert.equal(fnv64('abc'), 'e71fa2190541574b', 'FNV-1a 64 reference value');
});

test('prompt privacy: only what was ticked; never names unless chosen', () => {
  const p = buildPrompt({ lang: 'en', roomTypes: ['kitchen'], deviceTypes: ['airfryer'] });
  assert.match(p, /areaType: kitchen/); assert.match(p, /deviceType: airfryer/); assert.ok(!/Room names/.test(p));
  assert.ok(!/@|wallet|saving|zakat|uid/i.test(p), 'nothing private');
  assert.match(buildPrompt({ lang: 'ar', roomTypes: ['kitchen'], roomNames: ['مطبخ ماما'] }), /مطبخ ماما/, 'names only when chosen');
  assert.ok(parsePlan(buildPrompt({ wantTemplates: true }).split('# Schema example\n')[1]).ok, 'the example in the prompt is itself a valid plan');
});

function fakeRepo() {
  const data = new Map(); const ws = new Set(); let w = 0; let n = 0; let failNext = null;
  const list = (p) => [...data.entries()].filter(([k]) => k.startsWith(p)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
  const watch = (fn) => { ws.add(fn); w++; queueMicrotask(fn); return () => { ws.delete(fn); w--; }; };
  return { data, get watchers() { return w; }, set failNext(v) { failNext = v; }, now: () => 'N', newId: () => `id${++n}`, newTemplateId: () => `tpl00000${++n}`,
    watchTasks: (h, on) => watch(() => on(list('cleaningTasks/'))), watchOccurrences: (h, f, on) => watch(() => on([])),
    watchTemplates: (h, on) => watch(() => on(list('cleaningCustomTemplates/'))),
    docExists: async (h, name, id) => data.has(`${name}/${id}`),
    async commit(h, ops) {
      await new Promise((r) => setTimeout(r, 1));
      if (failNext) { const e = failNext; failNext = null; throw e; }
      for (const o of ops) { const k = `${o.name}/${o.id}`;
        if (o.mode === 'set' && data.has(k)) throw Object.assign(new Error('exists'), { code: 'permission-denied' });
        if (o.mode === 'update' && o.name === 'cleaningCustomTemplates' && o.data.rev !== data.get(k).rev + 1) throw Object.assign(new Error('stale'), { code: 'permission-denied' }); }
      for (const o of ops) { const k = `${o.name}/${o.id}`; data.set(k, o.mode === 'set' ? { ...o.data } : { ...data.get(k), ...o.data }); }
      for (const fn of ws) fn();
    } };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('store: templates listener on demand; create / edit (rev) / stale conflict / archive; confirmed bulk create classification', async () => {
  const repo = fakeRepo(); const s = createCleaningStore({ homeId: 'H', uid: 'u', repo, today: () => '2026-10-18' }); s.ensure({ canView: true }); s.subscribe(() => {}); await tick();
  assert.equal(s.listenerCount(), 2); s.ensureTemplates(); await tick(); assert.equal(s.listenerCount(), 3);
  const id = await s.createTemplate(D); await tick();
  await s.changeTemplate(id, { title: 'New title' }); await tick();
  assert.equal(repo.data.get(`cleaningCustomTemplates/${id}`).rev, 2);
  repo.data.set(`cleaningCustomTemplates/${id}`, { ...repo.data.get(`cleaningCustomTemplates/${id}`), rev: 9 });   // someone else edited; our snapshot is stale
  await assert.rejects(s.changeTemplate(id, { title: 'Mine' }), (e) => e.detail === 'cleaning.tpl.err.conflict');
  await repo.commit('H', []); await tick();
  await s.changeTemplate(id, 'archive'); await tick();
  assert.equal(repo.data.get(`cleaningCustomTemplates/${id}`).active, false);
  // Bulk create: saved / already existed (another member) / genuine denial / network stop.
  repo.data.set('cleaningTasks/ai_2', { title: 'x' });
  repo.failNext = null;
  const W = (k) => ({ id: k, data: { title: k } });
  const seen = [];
  let r = await s.createManyConfirmed('cleaningTasks', [W('ai_1'), W('ai_2'), W('ai_3')], { onProgress: (p) => seen.push(p.saved) });
  assert.deepEqual([r.saved, r.alreadyExisted, r.failed.length, r.remaining], [2, 1, 0, 0]);
  assert.deepEqual(seen, [0, 1, 1, 2, 2]);
  repo.failNext = Object.assign(new Error('x'), { code: 'permission-denied' });
  r = await s.createManyConfirmed('cleaningTasks', [W('ai_4'), W('ai_5')]);
  assert.deepEqual([r.saved, r.failed.map((f) => [f.id, f.reason])], [1, [['ai_4', 'denied']]]);
  repo.failNext = Object.assign(new Error('x'), { code: 'unavailable' });
  r = await s.createManyConfirmed('cleaningTasks', [W('ai_6'), W('ai_7'), W('ai_8')]);
  assert.deepEqual([r.saved, r.failed.map((f) => f.reason), r.remaining], [0, ['network'], 2], 'network: stop, report the rest as not attempted');
  s.dispose(); assert.equal(repo.watchers, 0);
});
