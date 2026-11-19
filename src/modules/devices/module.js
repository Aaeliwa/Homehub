import { defineModule } from '../registry.js';

/**
 * Devices & household assets — IMPLEMENTED in Phase 3.
 * Same permission philosophy as Rooms: shared household structure, changed by admins;
 * everyone in the home can see it. devices.delete = archive (never a hard delete).
 */
export default defineModule({
  id: 'devices',
  nameKey: 'module.devices.name',
  descriptionKey: 'module.devices.description',
  icon: '🔌',
  accent: 'cyan',
  route: '/m/devices',
  order: 100,
  enabled: true,
  viewPermission: 'devices.view',
  permissions: [
    { id: 'devices.view', defaultRoles: ['admin', 'member', 'viewer', 'child'] },
    { id: 'devices.create', defaultRoles: ['admin'] },
    { id: 'devices.edit', defaultRoles: ['admin'] },
    { id: 'devices.delete', defaultRoles: ['admin'] },
    { id: 'devices.restore', defaultRoles: ['admin'] },
  ],
  page: () => import('./page.js'),
  // V6.4: no standalone dashboard tile — the ACTIVE device count lives in the Your Home card.
  homeCount: { order: 20, load: () => import('./widget.js') },
});
