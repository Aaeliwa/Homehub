/**
 * Explicit error state. Every context failure lands here with a clear explanation and
 * the actions that make sense for that failure. No raw Firebase messages are shown.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { ErrorCode } from '../../core/errors/app-error.js';
import { icon } from '../components/icons.js';
import { quickToggles } from '../components/common.js';

/** Which recovery actions apply to which failure. */
const NEW_HOME_OK = new Set([
  ErrorCode.DEFAULT_HOME_MISSING, ErrorCode.HOME_NOT_FOUND, ErrorCode.MEMBERSHIP_MISSING,
  ErrorCode.MEMBERSHIP_INACTIVE,
]);

export function errorScreen({ state, session, prefs }) {
  const err = state.error || { code: ErrorCode.UNKNOWN };
  const isInit = err.code === ErrorCode.FIREBASE_INIT_FAILED;
  const signedIn = Boolean(state.identity);

  // Phase 5.1: the creator's own pre-membership Home → one-time upgrade, never "new home".
  if (err.code === ErrorCode.LEGACY_HOME_ADOPTION_REQUIRED || err.code === ErrorCode.LEGACY_HOME_ADOPTION_BLOCKED) {
    return legacyScreen({ state, session, prefs, err });
  }

  const actions = h('div', { class: 'gate__actions' },
    isInit
      ? h('button', { type: 'button', class: 'btn btn--primary', onClick: () => location.reload() }, icon('refresh', { size: 18 }), t('common.reload'))
      : h('button', { type: 'button', class: 'btn btn--primary', onClick: () => session.retry() }, icon('refresh', { size: 18 }), t('common.tryAgain')),
    !isInit && signedIn && NEW_HOME_OK.has(err.code)
      ? h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => session.startNewHome() }, t('error.createNewHome'))
      : null,
    !isInit && signedIn
      ? h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => session.signOut() }, icon('logout', { size: 18 }), t('common.signOut'))
      : null);

  const el = h('main', { class: 'gate', id: 'main' },
    h('div', { class: 'gate__card', role: 'alert' },
      prefs ? h('div', { class: 'gate__top' }, quickToggles(prefs)) : null,
      h('div', { class: 'gate__head' },
        h('div', { class: 'gate__error-mark', 'aria-hidden': 'true' }, icon('alert', { size: 28 })),
        h('h1', { class: 'gate__title' }, t(`error.${err.code}.title`)),
        h('p', { class: 'gate__sub' }, t(`error.${err.code}.body`))),
      signedIn ? h('p', { class: 'gate__who', dir: 'ltr' }, state.identity.email) : null,
      h('p', { class: 'gate__code' }, t('error.reference', { code: err.code })),
      actions));

  return { el, update() {} };
}

function legacyScreen({ state, session, prefs, err }) {
  const required = err.code === ErrorCode.LEGACY_HOME_ADOPTION_REQUIRED;
  const homeName = err.adoption && err.adoption.homeName;
  const btn = required ? h('button', { type: 'button', class: 'btn btn--primary', id: 'legacy-upgrade', onClick: () => {
    btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = t('legacy.upgrading');
    session.adoptLegacyHome();
  } }, t('legacy.upgrade')) : null;
  const el = h('main', { class: 'gate', id: 'main' },
    h('div', { class: 'gate__card', role: required ? 'region' : 'alert', 'aria-labelledby': 'legacy-title' },
      prefs ? h('div', { class: 'gate__top' }, quickToggles(prefs)) : null,
      h('div', { class: 'gate__head' },
        h('div', { class: 'gate__error-mark gate__error-mark--info', 'aria-hidden': 'true' }, icon(required ? 'lock' : 'alert', { size: 28 })),
        h('h1', { class: 'gate__title', id: 'legacy-title' }, t(`error.${err.code}.title`)),
        h('p', { class: 'gate__sub', id: 'legacy-body' }, t(`error.${err.code}.body`))),
      homeName ? h('p', { class: 'gate__who', dir: 'auto', id: 'legacy-home' }, homeName) : null,
      required ? h('ul', { class: 'legacy-points' },
        h('li', null, t('legacy.point.same')),
        h('li', null, t('legacy.point.data')),
        h('li', null, t('legacy.point.once'))) : null,
      state.identity ? h('p', { class: 'gate__who', dir: 'ltr' }, state.identity.email) : null,
      h('p', { class: 'gate__code' }, t('error.reference', { code: err.code })),
      h('div', { class: 'gate__actions' }, btn,
        !required ? h('button', { type: 'button', class: 'btn btn--primary', onClick: () => session.retry() }, icon('refresh', { size: 18 }), t('common.tryAgain')) : null,
        h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => session.signOut() }, icon('logout', { size: 18 }), t('common.signOut')))));
  return { el, update() {} };
}
