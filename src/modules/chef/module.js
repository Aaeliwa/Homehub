import { defineModule, standardPermissions } from '../registry.js';

/**
 * Recipes (V6.1): household cookbook + per-user cooking timers. Permissions are the chef.* set seeded
 * since role template v1 (no template change); they never imply Finance or admin rights.
 */
export default defineModule({
  id: 'chef',
  nameKey: 'module.chef.name',
  descriptionKey: 'module.chef.description',
  icon: '👨‍🍳',
  accent: 'orange',
  route: '/m/chef',
  order: 20,
  enabled: true,
  viewPermission: 'chef.view',
  permissions: standardPermissions('chef', { childCan: ['view'] }),
  page: () => import('./page.js'),
  dashboardWidget: { order: 8, size: 'md', load: () => import('./widget.js') },   // the shared timer panel
});
