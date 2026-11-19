import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDeviceInput, isCalendarDate, parsePrice, iconFor, defaultIconFor, checkRoomAssignment,
  sortDevices, filterDevices, matchesQuery, summarizeDevices, devicesByRoom, devicesByCategory, devicesByStatus,
  buildDeviceCreate, buildDeviceEdit, buildDeviceArchive, buildDeviceRestore, subtypesFor,
  DEVICE_CATEGORY_IDS, DEVICE_CATEGORIES, DEVICE_ICONS, DEVICE_STATUSES, EDITABLE_FIELDS,
} from '../../src/modules/devices/device-model.js';
import { ErrorCode } from '../../src/core/errors/app-error.js';

const ok = (extra = {}) => validateDeviceInput({ name: 'Bedroom AC', category: 'air_conditioning', subtype: 'split_ac', ...extra });
const dev = (id, extra = {}) => ({ id, name: id, category: 'other', subtype: null, roomId: null, status: 'operational', active: true, ...extra });

test('valid device normalises and defaults (status operational, icon from subtype/category)', () => {
  const { value, errors } = ok({ name: '  Bedroom   AC ', brand: ' LG ', serialNumber: ' ', notes: ' x ' });
  assert.deepEqual(errors, {});
  assert.equal(value.name, 'Bedroom AC');
  assert.equal(value.brand, 'LG');
  assert.equal(value.serialNumber, null);
  assert.equal(value.status, 'operational');
  assert.equal(value.icon, 'snowflake');
  assert.equal(value.roomId, null, 'null room = Unassigned is valid');
  assert.equal(value.purchasePrice, null);
  assert.equal(value.currency, null, 'no price → no currency stored');
});

test('required name, invalid category / subtype / status / room id', () => {
  assert.ok(ok({ name: '   ' }).errors.name);
  assert.ok(ok({ name: 'x'.repeat(81) }).errors.name);
  assert.ok(validateDeviceInput({ name: 'A', category: 'Air Conditioning' }).errors.category, 'labels are not ids');
  assert.ok(ok({ subtype: 'refrigerator' }).errors.subtype, 'subtype from another category');
  assert.ok(ok({ subtype: 'nope' }).errors.subtype);
  assert.deepEqual(ok({ subtype: 'other' }).errors, {});
  assert.deepEqual(ok({ subtype: null }).errors, {});
  assert.ok(validateDeviceInput({ name: 'A', category: 'other', subtype: 'other' }).errors.subtype, "category 'other' has no subtypes");
  assert.ok(ok({ status: 'broken' }).errors.status);
  assert.ok(ok({ roomId: 'a/b' }).errors.roomId);
  assert.ok(ok({ brand: 'b'.repeat(61) }).errors.brand);
  assert.ok(ok({ notes: 'n'.repeat(1001) }).errors.notes);
});

test('price: null vs zero, decimals, negatives, currency required with price', () => {
  assert.deepEqual(parsePrice(''), { value: null });
  assert.deepEqual(parsePrice('0'), { value: 0 });
  assert.deepEqual(parsePrice('1,250.50'), { value: 1250.5 });
  for (const bad of ['-1', 'abc', '1.234', 'Infinity', 'NaN', '1e5']) assert.ok(parsePrice(bad).error, bad);
  assert.equal(ok({ purchasePrice: '0', currency: 'EGP' }).value.purchasePrice, 0);
  assert.ok(ok({ purchasePrice: '100', currency: 'egp' }).errors.currency);
  assert.equal(ok({ purchasePrice: '', currency: 'EGP' }).value.currency, null);
});

test('dates: strict calendar YYYY-MM-DD, no time zone shifting', () => {
  assert.ok(isCalendarDate('2024-02-29'));
  for (const bad of ['2023-02-29', '2024-13-01', '2024-1-01', '24-01-01', '1899-12-31', '2101-01-01', '2024-01-01T00:00', 20240101]) {
    assert.ok(!isCalendarDate(bad), String(bad));
  }
  assert.ok(ok({ purchaseDate: '2024-02-30' }).errors.purchaseDate);
  assert.equal(ok({ warrantyExpiry: '' }).value.warrantyExpiry, null);
  assert.equal(ok({ installationDate: '2025-06-15' }).value.installationDate, '2025-06-15');
});

