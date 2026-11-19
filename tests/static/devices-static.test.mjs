/** Phase 3 static guards: paths, layering, rules ↔ model agreement, i18n, RTL, discipline. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEVICE_CATEGORIES, DEVICE_ICON_IDS, DEVICE_STATUSES, DEVICE_CATEGORY_IDS } from '../../src/modules/devices/device-model.js';
import en from '../../src/core/i18n/locales/en.js';
import ar from '../../src/core/i18n/locales/ar.js';

const read = (p) => readFileSync(p, 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const DIR = 'src/modules/devices';
const files = readdirSync(DIR).map((f) => join(DIR, f));
const rules = read('firestore.rules');
const rulesCode = rules.replace(/\/\/.*$/gm, '');
const block = (() => { const at = rulesCode.indexOf('match /devices/{deviceId}'); return rulesCode.slice(at, rulesCode.indexOf('allow delete: if false;', at) + 25); })();

test('devices live only at homes/{homeId}/devices (not under rooms, not root)', () => {
  const repo = code(join(DIR, 'device-repository.js'));
  assert.match(repo, /paths\.homeCollection\(homeId, DEVICES_COLLECTION\)/);
  assert.match(repo, /paths\.homeDoc\(homeId, DEVICES_COLLECTION, id\)/);
  for (const f of files) assert.ok(!/rooms\/[^'"`]*\/devices|\[\s*['"]devices['"]|collection\([^)]*['"]devices['"]/.test(code(f)), f);
  const homesAt = rulesCode.indexOf('match /homes/{h}');
  assert.ok(rulesCode.indexOf('match /devices/{deviceId}') > homesAt);
  assert.equal(rulesCode.match(/match \/devices\//g).length, 1);
});

test('layering: only the repository touches the data layer; Devices reuses the rooms service', () => {
  assert.deepEqual(files.filter((f) => /core\/data\/firestore\.js|firebase\/sdk\.js/.test(code(f))), [join(DIR, 'device-repository.js')]);
  for (const f of ['page.js', 'widget.js', 'device-form.js', 'device-detail.js']) assert.ok(!/device-repository|room-repository/.test(code(join(DIR, f))), f);
  assert.match(code(join(DIR, 'devices-service.js')), /getRoomsStore\(ctx\)/);
  assert.ok(!files.some((f) => /watchRooms|room-repository/.test(code(f))), 'no second rooms listener inside Devices');
  assert.ok(!/devices-store|device-repository/.test(code('src/ui/pages/dashboard-page.js')));
  assert.ok(!/device-repository|devices-store/.test(code('src/modules/rooms/room-detail.js')), 'Rooms uses the Devices service interface only');
});

test('rules: every operation permission-gated; audit fields protected; no delete', () => {
  assert.match(block, /allow get, list: if can\(h, 'devices', 'view'\)/);
  assert.match(block, /allow create: if can\(h, 'devices', 'create'\)/);
  for (const a of ['edit', 'delete', 'restore']) assert.match(block, new RegExp(`can\\(h, 'devices', '${a}'\\)`));
  assert.match(block, /incoming\(\)\.createdBy == request\.auth\.uid/);
  assert.match(block, /allow delete: if false;/);
  for (const m of block.matchAll(/changed\(\)\.hasOnly\(\[([^\]]+)\]\)/g)) assert.ok(!/createdBy|createdAt|schemaVersion/.test(m[1]), m[1]);
});

test('rules: room assignment — active room on create / on change; unchanged ref tolerated', () => {
  assert.match(block, /incoming\(\)\.roomId == null \|\| isActiveRoom\(h, incoming\(\)\.roomId\)/);
  assert.match(block, /!\('roomId' in changed\(\)\) \|\| incoming\(\)\.roomId == null \|\| isActiveRoom\(h, incoming\(\)\.roomId\)/);
  assert.match(rules, /homes\/\$\(h\)\/rooms\/\$\(roomId\)\)\.data\.active == true/, 'same-home room path');
});

test('rules ↔ model: identical category → subtype map and statuses', () => {
  const body = rules.slice(rules.indexOf('function deviceSubtypes()'), rules.indexOf('function deviceStatuses()'));
  const parsed = {};
  for (const m of body.matchAll(/'([a-z_]+)': \[([^\]]*)\]/g)) parsed[m[1]] = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(parsed, Object.fromEntries(Object.entries(DEVICE_CATEGORIES).map(([k, v]) => [k, [...v.subtypes]])));
  assert.match(rules, new RegExp(`deviceStatuses\\(\\) \\{ return \\[${DEVICE_STATUSES.map((s) => `'${s}'`).join(', ')}\\]`));
});

test('every category, subtype, status and icon is translated (ar + en)', () => {
  const keys = [...DEVICE_CATEGORY_IDS.map((c) => `devices.category.${c}`),
    ...DEVICE_CATEGORY_IDS.flatMap((c) => DEVICE_CATEGORIES[c].subtypes).map((s) => `devices.subtype.${s}`),
    ...DEVICE_STATUSES.map((s) => `devices.status.${s}`), ...DEVICE_ICON_IDS.map((i) => `devices.icon.${i}`)];
  for (const k of keys) { assert.ok(en[k], `en ${k}`); assert.ok(ar[k], `ar ${k}`); }
  for (const base of ['devices.count', 'devices.widget.activeLabel', 'devices.widget.attention', 'devices.widget.archived', 'rooms.devices.count']) {
    for (const f of ['zero', 'one', 'two', 'few', 'many', 'other']) assert.ok(en[`${base}.${f}`] && ar[`${base}.${f}`], `${base}.${f}`);
  }
});

test('RTL-safe CSS in devices.css', () => {
  const css = read('assets/css/modules/devices.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/(margin|padding|border)-(left|right)\b/.test(css));
  assert.ok(!/(^|[;{\s])(left|right)\s*:/.test(css));
});

test('phase discipline: devices hold no Cleaning/Maintenance/Expense fields; no Storage; no base64', () => {
  // Phase 4: Expenses now exists as its OWN module with its own rules. Devices must still
  // never embed cleaning/maintenance/expense data, and Cleaning/Maintenance must not exist yet.
  // Phase 5.3: Cleaning has its own collections; devices still never embed cleaning data (below).
  // Phase 5.5: Maintenance has rules for EXACTLY its four approved collections — nothing else.
  assert.deepEqual([...new Set([...rulesCode.matchAll(/match \/(maintenance\w*)\//g)].map((m) => m[1]))].sort(),
    ['maintenanceFaultEvents', 'maintenanceFaults', 'maintenancePlans', 'maintenanceRecords']);
  // …and the Devices rule block itself carries no maintenance / cleaning fields.
  const devBlock = rulesCode.slice(rulesCode.indexOf('match /devices/{deviceId}'), rulesCode.indexOf('match /', rulesCode.indexOf('match /devices/{deviceId}') + 10));
  assert.ok(!/maintenance|cleaning/i.test(devBlock), 'device rules unchanged by maintenance');
  for (const f of files) {
    const c = code(f);
    assert.ok(!/maintenanceHistory|nextMaintenance|nextCleaning|lastCleaned|cleaningFrequency|expenseId/.test(c), f);
    assert.ok(!/firebase-storage|getStorage|data:image/.test(c), f);
  }
  // Phase 5.5: Maintenance is implemented in its OWN collections; it never writes device documents.
  const repo = readFileSync('src/modules/maintenance/maintenance-repository.js', 'utf8');
  assert.ok(!/['"]devices['"]/.test(repo), 'maintenance repository has no devices path');
});
