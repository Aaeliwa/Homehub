/** Polite status toasts (aria-live). One region, created on demand. */
import { h } from '../../core/utils/dom.js';

let region = null;

export function toast(message, { tone = 'info', timeout = 3500 } = {}) {
  if (!region) {
    region = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(region);
  }
  const el = h('div', { class: ['toast', `toast--${tone}`] }, message);
  // Phase 4: keep at most 3 visible so rapid actions never bury the page under toasts.
  while (region.children.length >= 3) region.firstChild.remove();
  region.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast--leaving');
    setTimeout(() => el.remove(), 250);
  }, timeout);
}