test('icons: subtype → category → gear; unknown ids fall back', () => {
  assert.equal(defaultIconFor('kitchen_appliance', 'coffee_machine'), 'coffee');
  assert.equal(defaultIconFor('kitchen_appliance', 'oven'), 'cooking');
  assert.equal(defaultIconFor('nope', null), 'gear');
  assert.equal(iconFor({ icon: 'future_icon', category: 'networking' }), DEVICE_ICONS.router);
  assert.equal(iconFor(null), DEVICE_ICONS.gear);
  for (const c of DEVICE_CATEGORY_IDS) assert.ok(DEVICE_ICONS[DEVICE_CATEGORIES[c].icon], c);
});

test('taxonomy: 19 categories, unique subtypes, 4 statuses', () => {
  assert.equal(DEVICE_CATEGORY_IDS.length, 19);
  const subs = DEVICE_CATEGORY_IDS.flatMap(subtypesFor).filter((s) => s !== 'other');
  assert.equal(new Set(subs).size, subs.length);
  assert.deepEqual(DEVICE_STATUSES, ['operational', 'needs_attention', 'out_of_service', 'stored']);
});

test('room assignment policy: new → active only; unchanged archived reference stays valid', () => {
  const rooms = { A: { id: 'A', active: true }, B: { id: 'B', active: true }, X: { id: 'X', active: false } };
  const getRoom = (id) => rooms[id] || null;
  assert.equal(checkRoomAssignment({ roomId: null, getRoom }), null);
  assert.equal(checkRoomAssignment({ roomId: 'A', getRoom }), null);
  assert.equal(checkRoomAssignment({ roomId: 'X', getRoom }), 'devices.validation.roomArchived', 'new device → archived room');
  assert.equal(checkRoomAssignment({ roomId: 'ZZ', getRoom }), 'devices.validation.roomNotFound');
  assert.equal(checkRoomAssignment({ roomId: 'X', previousRoomId: 'X', getRoom }), null, 'keep existing archived ref');
  assert.equal(checkRoomAssignment({ roomId: 'X', previousRoomId: 'A', getRoom }), 'devices.validation.roomArchived', 'move into archived room');
  assert.equal(checkRoomAssignment({ roomId: null, previousRoomId: 'X', getRoom }), null, 'archived → unassigned ok');
});

test('search: name, brand, model, serial (case-insensitive); not notes', () => {
  const d = dev('1', { name: 'Kitchen fridge', brand: 'Sharp', model: 'SJ-58C', serialNumber: 'SN123', notes: 'secret' });
  for (const q of ['fridge', 'SHARP', 'sj-58', 'sn12', '']) assert.ok(matchesQuery(d, q), q);
  assert.ok(!matchesQuery(d, 'secret'));
});

test('filters: view, room (all/unassigned/id), category, status, query combine', () => {
  const list = [dev('a', { roomId: 'R1', category: 'networking', status: 'operational' }), dev('b', { roomId: null, category: 'networking', status: 'needs_attention' }),
    dev('c', { roomId: 'R1', category: 'lighting' }), dev('d', { active: false, roomId: 'R1' })];
  const ids = (f) => filterDevices(list, f).map((x) => x.id);
  assert.deepEqual(ids({}), ['a', 'b', 'c']);
  assert.deepEqual(ids({ view: 'archived' }), ['d']);
  assert.deepEqual(ids({ room: 'unassigned' }), ['b']);
  assert.deepEqual(ids({ room: 'R1' }), ['a', 'c']);
  assert.deepEqual(ids({ category: 'networking', status: 'needs_attention' }), ['b']);
  assert.deepEqual(ids({ room: 'R1', query: 'c' }), ['c']);
});

