import { defineModule, standardPermissions } from '../registry.js';
/** Calendar (V6.2): household events, work shifts, vacations, tasks and reminders; Google CSV import. */
export default defineModule({
  id: 'calendar',
  nameKey: 'module.calendar.name',
  descriptionKey: 'module.calendar.description',
  icon: '📅',
  accent: 'blue',
  route: '/m/calendar',
  order: 12,   // after Finance in navigation; its widget is first on the dashboard
  enabled: true,
  viewPermission: 'calendar.view',
  permissions: standardPermissions('calendar', { childCan: ['view'] }),
  page: () => import('./page.js'),
  dashboardWidget: { order: 3, size: 'lg', load: () => import('./widget.js') },
});
