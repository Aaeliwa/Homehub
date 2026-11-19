import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_CATEGORIES } from '../../src/modules/devices/device-model.js';
import { validateTaskInput, buildTaskCreate, TASK_EDITABLE } from '../../src/modules/cleaning/cleaning-model.js';
import { linkedDeviceId, effectiveRoomId, sourceActive } from '../../src/modules/cleaning/cleaning-integration.js';
import { suggestionsFor, CATEGORY_SUGGESTIONS, SUBTYPE_SUGGESTIONS, CAVEATS } from '../../src/modules/cleaning/device-cleaning-catalog.js';
import { validateTemplate, buildApplyPlan } from '../../src/modules/cleaning/cleaning-custom.js';
import { parsePlan, buildImportPreview, normalizeItem } from '../../src/modules/cleaning/cleaning-ai-import.js';
import { setCleaningFocus, takeCleaningFocus } from '../../src/modules/cleaning/cleaning-focus.js';

const base = { title: 'Wipe', assignMode: 'shared', recurrence: { kind: 'days', interval: 7 }, startDate: '2026-10-18' };
const combos = () => Object.entries(DEVICE_CATEGORIES).flatMap(([cat, v]) => [...v.subtypes, null].map((sub) => ({ category: cat, subtype: sub })));

test('every Add Device category / subtype (incl. other and null): a manual task can be linked; suggestions exist and are valid', () => {
  const all = combos();
  assert.equal(all.length, 85 + 19, '85 subtypes + a null subtype in each of the 19 categories');
  for (const [i, c] of all.entries()) {
    const deviceId = `dev${i}`;
    const { value, errors } = validateTaskInput({ ...base, deviceId });
    assert.deepEqual(errors, {}, `${c.category}/${c.subtype}`);
    assert.equal(buildTaskCreate({ input: { ...base, deviceId }, uid: 'u', memberUids: [], now: 'N' }).deviceId, deviceId);
    const sugg = suggestionsFor(c);
    assert.ok(sugg.length >= 1, `suggestions for ${c.category}/${c.subtype}`);
    for (const s of sugg) {
      assert.deepEqual(validateTaskInput({ ...base, title: s.titleAr, recurrence: s.recurrence, deviceId }).errors, {}, s.key);
      assert.deepEqual(validateTemplate({ pack: 'x', title: s.titleAr, titleEn: s.titleEn, minutes: s.minutes, target: 'device', recurrence: s.recurrence }).errors, {}, `template ${s.key}`);
      assert.ok(s.titleEn.length <= 80 && s.titleAr.length <= 80);
      assert.ok(!s.caveat || CAVEATS.includes(s.caveat));
    }
  }
  assert.deepEqual(Object.keys(CATEGORY_SUGGESTIONS).sort(), Object.keys(DEVICE_CATEGORIES).sort(), 'one entry per real category');
  for (const k of Object.keys(SUBTYPE_SUGGESTIONS)) assert.ok(Object.values(DEVICE_CATEGORIES).some((v) => v.subtypes.includes(k)), k);
});

test('device link rules: not with a trigger, not on generated tasks, id format; null clears; unlinked tasks keep their exact old shape', () => {
  assert.equal(validateTaskInput({ ...base, recurrence: { kind: 'onUse' }, trigger: { kind: 'afterUse', deviceId: 'd' }, deviceId: 'd' }).errors.deviceId, 'cleaning.validation.deviceLink');
  assert.equal(validateTaskInput({ ...base, deviceId: 'd', source: { kind: 'room', id: 'r' } }).errors.deviceId, 'cleaning.validation.deviceLink');
  assert.equal(validateTaskInput({ ...base, deviceId: 'bad/id' }).errors.deviceId, 'cleaning.validation.deviceLink');
  assert.equal(validateTaskInput({ ...base, deviceId: '' }).value.deviceId, null, 'empty → cleared');
  const plain = buildTaskCreate({ input: base, uid: 'u', memberUids: [], now: 'N' });
  assert.ok(!('deviceId' in plain), 'no field written when not linked');
  assert.ok(TASK_EDITABLE.includes('deviceId'));
});

