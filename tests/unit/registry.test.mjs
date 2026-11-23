import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineModule, createRegistry, standardPermissions } from '../../src/modules/registry.js';
import { registry } from '../../src/modules/index.js';
import { createPermissionSet } from '../../src/core/permissions/resolver.js';
import en from '../../src/core/i18n/locales/en.js';

const base = {
  id: 'demo', nameKey: 'module.demo.name', descriptionKey: 'module.demo.description', icon: '⭐',
  accent: 'blue', route: '/m/demo', enabled: false, viewPermission: 'demo.view', permissions: standardPermissions('demo'),
};

test('defineModule validates the contract', () => {
  assert.ok(defineModule(base));
  assert.throws(() => defineModule({ ...base, id: 'Bad-Id' }));
  assert.throws(() => defineModule({ ...base, route: '/demo' }));
  assert.throws(() => defineModule({ ...base, accent: 'pink' }));
  assert.throws(() => defineModule({ ...base, viewPermission: 'demo.nope' }));
  assert.throws(() => defineModule({ ...base, permissions: [{ id: 'other.view', defaultRoles: [] }], viewPermission: 'other.view' }));
  assert.throws(() => defineModule({ ...base, enabled: true }), 'enabled module needs page()');
  assert.ok(defineModule({ ...base, enabled: true, page: () => Promise.resolve({}) }));
});

test('registry rejects duplicate ids and orders by `order`', () => {
  const a = defineModule({ ...base, order: 2 });
  assert.throws(() => createRegistry([a, a]));
  const b = defineModule({ ...base, id: 'alpha', route: '/m/alpha', viewPermission: 'alpha.view', permissions: standardPermissions('alpha'), order: 1 });
  assert.deepEqual(createRegistry([a, b]).all().map((m) => m.id), ['alpha', 'demo']);
});

test('V6.2: twelve modules registered; the implemented ones enabled (+ calendar)', () => {
  const ids = registry.all().map((m) => m.id);
  assert.deepEqual(ids, ['expenses', 'calendar', 'savings', 'chef', 'mealPlanner', 'cleaning', 'maintenance', 'contacts', 'inventory', 'shopping', 'rooms', 'devices']);   // V6.2: + calendar
  const ENABLED = ['expenses', 'savings', 'cleaning', 'maintenance', 'rooms', 'devices', 'chef', 'calendar', 'contacts', 'inventory'];   // V6.5 P01: + inventory (Pantry catalog)   // V6.4 B: + contacts   // V6.2 + calendar  // 5.3 + cleaning; 5.5 + maintenance; V6.1 + chef (Recipes)
  for (const id of ENABLED) {
    const m = registry.get(id);
    assert.equal(m.enabled, true, id);
    assert.equal(typeof m.page, 'function');
    if (id === 'savings' || id === 'contacts' || id === 'inventory') assert.equal(m.dashboardWidget, null, 'no dashboard tile (V6.1 Life Savings; V6.4 B Contacts: Tools + navigation only)');
    else if (id === 'rooms' || id === 'devices') { assert.equal(m.dashboardWidget, null, 'V6.4: no standalone tile'); assert.equal(typeof m.homeCount.load, 'function', 'V6.4: active count in the Your Home card'); }
    else assert.equal(typeof m.dashboardWidget.load, 'function');
  }
  const others = registry.all().filter((m) => !ENABLED.includes(m.id));
  assert.ok(others.every((m) => m.enabled === false && m.page === null && m.dashboardWidget === null));
  for (const id of ['shopping', 'mealPlanner']) assert.equal(registry.get(id).enabled, false, `${id} not started`);   // V6.5 P01: Pantry started; Shopping NOT   // V6.1: Meal Planner is future work
  const owner = createPermissionSet(['*']);
  assert.equal(registry.visibleFor(owner).length, 12);   // V6.2: + calendar
  assert.deepEqual(registry.navigableFor(owner).map((m) => m.id), ['expenses', 'calendar', 'savings', 'chef', 'cleaning', 'maintenance', 'contacts', 'inventory', 'rooms', 'devices']);   // V6.5 P01: + inventory   // V6.4 B: + contacts (dock + rail + Tools)   // separate destinations (V6.2: + calendar)
  assert.deepEqual(registry.widgetsFor(owner).map((m) => m.id), ['calendar', 'expenses', 'chef', 'cleaning', 'maintenance']);   // widget order 3,5,8,15,17 (V6.2: calendar month first) (V6.1: timers panel; no Life Savings tile) (V6.4: Rooms / Devices tiles → Your Home counts)
  assert.deepEqual(registry.homeCountsFor(owner).map((m) => m.id), ['rooms', 'devices']);
  assert.ok(registry.navigableFor(owner).some((m) => m.id === 'savings'), 'Life Savings still navigable');
});

test('visibility follows view permission', () => {
  const child = createPermissionSet(['cleaning.view', 'shopping.view']);
  assert.deepEqual(registry.visibleFor(child).map((m) => m.id), ['cleaning', 'shopping']);
});

test('every module has translated name and description', () => {
  for (const m of registry.all()) {
    assert.ok(en[m.nameKey], `${m.nameKey} missing`);
    assert.ok(en[m.descriptionKey], `${m.descriptionKey} missing`);
  }
});

test('Phase 4A: alsoVisibleWith — a child (expenses.personal only) sees Finance; others unaffected', async () => {
  const { canSeeModule } = await import('../../src/modules/registry.js');
  const fin = registry.get('expenses');
  assert.deepEqual(fin.alsoVisibleWith, ['expenses.personal']);
  assert.equal(canSeeModule(fin, createPermissionSet(['expenses.personal'])), true, 'child reaches own allowance');
  assert.equal(canSeeModule(fin, createPermissionSet(['rooms.view'])), false);
  assert.equal(canSeeModule(registry.get('rooms'), createPermissionSet(['expenses.personal'])), false);
  assert.throws(() => defineModule({ ...base, alsoVisibleWith: ['other.view'] }), 'only own permissions');
});
