/** Shared Contacts (V6.4 B) Firestore access — the only file with contact paths. */
import { paths } from '../../core/firebase/paths.js';
import { watchCollection, watchWhereLimited, readWhereLimited, atomicWrite, newDocId, serverTime, readDoc } from '../../core/data/firestore.js';
import { CONTACT_LIMITS } from './contact-model.js';

export const KCOL = Object.freeze({ contacts: 'contacts', categories: 'contactCategories' });
export const contactsRepository = Object.freeze({
  now: serverTime,
  newId: (h, name) => newDocId(paths.homeCollection(h, name)),
  /**
   * Live, BOUNDED: non-deleted contacts only. Reads ONE document beyond the capacity (limit + 1) so the store
   * can tell "exactly at capacity" from "truncated" (rev 2) — never more than 1,001 documents per attach.
   */
  watchContacts: (h, on, err) => watchWhereLimited(paths.homeCollection(h, KCOL.contacts), ['deleted', '==', false], CONTACT_LIMITS.maxContacts + 1, on, err),
  /** Small shared label set (the app caps it at CONTACT_LIMITS.maxCategories). */
  watchCategories: (h, on, err) => watchCollection(paths.homeCollection(h, KCOL.categories), on, err),
  /** One-shot, on demand (Deleted view, contacts.delete holders only — rules): deletedList + 1 (truncation flag). */
  readDeleted: (h) => readWhereLimited(paths.homeCollection(h, KCOL.contacts), ['deleted', '==', true], CONTACT_LIMITS.deletedList + 1),
  read: (h, id) => readDoc(paths.homeDoc(h, KCOL.contacts, id)),
  exists: async (h, name, id) => (await readDoc(paths.homeDoc(h, name, id))) !== null,
  commit: (h, ops) => atomicWrite((w) => { for (const o of ops) { if (o.mode === 'delete') w.delete(paths.homeDoc(h, o.name, o.id)); else w[o.mode](paths.homeDoc(h, o.name, o.id), o.data); } }),
});
