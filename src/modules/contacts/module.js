import { defineModule, standardPermissions } from '../registry.js';

/** Contacts — PLANNED. Registration metadata only. */
export default defineModule({
  id: 'contacts',
  nameKey: 'module.contacts.name',
  descriptionKey: 'module.contacts.description',
  icon: '📇',
  accent: 'rose',
  route: '/m/contacts',
  order: 60,
  enabled: false,
  viewPermission: 'contacts.view',
  permissions: standardPermissions('contacts', { childCan: ['view'] }),
});
