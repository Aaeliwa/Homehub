import { defineModule } from '../registry.js';

/**
 * Rooms — IMPLEMENTED in Phase 2.
 *
 * Permissions deliberately differ from standardPermissions(): rooms are shared household
 * structure (devices, cleaning and maintenance will hang off them), so only admins (and
 * the owner via "*") change them. Everyone else in the home can see them.
 */
export default defineModule({
  id: 'rooms',
  nameKey: 'module.rooms.name',
  descriptionKey: 'module.rooms.description',
  icon: '🚪',
  accent: 'indigo',
  route: '/m/rooms',
  order: 90,
  enabled: true,
  viewPermission: 'rooms.view',
  permissions: [
    { id: 'rooms.view', defaultRoles: ['admin', 'member', 'viewer', 'child'] },
    { id: 'rooms.create', defaultRoles: ['admin'] },
    { id: 'rooms.edit', defaultRoles: ['admin'] },
    { id: 'rooms.delete', defaultRoles: ['admin'] },
    { id: 'rooms.restore', defaultRoles: ['admin'] },
  ],
  page: () => import('./page.js'),
  // V6.4: no standalone dashboard tile — the ACTIVE room count lives in the Your Home card.
  homeCount: { order: 10, load: () => import('./widget.js') },
});
