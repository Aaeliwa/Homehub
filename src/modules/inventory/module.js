import { defineModule, standardPermissions } from '../registry.js';

/** Inventory / Pantry — PLANNED. Registration metadata only. */
export default defineModule({
  id: 'inventory',
  nameKey: 'module.inventory.name',
  descriptionKey: 'module.inventory.description',
  icon: '📦',
  accent: 'teal',
  route: '/m/inventory',
  order: 70,
  enabled: false,
  viewPermission: 'inventory.view',
  permissions: standardPermissions('inventory'),
});
