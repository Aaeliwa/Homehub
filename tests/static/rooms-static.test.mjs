/**
 * Phase 2 static guards for the Rooms module: Home-scoped paths, layering, rules
 * structure, rules ↔ model agreement, i18n coverage, RTL-safe CSS, phase discipline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOM_TYPE_IDS, ROOM_ICON_IDS, ROOM_LIMITS, FLOOR_SUGGESTION_KEYS } from '../../src/modules/rooms/room-model.js';
import en from '../../src/core/i18n/locales/en.js';
import ar from '../../src/core/i18n/locales/ar.js';

const read = (p) => readFileSync(p, 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ROOMS_DIR = 'src/modules/rooms';
const roomFiles = readdirSync(ROOMS_DIR).map((f) => join(ROOMS_DIR, f));
const rules = read('firestore.rules');
const rulesCode = rules.replace(/\/\/.*$/gm, '');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : []));
}

test('rooms live only at homes/{homeId}/rooms — no root or per-user rooms collection', () => {
  // Phase 3: src/core/permissions holds permission NAMESPACE lists (e.g. ['rooms']), not paths.
  for (const f of walk('src').filter((x) => !x.startsWith(join('src', 'core', 'permissions')))) {
    const c = code(f);
    assert.ok(!/collection\([^)]*['"]rooms['"]/.test(c), `${f}: raw rooms collection`);
    assert.ok(!/\[\s*['"]rooms['"]/.test(c), `${f}: root rooms path`);
    assert.ok(!/users[^\n]*rooms/.test(c), `${f}: rooms under users`);
  }
  const repo = code(join(ROOMS_DIR, 'room-repository.js'));
  assert.match(repo, /paths\.homeCollection\(homeId, ROOMS_COLLECTION\)/);
  assert.match(repo, /paths\.homeDoc\(homeId, ROOMS_COLLECTION, roomId\)/);
});

test('layering: only the repository touches the data layer; UI goes through the store/service', () => {
  const dataUsers = roomFiles.filter((f) => /core\/data\/firestore\.js|core\/firebase\/sdk\.js/.test(code(f)));
  assert.deepEqual(dataUsers, [join(ROOMS_DIR, 'room-repository.js')]);
  for (const f of ['page.js', 'widget.js', 'room-form.js', 'room-detail.js']) {
    assert.ok(!/room-repository\.js/.test(code(join(ROOMS_DIR, f))), `${f} must not import the repository`);
  }
  assert.ok(!/room-repository|rooms-store/.test(code('src/ui/pages/dashboard-page.js')), 'dashboard does not know room internals');
});

test('rules: rooms are nested under homes/{h} and every operation is permission-gated', () => {
  const homesAt = rulesCode.indexOf('match /homes/{h}');
  const roomsAt = rulesCode.indexOf('match /rooms/{roomId}');
  assert.ok(homesAt > 0 && roomsAt > homesAt, 'rooms match inside homes');
  assert.equal(rulesCode.match(/match \/rooms\//g).length, 1, 'no other rooms match (e.g. root)');
  const block = rulesCode.slice(roomsAt, rulesCode.indexOf('allow delete: if false;', roomsAt) + 25);
  assert.match(block, /allow get, list: if can\(h, 'rooms', 'view'\)/);
  assert.match(block, /allow create: if can\(h, 'rooms', 'create'\)/);
  for (const a of ['edit', 'delete', 'restore']) assert.match(block, new RegExp(`can\\(h, 'rooms', '${a}'\\)`));
  assert.match(block, /incoming\(\)\.createdBy == request\.auth\.uid/);
  assert.match(block, /allow delete: if false;/, 'no hard delete');
  // createdBy / createdAt / schemaVersion never appear in any update allow-list.
  for (const m of block.matchAll(/changed\(\)\.hasOnly\(\[([^\]]+)\]\)/g)) {
    assert.ok(!/createdBy|createdAt|schemaVersion/.test(m[1]), `update path may change protected field: ${m[1]}`);
  }
});

test('rules ↔ model agree on room types and limits', () => {
  const types = [...rules.match(/function roomTypes\(\) \{\s*return \[([^\]]+)\]/)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(types, ROOM_TYPE_IDS);
  assert.match(rules, /isName\(d\.name, 60\)/);
  assert.match(rules, /isOptionalText\(d\.floor, 40\)/);
  assert.match(rules, /isOptionalText\(d\.notes, 500\)/);
  assert.match(rules, /d\.sortOrder <= 1000000000/);
  assert.deepEqual([ROOM_LIMITS.name, ROOM_LIMITS.floor, ROOM_LIMITS.notes, ROOM_LIMITS.maxSortOrder], [60, 40, 500, 1000000000]);
});

test('every room type, icon and floor suggestion is translated in Arabic and English', () => {
  const keys = [
    ...ROOM_TYPE_IDS.map((x) => `rooms.type.${x}`),
    ...ROOM_ICON_IDS.map((x) => `rooms.icon.${x}`),
    ...FLOOR_SUGGESTION_KEYS.map((x) => `rooms.floor.${x}`),
  ];
  for (const k of keys) { assert.ok(en[k], `en ${k}`); assert.ok(ar[k], `ar ${k}`); }
  for (const base of ['rooms.count', 'rooms.widget.activeLabel', 'rooms.widget.archived']) {
    for (const form of ['zero', 'one', 'two', 'few', 'many', 'other']) assert.ok(ar[`${base}.${form}`] && en[`${base}.${form}`], `${base}.${form}`);
  }
});

test('templated t() keys used by Rooms exist (rooms.type.*, rooms.future.*)', () => {
  for (const k of ['devices', 'cleaning', 'maintenance']) assert.ok(en[`rooms.future.${k}`] && ar[`rooms.future.${k}`]);
});

test('RTL-safe CSS: new styles use logical properties only', () => {
  for (const f of ['assets/css/modules/rooms.css', 'assets/css/components.css']) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/(margin|padding|border)-(left|right)\b/.test(css), `${f}: physical margin/padding/border`);
    assert.ok(!/(^|[;{\s])(left|right)\s*:/.test(css), `${f}: physical left/right offset`);
  }
});

test('phase discipline: rooms never embed devices, cleaning or maintenance data', () => {
  // Phase 3: Devices now exists as its OWN collection (see devices-static). Rooms must still
  // never embed device data, and later modules must not have started.
  // Phase 4: Expenses has its own rules now; Cleaning/Maintenance must still not exist.
  // Phase 5.3: Cleaning has its own collections (cleaningTasks/Occurrences/Log); Maintenance must not exist.
  // Phase 5.5: Maintenance has its own collections — rooms still never embed maintenance data,
  // and the Rooms rule block is untouched by it.
  assert.ok(!/maintenance\w*\s*:|maintenancePlanIds/.test(roomFiles.map(code).join('\n')), 'rooms never embed maintenance data');
  const roomBlock = rulesCode.slice(rulesCode.indexOf('match /rooms/{roomId}'), rulesCode.indexOf('match /', rulesCode.indexOf('match /rooms/{roomId}') + 10));
  assert.ok(roomBlock.length > 50 && !/maintenance/i.test(roomBlock.replace(/\/\/.*$/gm, '')), 'rooms rules carry no maintenance logic');
  assert.ok(!/cleaning\w*\s*:|cleaningTaskIds/.test(roomFiles.map(code).join('\n')), 'rooms never embed cleaning data');
  for (const f of roomFiles) assert.ok(!/devices\s*:|deviceIds|homes\/[^'"]*\/devices/.test(code(f)), `${f}: device data in room`);
});

test('no hard-coded home ids, uids or root paths in the rooms module', () => {
  for (const f of roomFiles) {
    const c = code(f);
    assert.ok(!/['"]homes\/[A-Za-z0-9]{10,}/.test(c), f);
    assert.ok(!/P6B9sjmz5eQcmuE1j9nd4q5Ret82/.test(c), f);
  }
});
