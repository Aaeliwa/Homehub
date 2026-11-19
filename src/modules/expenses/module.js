import { defineModule } from '../registry.js';

/**
 * Finance (module id 'expenses') — IMPLEMENTED in Phase 4.
 * Expenses + wallets (household / personal, with privacy) + transfers + rolling 10-day
 * budgets + recurring commitments. All finance permissions live in the 'expenses' namespace
 * because the registry requires a module's permissions to use its own id.
 */
export default defineModule({
  id: 'expenses',
  nameKey: 'module.expenses.name',
  descriptionKey: 'module.expenses.description',
  icon: '💰',
  accent: 'emerald',
  route: '/m/expenses',
  order: 10,
  enabled: true,
  viewPermission: 'expenses.view',
  // Phase 4A: a child (expenses.personal only) must reach their OWN allowance wallet. Data
  // access is still enforced per record by the rules (child sees only wallets it belongs to).
  alsoVisibleWith: ['expenses.personal'],
  permissions: [
    // Read household (audience 'household') finance records, wallets, cycles, commitments.
    { id: 'expenses.view', defaultRoles: ['admin', 'member', 'viewer'] },
    // See aggregate totals / balances / budgets for the household (presentation gate).
    { id: 'expenses.viewFinancialTotals', defaultRoles: ['admin', 'member'] },
    { id: 'expenses.create', defaultRoles: ['admin', 'member'] },
    { id: 'expenses.edit', defaultRoles: ['admin', 'member'] },
    // Void / un-void (corrections never hard-delete).
    { id: 'expenses.delete', defaultRoles: ['admin'] },
    // Use personal wallets you belong to (own wallet, shared wallet, a child's allowance).
    { id: 'expenses.personal', defaultRoles: ['admin', 'member', 'child'] },
    { id: 'expenses.manageWallets', defaultRoles: ['admin'] },
    { id: 'expenses.transfer', defaultRoles: ['admin', 'member'] },
    { id: 'expenses.manageBudgets', defaultRoles: ['admin'] },   // V6 batch 3: owners (*) and admins only
    { id: 'expenses.manageCommitments', defaultRoles: ['admin'] },
    // One-time historical CSV import — owner only (via "*").
    { id: 'expenses.import', defaultRoles: [] },
  ],
  page: () => import('./page.js'),
  dashboardWidget: { order: 5, size: 'md', load: () => import('./widget.js') },
});
