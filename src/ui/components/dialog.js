/**
 * Accessible modal dialog built on the native <dialog> element (showModal gives focus
 * containment, Escape-to-close and an inert background). Focus returns to the element
 * that opened it. Shared by modules — added in Phase 2.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { icon } from './icons.js';

let counter = 0;

/**
 * @param {object} o
 * @param {string} o.title
 * @param {Node|Node[]} o.content
 * @param {Node[]} [o.footer]       buttons rendered in the footer
 * @param {Element} [o.container]   where to attach (defaults to document.body)
 * @param {Function} [o.onClose]
 * @param {'md'|'sm'} [o.size]
 */
export function openDialog({ title, content, footer = [], container, onClose, size = 'md', role = 'dialog' }) {
  const id = `dlg-${++counter}`;
  const opener = document.activeElement;
  const closeBtn = h('button', { type: 'button', class: 'dialog__close', 'aria-label': t('common.close'), onClick: () => close() },
    icon('close', { size: 18 }));
  const el = h('dialog', { class: ['dialog', `dialog--${size}`], 'aria-labelledby': `${id}-title`, role: role === 'alertdialog' ? 'alertdialog' : null },
    h('div', { class: 'dialog__head' },
      h('h2', { class: 'dialog__title', id: `${id}-title` }, title),
      closeBtn),
    h('div', { class: 'dialog__body' }, content),
    footer.length ? h('div', { class: 'dialog__foot' }, footer) : null);

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    if (el.open) el.close();
    el.remove();
    if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
    if (onClose) onClose(result);
  }
  el.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  el.addEventListener('click', (e) => { if (e.target === el) close(); }); // backdrop click

  (container || document.body).appendChild(el);
  el.showModal();
  const firstField = el.querySelector('.dialog__body input, .dialog__body select, .dialog__body textarea');
  (firstField || closeBtn).focus();
  return { el, close };
}

/** Confirmation with explicit, labelled actions. Resolves true only when confirmed. */
export function confirmDialog({ title, message, confirmLabel, tone = 'danger', container }) {
  return new Promise((resolve) => {
    let answer = false;
    const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel'));
    const ok = h('button', {
      type: 'button', class: ['btn', tone === 'danger' ? 'btn--danger' : 'btn--primary'],
      onClick: () => { answer = true; dlg.close(); },
    }, confirmLabel);
    const dlg = openDialog({
      title, size: 'sm', role: 'alertdialog', container,
      content: h('p', { class: 'dialog__text' }, message),
      footer: [cancel, ok],
      onClose: () => resolve(answer),
    });
    cancel.focus(); // safe default for destructive confirmations
  });
}
