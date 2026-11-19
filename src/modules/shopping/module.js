import { defineModule, standardPermissions } from '../registry.js';

/** Shopping — PLANNED. Registration metadata only. */
export default defineModule({
  id: 'shopping',
  nameKey: 'module.shopping.name',
  descriptionKey: 'module.shopping.description',
  icon: '🛒',
  accent: 'green',
  route: '/m/shopping',
  order: 80,
  enabled: false,
  viewPermission: 'shopping.view',
  permissions: standardPermissions('shopping', { extra: ['complete'], childCan: ['view', 'complete'] }),
});