test('deterministic sorting by name, room, category, status', () => {
  const list = [dev('x2', { name: 'b', roomId: null, status: 'stored', category: 'lighting' }), dev('x1', { name: 'b', roomId: 'R2', status: 'needs_attention', category: 'audio_video' }),
    dev('x3', { name: 'a', roomId: 'R1', status: 'operational', category: 'lighting' })];
  const ids = (m, o) => sortDevices(list, m, o).map((x) => x.id);
  assert.deepEqual(ids('name'), ['x3', 'x1', 'x2'], 'ties by id');
  assert.deepEqual(ids('room', { roomOrder: (id) => ({ R1: 0, R2: 1 })[id] }), ['x3', 'x1', 'x2'], 'unassigned last');
  assert.deepEqual(ids('status'), ['x1', 'x3', 'x2'], 'needs attention first');
  assert.deepEqual(ids('category'), ['x1', 'x3', 'x2']);
  assert.deepEqual(ids('bogus'), ids('name'));
});

test('grouping + dashboard summary', () => {
  const list = [dev('a', { roomId: 'R1', status: 'needs_attention' }), dev('b', { roomId: null, status: 'out_of_service' }), dev('c', { active: false })];
  assert.deepEqual({ ...summarizeDevices(list) }, { activeCount: 2, needsAttentionCount: 1, outOfServiceCount: 1, archivedCount: 1 });
  assert.deepEqual([...devicesByRoom(list).keys()], ['R1', null]);
  assert.equal(devicesByCategory(list).get('other').length, 3);
  assert.equal(devicesByStatus(list).get('needs_attention').length, 1);
});

test('write shapes match the rules: create keys, edit patch, archive, restore', () => {
  const c = buildDeviceCreate({ input: { name: 'AC', category: 'air_conditioning', purchasePrice: '0', currency: 'EGP' }, uid: 'U', now: 'N' });
  assert.deepEqual(Object.keys(c).sort(), ['active', 'archivedAt', 'archivedBy', 'brand', 'category', 'createdAt', 'createdBy', 'currency', 'icon',
    'installationDate', 'model', 'name', 'notes', 'purchaseDate', 'purchasePrice', 'roomId', 'schemaVersion', 'serialNumber', 'status',
    'subtype', 'updatedAt', 'updatedBy', 'warrantyExpiry']);
  assert.equal(c.purchasePrice, 0);
  assert.ok(!('maintenanceHistory' in c) && !('nextCleaningDate' in c) && !('sortOrder' in c));
  assert.throws(() => buildDeviceCreate({ input: { name: '' , category: 'other' }, uid: 'U', now: 'N' }), (e) => e.code === ErrorCode.VALIDATION);
  const original = { ...c };
  assert.equal(buildDeviceEdit({ original, input: { ...original, purchasePrice: '0' }, uid: 'U', now: 'N' }), null, 'no-op');
  assert.deepEqual(buildDeviceEdit({ original, input: { ...original, purchasePrice: '0', roomId: 'R9', brand: 'LG' }, uid: 'U2', now: 'N' }),
    { roomId: 'R9', brand: 'LG', updatedBy: 'U2', updatedAt: 'N' });
  for (const k of Object.keys(buildDeviceEdit({ original, input: { ...original, purchasePrice: '0', name: 'Z' }, uid: 'U', now: 'N' }))) {
    assert.ok([...EDITABLE_FIELDS, 'updatedBy', 'updatedAt'].includes(k), k);
  }
  assert.deepEqual(Object.keys(buildDeviceArchive({ uid: 'U', now: 'N' })).sort(), ['active', 'archivedAt', 'archivedBy', 'updatedAt', 'updatedBy']);
  assert.deepEqual(buildDeviceRestore({ uid: 'U', now: 'N' }), { active: true, archivedAt: null, archivedBy: null, updatedBy: 'U', updatedAt: 'N' });
});
