import { defineModule } from '../registry.js';

/**
 * Shared Contacts (V6.4 Batch B): one household directory — no private contacts, no device address-book
 * access, no sync. Permission matrix (role template v9, additive; see SECURITY.md):
 *   view             admin, member, viewer, child   — read the shared directory (all members)
 *   create / edit    admin, member                  — add contacts, edit them, toggle the SHARED favourite
 *   delete           admin                          — soft delete + restore
 *   import           admin, member                  — create from a .vcf (merging into existing ones also needs edit)
 *   export           admin, member                  — download .vcf (bulk personal data: not for viewer / child)
 *   manageCategories admin                          — create / rename / remove categories, add suggestions
 * The owner has '*'. Firestore rules enforce every one of these.
 */
export default defineModule({
  id: 'contacts',
  nameKey: 'module.contacts.name',
  descriptionKey: 'module.contacts.description',
  icon: '📇',
  accent: 'rose',
  route: '/m/contacts',
  order: 60,
  enabled: true,
  viewPermission: 'contacts.view',
  permissions: [
    { id: 'contacts.view', defaultRoles: ['admin', 'member', 'viewer', 'child'] },
    { id: 'contacts.create', defaultRoles: ['admin', 'member'] },
    { id: 'contacts.edit', defaultRoles: ['admin', 'member'] },
    { id: 'contacts.delete', defaultRoles: ['admin'] },
    { id: 'contacts.import', defaultRoles: ['admin', 'member'] },
    { id: 'contacts.export', defaultRoles: ['admin', 'member'] },
    { id: 'contacts.manageCategories', defaultRoles: ['admin'] },
  ],
  page: () => import('./page.js'),
});
