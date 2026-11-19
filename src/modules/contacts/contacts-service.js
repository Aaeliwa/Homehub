/** getContactsStore(ctx): the scope-bound contacts store for the CURRENT Home (disposed on Home switch / sign-out). */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { createContactsStore } from './contacts-store.js';
import { contactsRepository } from './contacts-repository.js';

export function getContactsStore(ctx) {
  const scope = ctx && ctx.scope; const state = ctx && ctx.getState ? ctx.getState() : null;
  if (!scope || scope.isDisposed() || !state || !state.home || state.home.id !== scope.homeId) throw new AppError(ErrorCode.CONTEXT_UNAVAILABLE);
  return scope.resource('contacts', (s) => createContactsStore({ homeId: s.homeId, uid: s.uid, repo: contactsRepository, canView: state.permissions.can('contacts.view') }));
}
