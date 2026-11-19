import { defineModule, standardPermissions } from '../registry.js';

/** Meal Planner — PLANNED. Registration metadata only. */
export default defineModule({
  id: 'mealPlanner',
  nameKey: 'module.mealPlanner.name',
  descriptionKey: 'module.mealPlanner.description',
  icon: '🗓️',
  accent: 'amber',
  route: '/m/mealPlanner',
  order: 30,
  enabled: false,
  viewPermission: 'mealPlanner.view',
  permissions: standardPermissions('mealPlanner', { childCan: ['view'] }),
});
