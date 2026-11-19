/**
 * First-time setup. Shown when a signed-in user has no users/{uid} profile (new database)
 * or chose to create a new Home after a context error. This is not an error state.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLanguage } from '../../core/i18n/i18n.js';
import { AppState } from '../../core/state/app-machine.js';
import { DEFAULTS, LIMITS } from '../../config/app-config.js';
import { validateDisplayName, validateHomeName } from '../../core/utils/validate.js';
import { getThemePreference } from '../../core/settings/preferences.js';
import { brandMark, banner, errorText, textField, quickToggles, setBusy } from '../components/common.js';
import { inviteCard } from '../components/invite-card.js';

export function setupScreen({ state, session, prefs, route, join, navigate }) {
  const { identity, profile } = state;
  const suggestedName = (profile && profile.displayName) || identity.displayName || '';

  const name = textField({ id: 'setup-name', label: t('setup.displayName'), value: suggestedName, autocomplete: 'name', maxlength: LIMITS.displayName, required: true });
  const home = textField({ id: 'setup-home', label: t('setup.homeName'), hint: t('setup.homeNameHint'), maxlength: LIMITS.homeName, required: true });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, t('setup.submit'));
  const messages = h('div', { class: 'gate__messages' });
  let restore = null;

  const defaults = h('dl', { class: 'defaults' },
    h('div', null, h('dt', null, t('setup.account')), h('dd', { dir: 'ltr' }, identity.email)),
    h('div', null, h('dt', null, t('settings.homeLanguage')), h('dd', null, t(`lang.${DEFAULTS.language}`))),
    h('div', null, h('dt', null, t('settings.currency')), h('dd', null, DEFAULTS.currency)),
    h('div', null, h('dt', null, t('settings.timezone')), h('dd', { dir: 'ltr' }, DEFAULTS.timezone)));

  // ---- Phase 4A: joining by invitation ------------------------------------------------
  const invitePanel = h('section', { class: 'invite-panel', 'aria-live': 'polite' });
  const inviting = route && route.name === 'join' && join;
  if (inviting) {
    invitePanel.replaceChildren(h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') }));
    join.load(route.params.code, { uid: identity.uid, nowMillis: Date.now() }).then((r) => {
      const card = inviteCard(r);
      if (r.state !== 'ok') { invitePanel.replaceChildren(card); return; }
      const joinMsg = h('div', { class: 'gate__messages' });
      const joinBtn = h('button', { type: 'button', class: 'btn btn--primary btn--block', id: 'join-accept', onClick: async () => {
        const nameErr = validateDisplayName(name.input.value);
        name.setError(nameErr ? t(nameErr) : '');
        if (nameErr) return name.input.focus();
        const restoreJ = setBusy(joinBtn, t('family.join.joining'));
        try {
          await session.acceptInvite({ code: r.code, displayName: name.input.value, language: getLanguage(), theme: getThemePreference() });
          // Joined: leave the (now used) invite link so the home opens on its dashboard.
          if (navigate) navigate('/dashboard');
        } catch (err) {
          restoreJ();
          joinMsg.replaceChildren(banner('error', err && err.detail && String(err.detail).startsWith('family.') ? t(err.detail) : errorText(err)));
        }
      } }, t('family.join.accept', { home: r.invite.homeName }));
      invitePanel.replaceChildren(card, joinMsg, joinBtn, h('p', { class: 'invite-panel__or' }, t('family.join.orCreate')));
    });
  } else if (navigate) {
    const codeInput = h('input', { id: 'setup-code', class: 'input', dir: 'ltr', autocomplete: 'off', placeholder: 'XXXX-XXXX-…', 'aria-label': t('family.join.codeLabel') });
    invitePanel.replaceChildren(h('details', { class: 'form-section' },
      h('summary', { class: 'form-section__summary' }, t('family.join.haveCode')),
      h('div', { class: 'form-row' }, codeInput,
        h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => { const c = codeInput.value.trim(); if (c) navigate(`/join/${c.replace(/[^A-Za-z0-9-]/g, '')}`); } }, t('family.join.continue')))));
  }

  const form = h('form', {
    class: 'gate__form', novalidate: true,
    onSubmit: (e) => {
      e.preventDefault();
      const nameErr = validateDisplayName(name.input.value);
      const homeErr = validateHomeName(home.input.value);
      name.setError(nameErr ? t(nameErr) : '');
      home.setError(homeErr ? t(homeErr) : '');
      if (nameErr) return name.input.focus();
      if (homeErr) return home.input.focus();
      session.completeSetup({
        displayName: name.input.value,
        homeName: home.input.value,
        language: getLanguage(),
        theme: getThemePreference(),
      });
    },
  }, name.root, invitePanel, home.root,
  h('div', { class: 'gate__note' }, h('p', null, t('setup.defaultsNote')), defaults),
  messages, submit,
  h('div', { class: 'gate__row' }, h('button', { type: 'button', class: 'link-btn', onClick: () => session.signOut() }, t('common.signOut'))));

  const el = h('main', { class: 'gate', id: 'main' },
    h('div', { class: 'gate__card' },
      h('div', { class: 'gate__top' }, quickToggles(prefs)),
      h('div', { class: 'gate__head' },
        brandMark('lg'),
        h('h1', { class: 'gate__title' }, t('setup.title')),
        h('p', { class: 'gate__sub' }, t('setup.subtitle'))),
      form));

  return {
    el,
    focus: () => (name.input.value ? home.input : name.input).focus(),
    update(s) {
      const busy = s.status === AppState.SETTING_UP;
      name.input.disabled = busy;
      home.input.disabled = busy;
      if (busy && !restore) restore = setBusy(submit, t('setup.submitting'));
      if (!busy && restore) { restore(); restore = null; }
      messages.replaceChildren(s.formError ? banner('error', errorText(s.formError)) : '');
    },
  };
}
