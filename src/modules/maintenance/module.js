import { defineModule, standardPermissions } from '../registry.js';

/**
 * Device Maintenance — IMPLEMENTED in Phase 5.5. Permissions are the ones seeded since Phase 1
 * (role template v1 — no template change, no role-data change):
 *   maintenance.view     admin, member, viewer   see plans, faults and service history
 *   maintenance.create   admin, member           create plans, report faults
 *   maintenance.edit     admin, member           edit plans / faults; close, cancel, reopen faults; corrections
 *   maintenance.complete admin, member           complete plans; start / resolve faults
 *   maintenance.delete   admin                   archive / reactivate plans
 */
export default defineModule({
  id: 'maintenance',
  nameKey: 'module.maintenance.name',
  descriptionKey: 'module.maintenance.description',
  icon: '🔧',
  accent: 'violet',
  route: '/m/maintenance',
  order: 50,
  enabled: true,
  viewPermission: 'maintenance.view',
  permissions: standardPermissions('maintenance', { extra: ['complete'] }),
  page: () => import('./page.js'),
  dashboardWidget: { order: 17, size: 'sm', load: () => import('./widget.js') },
});
