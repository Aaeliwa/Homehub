/**
 * #/join/<code> while already signed in to a home (Phase 4A).
 * Shows the invitation; joining does NOT silently replace the current default home —
 * the member chooses whether to switch now.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { banner, errorText, setBusy } from '../components/common.js';
import { inviteCard } from '../components/invite-card.js';
import { toast } from '../components/toast.js';

export function mountJoin(outlet, ctx, code) {
  const { identity, profile } = ctx.getState();
  const body = h('div', { class: 'card join-card', 'aria-live': 'polite' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') }));
  outlet.replaceChildren(h('div', { class: 'page' },
    h('header', { class: 'page-head' }, h('h1', { class: 'page-head__title' }, t('family.join.title'))), body));
  let alive = true;
  ctx.services.loadInvite(code, { uid: identity.uid, nowMillis: Date.now() }).then((r) => {
    if (!alive) return;
    const card = inviteCard(r);
    if (r.state !== 'ok') {
      body.replaceChildren(card, h('a', { class: 'btn btn--secondary', href: '#/dashboard' }, t('common.backToDashboard')));
      return;
    }
    const makeDefault = h('input', { type: 'checkbox', id: 'join-default' });
    const msg = h('div', { class: 'gate__messages' });
    const btn = h('button', { type: 'button', class: 'btn btn--primary', id: 'join-accept', onClick: async () => {
      const restore = setBusy(btn, t('family.join.joining'));
      try {
        const res = await ctx.session.acceptInvite({ code: r.code, displayName: profile.displayName, makeDefault: makeDefault.checked });
        if (res.switched) { ctx.navigate('/dashboard'); return; }
        if (!res.switched) {
          toast(t('family.join.joined', { home: res.homeName }), { tone: 'success' });
          body.replaceChildren(banner('success', t('family.join.joinedStay', { home: res.homeName })),
            h('div', { class: 'fin-actions' },
              h('button', { type: 'button', class: 'btn btn--primary', id: 'join-switch', onClick: () => { ctx.navigate('/dashboard'); ctx.session.switchHome(res.homeId); } }, t('family.join.switchNow', { home: res.homeName })),
              h('a', { class: 'btn btn--secondary', href: '#/dashboard' }, t('family.join.stay'))));
        }
      } catch (err) {
        restore();
        msg.replaceChildren(banner('error', err && err.detail && String(err.detail).startsWith('family.') ? t(err.detail) : errorText(err)));
      }
    } }, t('family.join.accept', { home: r.invite.homeName }));
    body.replaceChildren(card,
      h('label', { class: 'fin-check' }, makeDefault, h('span', null, t('family.join.makeDefault'))),
      h('p', { class: 'field__hint' }, t('family.join.privacyNote')), msg,
      h('div', { class: 'fin-actions' }, btn, h('a', { class: 'btn btn--ghost', href: '#/dashboard' }, t('family.join.decline'))));
  });
  return { destroy() { alive = false; } };
}
