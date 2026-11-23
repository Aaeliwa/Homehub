import { defineModule, standardPermissions } from '../registry.js';

/**
 * Pantry (V6.5 Phase 01): the shared, bilingual product catalog. Stock tracking, consumption and Shopping
 * links arrive in later phases. Permissions are the inventory.* standard set seeded since role template v1
 * (view: admin / member / viewer; create / edit: admin / member; delete = archive: admin) — no template change,
 * so customised role grants are untouched. Children have no Pantry access by default.
 */
export default defineModule({
  id: 'inventory',
  nameKey: 'module.inventory.name',
  descriptionKey: 'module.inventory.description',
  icon: '📦',
  accent: 'teal',
  route: '/m/inventory',
  order: 70,
  enabled: true,
  viewPermission: 'inventory.view',
  permissions: standardPermissions('inventory'),
  page: () => import('./page.js'),
});
