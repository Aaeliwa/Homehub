import { defineModule, standardPermissions } from '../registry.js';

/**
 * Home Routine & Cleaning — IMPLEMENTED in Phase 5.3.
 * Permissions are the ones seeded since Phase 1 (no template change):
 *   cleaning.view     admin, member, viewer, child   see the household's tasks
 *   cleaning.create   admin, member                  create tasks
 *   cleaning.edit     admin, member                  edit tasks; release/reopen others' occurrences
 *   cleaning.delete   admin                          archive / restore tasks
 *   cleaning.complete admin, member, child           claim / complete (children: only when listed)
 */
export default defineModule({
  id: 'cleaning',
  nameKey: 'module.cleaning.name',
  descriptionKey: 'module.cleaning.description',
  icon: '🧹',
  accent: 'sky',
  route: '/m/cleaning',
  order: 40,
  enabled: true,
  viewPermission: 'cleaning.view',
  permissions: standardPermissions('cleaning', { extra: ['complete'], childCan: ['view', 'complete'] }),
  page: () => import('./page.js'),
  dashboardWidget: { order: 15, size: 'sm', load: () => import('./widget.js') },
});
