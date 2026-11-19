/** Full-screen loading state shown while the session or Home context resolves. */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { AppState } from '../../core/state/app-machine.js';
import { brandMark, spinner } from '../components/common.js';

const MESSAGE = {
  [AppState.BOOTING]: 'boot.checkingSession',
  [AppState.RESOLVING_CONTEXT]: 'boot.loadingHome',
};

export function bootScreen() {
  const status = h('p', { class: 'gate__status', role: 'status', 'aria-live': 'polite' });
  const el = h('main', { class: 'gate', id: 'main' },
    h('div', { class: 'gate__card gate__card--center' },
      brandMark('lg'),
      h('h1', { class: 'gate__title' }, 'HomeHub'),
      spinner(),
      status));
  return {
    el,
    update(state) { status.textContent = t(MESSAGE[state.status] || 'boot.loadingHome'); },
  };
}
