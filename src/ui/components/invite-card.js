/**
 * Invitation card (Phase 4A) — shared by first-time setup and the in-app Join page.
 * Shows the home, the role, the expiry and a clear state; never accepts silently.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { roleLabel, banner } from './common.js';

export function formatExpiry(ms) {
  try { return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)); } catch { return ''; }
}

/** state: ok | invalid | expired | used | cancelled | alreadyMember */
export function inviteCard({ invite, state }) {
  if (state !== 'ok' && state !== 'alreadyMember') {
    return h('div', { class: 'invite-card invite-card--bad', id: 'invite-state', dataset: { state } },
      banner('error', t(`family.invite.state.${state}`)));
  }
  return h('div', { class: 'invite-card', id: 'invite-state', dataset: { state } },
    h('p', { class: 'invite-card__eyebrow' }, t('family.join.invitedTo')),
    h('p', { class: 'invite-card__home', dir: 'auto' }, invite.homeName),
    h('dl', { class: 'facts' },
      h('div', null, h('dt', null, t('family.field.role')), h('dd', null, roleLabel({ id: invite.roleId }))),
      h('div', null, h('dt', null, t('family.invite.expires')), h('dd', null, formatExpiry(invite.expiresAtMillis)))),
    state === 'alreadyMember' ? banner('error', t('family.invite.state.alreadyMember')) : null);
}