test('helpers: linkedDeviceId (trigger / plain / generated); room follows the device unless explicit; archived plain links stay visible', () => {
  assert.equal(linkedDeviceId({ trigger: { kind: 'afterUse', deviceId: 'a' } }), 'a');
  assert.equal(linkedDeviceId({ deviceId: 'b' }), 'b');
  assert.equal(linkedDeviceId({ source: { kind: 'device', id: 'c' } }), 'c');
  assert.equal(linkedDeviceId({ source: { kind: 'room', id: 'r' } }), null);
  const env = { deviceById: (id) => ({ b: { id: 'b', roomId: 'kit', active: false } })[id] || null, roomById: () => null };
  assert.equal(effectiveRoomId({ deviceId: 'b', roomId: null }, env), 'kit', 'follows the device (moves with it)');
  assert.equal(effectiveRoomId({ deviceId: 'b', roomId: 'bath' }, env), 'bath', 'explicit room kept');
  assert.equal(sourceActive({ deviceId: 'b' }, env), true, 'plain link to an archived device: still visible (labelled)');
  assert.equal(sourceActive({ trigger: { kind: 'afterUse', deviceId: 'b' } }, env), false, 'trigger task: 5.4b behaviour kept');
});

test('templates and AI import: periodic device items become plain device links from the household list only', () => {
  const tp = { id: 'tplDev01', pack: 'P', title: 'Dust', minutes: 5, priority: 'normal', target: 'device', recurrence: { kind: 'after', unit: 'day', interval: 14 }, trigger: null, rev: 1, active: true };
  const [p] = buildApplyPlan({ templates: [tp], target: { kind: 'device', item: { id: 'tv1', active: true } }, tasks: [], lang: 'en', uid: 'u', now: 'N', today: '2026-10-18' });
  assert.deepEqual([p.id, p.status, p.data.deviceId, p.data.roomId, 'trigger' in p.data], ['c_tplDev01_tv1', 'create', 'tv1', null, false]);
  const [again] = buildApplyPlan({ templates: [tp], target: { kind: 'device', item: { id: 'tv1', active: true } }, tasks: [{ id: 'x', title: 'Dust', deviceId: 'tv1', active: true }], lang: 'en', uid: 'u', now: 'N', today: '2026-10-18' });
  assert.equal(again.status, 'duplicate', 'same title already on this device');
  const plan = { schemaVersion: 1, packageType: 'homehub-cleaning-plan', tasks: [{ title: 'Clean the fridge shelves', deviceType: 'fridge', frequency: { type: 'interval', unit: 'day', n: 7 }, estimatedMinutes: 10 }] };
  const items = buildImportPreview({ parsed: parsePlan(JSON.stringify(plan)).data, rooms: [], devices: [{ id: 'fr1', name: 'Fridge', subtype: 'refrigerator', roomId: 'kit', active: true }], tasks: [], templates: [],
    lang: 'en', uid: 'u', now: 'N', today: '2026-10-18', canCreateTasks: true, canEditTemplates: true });
  assert.deepEqual([items[0].status, items[0].data.deviceId, items[0].data.roomId], ['create', 'fr1', null]);
  assert.ok(normalizeItem({ ...plan.tasks[0], deviceId: 'forged' }, 'task').reasons.some((r) => r.startsWith('unknownField')), 'a deviceId inside the JSON is rejected');
  const none = buildImportPreview({ parsed: parsePlan(JSON.stringify(plan)).data, rooms: [], devices: [{ id: 'fr1', subtype: 'refrigerator', active: false }], tasks: [], templates: [],
    lang: 'en', uid: 'u', now: 'N', today: '2026-10-18', canCreateTasks: true, canEditTemplates: true });
  assert.deepEqual(none[0].reasons, ['noMatchingDevice'], 'archived devices are never offered');
});

test('navigation focus: Home-scoped and read-once', () => {
  setCleaningFocus({ homeId: 'hA', deviceId: 'd1', openNew: true, preset: { title: 'x' } });
  assert.equal(takeCleaningFocus('hB'), null, 'another Home never receives it');
  assert.equal(takeCleaningFocus('hA'), null, 'and it was consumed (no stale focus)');
  setCleaningFocus({ homeId: 'hA', deviceId: 'd1' });
  assert.deepEqual(takeCleaningFocus('hA'), { homeId: 'hA', deviceId: 'd1', roomId: null, openNew: false, preset: null });
  assert.equal(takeCleaningFocus('hA'), null, 'read once');
});
