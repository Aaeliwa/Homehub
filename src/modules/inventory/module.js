import { defineModule, standardPermissions } from '../registry.js';

/**
 * Pantry (V6.5): the shared, bilingual product catalog (Phase 01) + manual stock and its immutable history (Phase 02).
 * Consumption, Chef and Shopping links arrive in later phases. Permissions: the inventory.* standard set seeded since
 * role template v1 (view: admin / member / viewer; create / edit: admin / member; delete = archive: admin) plus
 * inventory.adjust (stock CORRECTIONS: admin / member; owner via "*"), added by role template v10 — an additive,
 * owner-triggered upgrade that adds only that one grant. Add / remove / presence use inventory.edit; every stock write
 * also needs inventory.view. Children have no Pantry access by default.
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
  permissions: standardPermissions('inventory', { extra: ['adjust'] }),
  page: () => import('./page.js'),
});
