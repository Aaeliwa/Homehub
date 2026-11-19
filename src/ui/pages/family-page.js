/**
 * Settings → Family & Members (Phase 4A). Members (directory from the shared family store),
 * pending invitations, invite creation, role changes, suspend/remove, guardians, leave.
 * Every action is also enforced by firestore.rules; the UI only offers what is allowed.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale, formatNumber } from '../../core/i18n/i18n.js';
import { icon } from '../components/icons.js';
import { banner, errorText, roleLabel, initials, setBusy } from '../components/common.js';
import { openDialog, confirmDialog } from '../components/dialog.js';
import { toast } from '../components/toast.js';
import { formatExpiry } from '../components/invite-card.js';
import { getFamilyStore } from '../../core/family/family-service.js';
import { memberActions, assignableRoles } from '../../core/family/member-model.js';
import { formatCode, MEMBER_TYPES } from '../../core/family/invite-model.js';

const DEFAULT_RANKS = { owner: 100, admin: 80, member: 50, viewer: 20, child: 10 };
const emsg = (err) => (err && err.detail && String(err.detail).startsWith('family.') ? t(err.detail) : errorText(err));

export function mountFamily(outlet, ctx) {
  const state = ctx.getState();
  const { home, identity, permissions, membership, role } = state;
  const can = permissions.can;
  let store;
  try { store = getFamilyStore(ctx); } catch (err) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err)))); return () => {}; }
  let roles = Object.entries(DEFAULT_RANKS).map(([id, rank]) => ({ id, rank }));
  if (can('roles.view')) ctx.services.listRoles(home.id).then((r) => { roles = r; render(); }).catch(() => {});
  const rankOf = (id) => (roles.find((r) => r.id === id) || {}).rank ?? DEFAULT_RANKS[id];
  const me = { uid: identity.uid, roleId: membership.roleId };
  const myRank = role.rank;
  // Dialogs attach to `root`; re-renders replace only `content`, so an open dialog (e.g. the
  // freshly created invite code) survives live store updates.
  const root = h('div', { class: 'page page--family accent-indigo' });
  const content = h('div', { class: 'family-content' });
  root.append(content);
  outlet.replaceChildren(root);
  const date = (ts) => { const ms = ts && (ts.toMillis ? ts.toMillis() : ts.seconds ? ts.seconds * 1000 : Date.parse(ts)); return ms ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(new Date(ms)) : ''; };
  const linkFor = (code) => `${location.origin}${location.pathname}#/join/${code}`;

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast(t('family.invite.copied'), { tone: 'success' }); }
    catch { toast(t('family.invite.copyFailed'), { tone: 'info' }); }
  }

  function inviteDialog() {
    const types = Object.keys(MEMBER_TYPES).filter((k) => rankOf(MEMBER_TYPES[k].roleId) < myRank || me.roleId === 'owner');
    const typeSel = h('select', { id: 'inv-type', class: 'input' }, types.map((k) => h('option', { value: k }, t(`family.type.${k}`))));
    const ttl = h('select', { id: 'inv-ttl', class: 'input' }, [1, 3, 7, 14].map((d) => h('option', { value: d, selected: d === 7 }, t('family.invite.days', { n: d }))));
    const adults = store.directory().active().filter((m) => m.relationship !== 'child');
    const guardianBox = h('fieldset', { class: 'fin-members', hidden: true }, h('legend', { class: 'field__label' }, t('family.guardians.label')),
      adults.length ? adults.map((m) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name: 'inv-guardian', value: m.uid, checked: m.uid === identity.uid }), h('span', null, m.displayName)))
        : h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name: 'inv-guardian', value: identity.uid, checked: true }), h('span', null, t('settings.you'))));
    typeSel.addEventListener('change', () => { guardianBox.hidden = typeSel.value !== 'child'; });
    const msg = h('div', { class: 'gate__messages' });
    const result = h('div');
    const submit = h('button', { type: 'button', class: 'btn btn--primary', id: 'inv-create' }, t('family.invite.create'));
    const close = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.close'));
    submit.addEventListener('click', async () => {
      const restore = setBusy(submit, t('common.saving'));
      try {
        const guardianUids = [...guardianBox.querySelectorAll('input:checked')].map((x) => x.value);
        const code = await store.createInvite({ home, type: typeSel.value, guardianUids, ttlDays: Number(ttl.value) });
        submit.remove();
        result.replaceChildren(h('div', { class: 'invite-made' },
          h('p', { class: 'field__label' }, t('family.invite.shareThis')),
          h('p', { class: 'invite-code', dir: 'ltr', id: 'inv-code' }, formatCode(code)),
          h('div', { class: 'fin-actions' },
            h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => copy(linkFor(code)) }, icon('plus', { size: 16 }), t('family.invite.copyLink')),
            h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => copy(formatCode(code)) }, t('family.invite.copyCode'))),
          h('p', { class: 'field__hint' }, t('family.invite.howTo'))));
      } catch (err) { restore(); msg.replaceChildren(banner('error', emsg(err))); }
    });
    const dlg = openDialog({ title: t('family.invite.title'), container: root, footer: [close, submit], content: h('div', { class: 'room-form' },
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'inv-type' }, t('family.field.type')), typeSel),
      guardianBox,
      h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'inv-ttl' }, t('family.invite.validFor')), ttl),
      h('p', { class: 'field__hint' }, t('family.invite.noPasswords')), msg, result) });
  }

  function roleDialog(m) {
    const opts = assignableRoles(roles.map((r) => ({ id: r.id, rank: rankOf(r.id) })), { myRoleId: me.roleId, myRank });
    const sel = h('select', { id: 'role-select', class: 'input' }, opts.map((r) => h('option', { value: r.id, selected: r.id === m.roleId }, roleLabel({ id: r.id }))));
    const save = h('button', { type: 'button', class: 'btn btn--primary', onClick: async () => {
      const restore = setBusy(save, t('common.saving'));
      try { await store.changeRole(m.uid, sel.value); toast(t('family.toast.roleChanged'), { tone: 'success' }); dlg.close(); }
      catch (err) { restore(); toast(emsg(err), { tone: 'error' }); }
    } }, t('common.save'));
    const dlg = openDialog({ title: t('family.action.changeRole', { name: m.displayName }), container: root, size: 'sm',
      content: h('div', { class: 'field' }, h('label', { class: 'field__label', for: 'role-select' }, t('family.field.role')), sel, h('p', { class: 'field__hint' }, t('family.roleHint'))),
      footer: [h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel')), save] });
  }

  function guardianDialog(m) {
    const adults = store.directory().active().filter((x) => x.relationship !== 'child' && x.uid !== m.uid);
    const box = h('fieldset', { class: 'fin-members' }, h('legend', { class: 'field__label' }, t('family.guardians.label')),
      adults.map((a) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', value: a.uid, checked: m.guardianUids.includes(a.uid) }), h('span', null, a.displayName))));
    const save = h('button', { type: 'button', class: 'btn btn--primary', onClick: async () => {
      const restore = setBusy(save, t('common.saving'));
      try { await store.setGuardians(m.uid, [...box.querySelectorAll('input:checked')].map((x) => x.value)); toast(t('family.toast.guardians'), { tone: 'success' }); dlg.close(); }
      catch (err) { restore(); toast(emsg(err), { tone: 'error' }); }
    } }, t('common.save'));
    const dlg = openDialog({ title: t('family.guardians.title', { name: m.displayName }), container: root,
      content: h('div', { class: 'room-form' }, box, h('p', { class: 'field__hint' }, t('family.guardians.scope'))),
      footer: [h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel')), save] });
  }

  async function confirmRun(title, message, label, fn, okKey) {
    if (!(await confirmDialog({ title, message, confirmLabel: label, container: root }))) return;
    try { await fn(); toast(t(okKey), { tone: 'success' }); } catch (err) { toast(emsg(err), { tone: 'error' }); }
  }

  function memberCard(m, dir) {
    const a = memberActions({ me, myRank, target: m, targetRank: rankOf(m.roleId), can });
    const guardians = m.relationship === 'child' && m.guardianUids.length ? t('family.guardians.list', { names: m.guardianUids.map((u) => dir.nameOf(u, t('family.formerMember'))).join('، ') }) : null;
    const btn = (label, fn, cls = 'btn--secondary') => h('button', { type: 'button', class: ['btn', 'btn--sm', cls], onClick: fn }, label);
    return h('li', { class: ['member-card', m.status !== 'active' && 'member-card--inactive'], dataset: { uid: m.uid } },
      h('span', { class: 'avatar avatar--lg', 'aria-hidden': 'true' }, initials(m.displayName || '?')),
      h('div', { class: 'member-card__main' },
        h('p', { class: 'member-card__name', dir: 'auto' }, m.displayName || t('family.formerMember'), m.uid === identity.uid ? h('span', { class: 'pill' }, t('settings.you')) : null),
        h('p', { class: 'member-card__meta' },
          h('span', { class: 'pill pill--role' }, roleLabel({ id: m.roleId })),
          m.relationship === 'child' && m.roleId !== 'child' ? h('span', { class: 'pill' }, t('family.type.child')) : null,
          h('span', { class: ['pill', m.status !== 'active' && 'pill--warn'] }, t(`family.status.${m.status}`))),
        m.joinedAt && date(m.joinedAt) ? h('p', { class: 'field__hint' }, t('family.joinedOn', { date: date(m.joinedAt) })) : null,
        guardians ? h('p', { class: 'field__hint' }, guardians) : null),
      h('div', { class: 'fin-actions member-card__actions' },
        a.changeRole ? btn(t('family.action.role'), () => roleDialog(m)) : null,
        a.guardians ? btn(t('family.action.guardians'), () => guardianDialog(m)) : null,
        a.suspend ? btn(t('family.action.suspend'), () => confirmRun(t('family.confirm.suspendTitle', { name: m.displayName }), t('family.confirm.suspendBody'), t('family.action.suspend'), () => store.setStatus(m.uid, 'suspended'), 'family.toast.suspended'), 'btn--ghost') : null,
        a.reactivate ? btn(t('family.action.reactivate'), () => store.setStatus(m.uid, 'active').then(() => toast(t('family.toast.reactivated'), { tone: 'success' }), (e) => toast(emsg(e), { tone: 'error' }))) : null,
        a.remove ? btn(t('family.action.remove'), () => confirmRun(t('family.confirm.removeTitle', { name: m.displayName }), t('family.confirm.removeBody'), t('family.action.remove'), () => store.setStatus(m.uid, 'removed'), 'family.toast.removed'), 'btn--danger-ghost') : null,
        a.leave ? btn(t('family.action.leave'), () => confirmRun(t('family.confirm.leaveTitle'), t('family.confirm.leaveBody'), t('family.action.leave'), () => store.leave(), 'family.toast.left'), 'btn--danger-ghost') : null));
  }

  function render() {
    const snap = store.getSnapshot();
    const dir = snap.directory;
    const sum = store.summary();
    const members = can('members.view') ? snap.members.slice().sort((x, y) => (x.status === 'active' ? 0 : 1) - (y.status === 'active' ? 0 : 1) || (rankOf(y.roleId) - rankOf(x.roleId)) || x.displayName.localeCompare(y.displayName))
      : [{ ...membership, uid: identity.uid, displayName: state.profile.displayName, relationship: membership.relationship || 'adult', guardianUids: membership.guardianUids || [], status: 'active' }];
    const invites = can('members.invite') ? store.pendingInvites() : [];
    content.replaceChildren(...[
      h('header', { class: 'page-head page-head--row' },
        h('div', null, h('h1', { class: 'page-head__title' }, t('family.title')), h('p', { class: 'page-head__sub', dir: 'auto' }, home.name)),
        can('members.invite') ? h('button', { type: 'button', class: 'btn btn--primary', id: 'family-invite', onClick: inviteDialog }, icon('plus', { size: 18 }), t('family.invite.add')) : null),
      can('members.view') ? h('div', { class: 'fin-stats', id: 'family-summary' },
        h('div', { class: 'fin-stat' }, h('span', { class: 'fin-stat__label' }, t('family.summary.active')), h('span', { class: 'fin-stat__value' }, formatNumber(sum.active))),
        h('div', { class: 'fin-stat' }, h('span', { class: 'fin-stat__label' }, t('family.summary.children')), h('span', { class: 'fin-stat__value' }, formatNumber(sum.children))),
        can('members.invite') ? h('div', { class: 'fin-stat' }, h('span', { class: 'fin-stat__label' }, t('family.summary.pending')), h('span', { class: 'fin-stat__value' }, formatNumber(sum.pendingInvites))) : null) : null,
      snap.status === 'error' ? banner('error', errorText(snap.error)) : null,
      h('section', { class: 'card fin-card', 'aria-labelledby': 'fam-members' },
        h('h2', { class: 'card__title', id: 'fam-members' }, t('family.members')),
        h('ul', { class: 'member-list', id: 'member-list' }, members.map((m) => memberCard(m, dir))),
        can('members.view') && members.filter((m) => m.status === 'active').length <= 1 ? h('p', { class: 'empty' }, t('family.empty')) : null),
      can('members.invite') ? h('section', { class: 'card fin-card', 'aria-labelledby': 'fam-invites' },
        h('h2', { class: 'card__title', id: 'fam-invites' }, t('family.invite.pending')),
        invites.length ? h('ul', { class: 'fin-list', id: 'invite-list' }, invites.map((i) => h('li', { class: 'fin-row invite-row', dataset: { code: i.id } },
          h('span', { class: 'pill pill--role' }, roleLabel({ id: i.roleId })),
          h('span', { class: 'fin-row__main' }, h('span', { class: 'invite-code invite-code--sm', dir: 'ltr' }, formatCode(i.id)), h('span', { class: 'fin-row__sub' }, t('family.invite.expiresOn', { date: formatExpiry(i.expiresAtMillis) }))),
          h('span', { class: 'fin-actions' },
            h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: () => copy(linkFor(i.id)) }, t('family.invite.copyLink')),
            h('button', { type: 'button', class: 'btn btn--danger-ghost btn--sm', onClick: () => confirmRun(t('family.confirm.cancelInviteTitle'), t('family.confirm.cancelInviteBody'), t('family.action.cancelInvite'), () => store.cancelInvite(i.id), 'family.toast.inviteCancelled') }, t('family.action.cancelInvite')))))) 
          : h('p', { class: 'empty' }, t('family.invite.none'))) : null,
      h('section', { class: 'card fin-card' }, h('h2', { class: 'card__title' }, t('family.privacy.title')), h('p', { class: 'card__hint' }, t('family.privacy.body'))),
    ].filter(Boolean)); // DOM replaceChildren would print "null" for empty parts
  }
  const off = store.subscribe(render);
  return { destroy() { off(); } };
}
