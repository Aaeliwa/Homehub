/**
 * Lightweight module registry.
 *
 * A HomeHub tool is described by one plain object (its "module definition"). The shell,
 * navigation, dashboard and role seeding all derive from the registry — nothing else in
 * the app hard-codes a list of tools.
 *
 * Module definition contract:
 * {
 *   id:              'expenses'                 // camelCase; also the permission namespace
 *   nameKey:         'module.expenses.name'     // i18n key
 *   descriptionKey:  'module.expenses.description'
 *   icon:            '💰'
 *   accent:          'emerald'                  // tile colour token (see assets/css)
 *   route:           '/m/expenses'
 *   order:           10                         // position in nav and dashboard
 *   enabled:         false                      // true once the module is implemented
 *   viewPermission:  'expenses.view'            // required to see it at all…
 *   alsoVisibleWith: ['expenses.personal']      // …or any of these (Phase 4A, optional)
 *   permissions:     [{ id, defaultRoles }]     // permissions this module owns
 *   page:            null | () => import('./page.js')          // { mount(el, ctx) -> unmount }
 *   dashboardWidget: null | { order, size: 'sm'|'md'|'lg', load: () => import('./widget.js') }
 *   homeCount:       null | { order, load: () => import('./widget.js') }   // V6.4: a live count in the Your Home card ({ mountCount(dd, ctx) -> unmount })
 * }
 */
import { isPermissionId, namespaceOf } from '../core/permissions/permission-format.js';

const ID = /^[a-z][a-zA-Z0-9]*$/;
const ACCENTS = ['blue', 'emerald', 'orange', 'amber', 'sky', 'violet', 'rose', 'teal', 'green', 'indigo', 'cyan'];

export function defineModule(def) {
  const fail = (msg) => { throw new TypeError(`Module "${def && def.id}": ${msg}`); };
  if (!def || !ID.test(def.id)) fail('id must be camelCase');
  if (!def.nameKey || !def.descriptionKey) fail('nameKey and descriptionKey are required');
  if (!def.icon) fail('icon is required');
  if (!ACCENTS.includes(def.accent)) fail(`accent must be one of ${ACCENTS.join(', ')}`);
  if (def.route !== `/m/${def.id}`) fail(`route must be /m/${def.id}`);
  if (typeof def.enabled !== 'boolean') fail('enabled must be boolean');
  if (!Array.isArray(def.permissions) || !def.permissions.length) fail('permissions must be a non-empty array');
  for (const p of def.permissions) {
    if (!isPermissionId(p.id) || namespaceOf(p.id) !== def.id) fail(`permission ${p.id} must be "${def.id}.<action>"`);
    if (!Array.isArray(p.defaultRoles)) fail(`permission ${p.id} needs defaultRoles`);
  }
  if (!def.permissions.some((p) => p.id === def.viewPermission)) fail('viewPermission must be one of its permissions');
  if (def.alsoVisibleWith && (!Array.isArray(def.alsoVisibleWith) || !def.alsoVisibleWith.every((x) => def.permissions.some((p) => p.id === x)))) {
    fail('alsoVisibleWith must list this module\'s own permissions');
  }
  if (def.enabled && typeof def.page !== 'function') fail('an enabled module must provide page()');
  if (def.dashboardWidget && typeof def.dashboardWidget.load !== 'function') fail('dashboardWidget.load must be a function');
  if (def.homeCount && typeof def.homeCount.load !== 'function') fail('homeCount.load must be a function');
  return Object.freeze({
    order: 100,
    page: null,
    dashboardWidget: null,
    homeCount: null,
    ...def,
    permissions: Object.freeze(def.permissions.map((p) => Object.freeze({ ...p, defaultRoles: Object.freeze([...p.defaultRoles]) }))),
  });
}

/**
 * Standard permission set for a typical module.
 *   view   -> admin, member, viewer (+ child when childCan includes 'view')
 *   create -> admin, member
 *   edit   -> admin, member
 *   delete -> admin
 *   extra actions (e.g. 'complete') -> admin, member (+ child when listed in childCan)
 */
export function standardPermissions(ns, { extra = [], childCan = [] } = {}) {
  const withChild = (action, roles) => (childCan.includes(action) ? [...roles, 'child'] : roles);
  return [
    { id: `${ns}.view`, defaultRoles: withChild('view', ['admin', 'member', 'viewer']) },
    { id: `${ns}.create`, defaultRoles: withChild('create', ['admin', 'member']) },
    { id: `${ns}.edit`, defaultRoles: withChild('edit', ['admin', 'member']) },
    { id: `${ns}.delete`, defaultRoles: ['admin'] },
    ...extra.map((action) => ({ id: `${ns}.${action}`, defaultRoles: withChild(action, ['admin', 'member']) })),
  ];
}

/** A module is visible with its viewPermission, or any of its optional alsoVisibleWith grants. */
export function canSeeModule(m, perms) {
  return perms.can(m.viewPermission) || (Array.isArray(m.alsoVisibleWith) && perms.canAny(m.alsoVisibleWith));
}

export function createRegistry(definitions) {
  const ids = new Set();
  for (const d of definitions) {
    if (ids.has(d.id)) throw new TypeError(`Duplicate module id: ${d.id}`);
    ids.add(d.id);
  }
  const modules = Object.freeze([...definitions].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)));
  const visible = (perms) => modules.filter((m) => canSeeModule(m, perms));
  return Object.freeze({
    all: () => modules,
    get: (id) => modules.find((m) => m.id === id) || null,
    /** Modules the user may see (enabled or "coming soon"). */
    visibleFor: visible,
    /** Implemented modules the user may open — used for navigation. */
    navigableFor: (perms) => visible(perms).filter((m) => m.enabled),
    /** Dashboard widgets the user may see, in display order. */
    widgetsFor: (perms) => visible(perms)
      .filter((m) => m.enabled && m.dashboardWidget)
      .sort((a, b) => (a.dashboardWidget.order ?? a.order) - (b.dashboardWidget.order ?? b.order)),
    /** V6.4: live counts shown inside the Your Home card (Rooms, Devices), in order. */
    homeCountsFor: (perms) => visible(perms)
      .filter((m) => m.enabled && m.homeCount)
      .sort((a, b) => (a.homeCount.order ?? a.order) - (b.homeCount.order ?? b.order)),
    /** Every permission declared by modules. */
    permissions: () => modules.flatMap((m) => m.permissions),
  });
}
