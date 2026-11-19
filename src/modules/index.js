/**
 * The list of HomeHub modules. Adding a tool = create src/modules/<id>/module.js and add
 * one import line here. Everything else (navigation, dashboard tiles, role seeding)
 * derives from the registry.
 */
import { createRegistry } from './registry.js';
import { CORE_PERMISSIONS } from '../core/permissions/core-permissions.js';
import { buildSystemRoles } from '../core/permissions/roles.js';

import expenses from './expenses/module.js';
import savings from './savings/module.js';
import chef from './chef/module.js';
import mealPlanner from './mealPlanner/module.js';
import cleaning from './cleaning/module.js';
import maintenance from './maintenance/module.js';
import contacts from './contacts/module.js';
import inventory from './inventory/module.js';
import shopping from './shopping/module.js';
import rooms from './rooms/module.js';
import devices from './devices/module.js';
import calendar from './calendar/module.js';   // V6.2

export const registry = createRegistry([
  expenses, calendar, savings, chef, mealPlanner, cleaning, maintenance, contacts, inventory, shopping, rooms, devices,
]);

/** Core + module permissions: the full catalog used to build default roles. */
export function permissionCatalog() {
  return [...CORE_PERMISSIONS, ...registry.permissions()];
}

export function defaultRoles() {
  return buildSystemRoles(permissionCatalog());
}
