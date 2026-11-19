import { defineModule } from '../registry.js';

/**
 * Life Savings / مدخراتي (+ Zakat al-Mal) — Phase 5.
 * Permissions follow the registry rule "a module's permissions use its own id", so Zakat
 * permissions are savings.* too. Children reach the module only for their own assets.
 */
export default defineModule({
  id: 'savings',
  nameKey: 'module.savings.name',
  descriptionKey: 'module.savings.description',
  icon: '🪙',
  accent: 'amber',
  route: '/m/savings',
  order: 15,
  enabled: true,
  viewPermission: 'savings.view',
  alsoVisibleWith: ['savings.personal'],
  permissions: [
    // Read HOUSEHOLD savings assets & events (never other adults' private assets).
    { id: 'savings.view', defaultRoles: ['admin', 'member', 'viewer'] },
    // Show household totals (presentation; data privacy is record-level).
    { id: 'savings.viewTotals', defaultRoles: ['admin', 'member'] },
    // Own personal assets (and shared ones you are a reader of); a child's own savings.
    { id: 'savings.personal', defaultRoles: ['admin', 'member', 'child'] },
    { id: 'savings.manageHousehold', defaultRoles: ['admin'] },
    { id: 'savings.transfer', defaultRoles: ['admin', 'member'] },
    // Record manual gold/silver/FX prices (household reference data, audited).
    { id: 'savings.prices', defaultRoles: ['admin', 'member'] },
    // Use Zakat for yourself (and, as a guardian, for your child).
    { id: 'savings.zakat', defaultRoles: ['admin', 'member'] },
  ],
  page: () => import('./page.js'),
  // V6.1: the Life Savings DASHBOARD TILE is removed (product decision); navigation, data, permissions unchanged.
});
