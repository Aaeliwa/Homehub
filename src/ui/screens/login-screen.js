/** Sign-in screen (email + password). Visual successor of the previous HomeHub sign-in card. */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { AppState } from '../../core/state/app-machine.js';
import { validateEmail } from '../../core/utils/validate.js';
import { brandMark, banner, errorText, textField, quickToggles, setBusy } from '../components/common.js';
import { icon } from '../components/icons.js';

export function loginScreen({ session, prefs, route }) {
  // Phase 4A: "Create account" mode. Each person signs up with their own email; no shared logins.
  let mode = 'signin';
  const inviteBanner = route && route.name === 'join' ? h('div', { class: 'banner banner--info', role: 'status' }, h('span', null, t('family.join.signInFirst'))) : null;
  const email = textField({ id: 'login-email', label: t('login.email'), type: 'email', autocomplete: 'username', required: true, dir: 'ltr' });
  const password = textField({ id: 'login-password', label: t('login.password'), type: 'password', autocomplete: 'current-password', required: true, dir: 'ltr' });

  const eye = h('button', {
    type: 'button', class: 'input-affix', 'aria-pressed': 'false', 'aria-label': t('login.showPassword'),
    onClick: () => {
      const show = password.input.type === 'password';
      password.input.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? t('login.hidePassword') : t('login.showPassword'));
      eye.replaceChildren(icon(show ? 'eyeOff' : 'eye', { size: 18 }));
    },
  }, icon('eye', { size: 18 }));
  const affixWrap = h('div', { class: 'input-wrap' });
  password.input.replaceWith(affixWrap);
  affixWrap.append(password.input, eye);

  const submit = h('button', { type: 'submit', class: 'btn btn--primary btn--block' }, t('login.submit'));
  const confirm = textField({ id: 'login-confirm', label: t('signup.confirm'), type: 'password', autocomplete: 'new-password', dir: 'ltr', hint: t('signup.passwordHint') });
  confirm.root.hidden = true;
  const modeBtn = h('button', { type: 'button', class: 'link-btn', id: 'login-mode', onClick: () => setMode(mode === 'signin' ? 'signup' : 'signin') }, t('signup.switchToSignup'));
  function setMode(m) {
    mode = m;
    const up = m === 'signup';
    confirm.root.hidden = !up;
    password.input.setAttribute('autocomplete', up ? 'new-password' : 'current-password');
    submit.textContent = up ? t('signup.submit') : t('login.submit');
    modeBtn.textContent = up ? t('signup.switchToSignin') : t('signup.switchToSignup');
    forgot.hidden = up;
    password.setError(''); confirm.setError('');
  }
  const messages = h('div', { class: 'gate__messages' });
  let restore = null;

  const forgot = h('button', {
    type: 'button', class: 'link-btn',
    onClick: () => {
      const err = validateEmail(email.input.value);
      email.setError(err ? t('login.resetNeedsEmail') : '');
      if (!err) session.requestPasswordReset(email.input.value);
      else email.input.focus();
    },
  }, t('login.forgot'));

  const form = h('form', {
    class: 'gate__form', novalidate: true,
    onSubmit: (e) => {
      e.preventDefault();
      const emailErr = validateEmail(email.input.value);
      email.setError(emailErr ? t(emailErr) : '');
      password.setError(password.input.value ? '' : t('validation.passwordRequired'));
      if (emailErr) return email.input.focus();
      if (!password.input.value) return password.input.focus();
      if (mode === 'signup') {
        const pw = password.input.value;
        if (pw.length < 8) { password.setError(t('signup.tooShort')); return password.input.focus(); }
        if (pw !== confirm.input.value) { confirm.setError(t('signup.mismatch')); return confirm.input.focus(); }
        session.createAccount(email.input.value, pw);
        return;
      }
      session.signIn(email.input.value, password.input.value);
    },
  }, inviteBanner, email.root, password.root, confirm.root, messages, submit,
  h('div', { class: 'gate__row gate__row--split' }, forgot, modeBtn));

  const el = h('main', { class: 'gate', id: 'main' },
    h('div', { class: 'gate__card' },
      h('div', { class: 'gate__top' }, quickToggles(prefs)),
      h('div', { class: 'gate__head' },
        brandMark('lg'),
        h('h1', { class: 'gate__title' }, 'HomeHub'),
        h('p', { class: 'gate__sub' }, t('login.subtitle'))),
      form));

  return {
    el,
    focus: () => email.input.focus(),
    update(state) {
      const busy = state.status === AppState.AUTHENTICATING;
      email.input.disabled = busy;
      password.input.disabled = busy;
      if (busy && !restore) restore = setBusy(submit, t('login.submitting'));
      if (!busy && restore) { restore(); restore = null; }
      messages.replaceChildren(
        state.formError ? banner('error', errorText(state.formError)) : '',
        state.notice ? banner('success', t(state.notice)) : '');
      if (state.formError && !busy) password.input.select();
    },
  };
}
