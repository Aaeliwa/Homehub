/**
 * Contacts UI helpers (V6.4.1 Stage A): the "⋮" management menu, the WhatsApp brand icon slot and the
 * number chooser used by the Call / WhatsApp tile actions. DOM only; no data access.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { openDialog } from '../../ui/components/dialog.js';

/**
 * Accessible overflow menu (pattern of the Recipes card menu): a 44 px "⋮" button (aria-haspopup / -expanded /
 * -controls) and role="menu" items. ArrowDown / ArrowUp / Home / End move, Enter / Space activate, Escape
 * closes and returns focus, Tab or an outside click / tap closes. Positioned with logical properties, so it
 * opens toward the inline END in LTR and RTL. Items: [{ id, label, onSelect, disabled?, title?, tone? }];
 * returns null when there is nothing to show (no permission → no menu, never a menu of disabled writes).
 */
let seq = 0;
export function ellipsisMenu({ id, label, items }) {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  const menuId = `${id}-list-${++seq}`;
  const btn = h('button', { type: 'button', class: 'ct-more__btn', id, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId, 'aria-label': label, title: label }, '⋮');
  const entries = list.map((it) => h('button', { type: 'button', role: 'menuitem', class: ['ct-more__item', it.tone && `ct-more__item--${it.tone}`], id: it.id, tabindex: '-1',
    'aria-disabled': it.disabled ? 'true' : null, title: it.title || null,
    onClick: (e) => { e.stopPropagation(); if (it.disabled) return; close(false); it.onSelect(); } }, it.label));
  const menu = h('div', { class: 'ct-more__list', id: menuId, role: 'menu', 'aria-labelledby': id, hidden: true }, entries);
  const wrap = h('div', { class: 'ct-more' }, btn, menu);
  const outside = (e) => { if (!wrap.isConnected || !wrap.contains(e.target)) close(false); };
  function open(focusLast = false) {
    menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true); document.addEventListener('click', outside, true);
    (focusLast ? entries[entries.length - 1] : entries[0]).focus();
  }
  function close(focus) {
    if (menu.hidden) return;
    menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('click', outside, true);
    if (focus && btn.isConnected) btn.focus();
  }
  btn.addEventListener('click', (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(false); });
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(e.key === 'ArrowUp'); } });
  menu.addEventListener('keydown', (e) => {
    const i = entries.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); entries[(i + 1) % entries.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); entries[(i - 1 + entries.length) % entries.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); entries[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); entries[entries.length - 1].focus(); }
    else if (e.key === 'Tab') close(false);
  });
  wrap.ctMore = { open, close };
  return wrap;
}

/**
 * Re-render safety: the page redraws on every snapshot (another device edits a contact, a picture finishes
 * loading). An open "⋮" menu must survive that instead of vanishing under the finger — paint() closes the old
 * one cleanly (its document listeners are removed) and reopens the menu with the same id in the new DOM,
 * keeping the focused item.
 */
export function paint(container, ...nodes) {
  const old = container.querySelector('.ct-more__btn[aria-expanded="true"]');
  const openId = old && old.id;
  const focusId = openId && document.activeElement && document.activeElement.closest && document.activeElement.closest('.ct-more__list') ? document.activeElement.id : null;
  if (old) old.closest('.ct-more').ctMore.close(false);
  container.replaceChildren(...nodes);
  if (!openId) return;
  const btn = document.getElementById(openId); const wrap = btn && btn.closest('.ct-more');
  if (!wrap || !wrap.ctMore) return;
  wrap.ctMore.open();
  const f = focusId && document.getElementById(focusId);
  if (f && wrap.contains(f)) f.focus();
}

/**
 * WhatsApp brand icon. The official WhatsApp glyph is NOT drawn by this code: the household supplies the
 * official SVG from WhatsApp's brand resources at WA_ICON_SRC. One probe per app session decides: when the file
 * is present the green brand icon is shown (html[data-wa-icon="ok"]); otherwise a neutral green "WA" badge.
 */
export const WA_ICON_SRC = 'assets/brand/whatsapp.svg';
let probe = null;
function probeIcon() {
  if (probe) return; probe = true;
  const root = document.documentElement; root.dataset.waIcon = 'pending';
  const img = new Image();
  img.onload = () => { root.dataset.waIcon = 'ok'; };
  img.onerror = () => { root.dataset.waIcon = 'missing'; };
  img.src = WA_ICON_SRC;
}
export function waIcon() {
  probeIcon();
  return h('span', { class: 'ct-wa-ico', 'aria-hidden': 'true' }, h('span', { class: 'ct-wa-ico__fallback' }, 'WA'));
}

/**
 * Several usable numbers → ask which one (never guess). items: [{ label, number }]; onPick(item) runs the
 * action (Call = a tel: link the user taps; WhatsApp = the existing flow, which asks for a country code when
 * the number is national). Returns the dialog handle.
 */
export function chooseNumber({ title, items, action, container, onPick }) {
  let dlg = null;
  const list = h('ul', { class: 'ct-choose', id: 'ct-choose-list' }, items.map((it, i) => h('li', null,
    action === 'call'
      ? h('a', { class: 'btn btn--secondary ct-choose__opt', id: `ct-choose-${i}`, href: it.href, onClick: () => setTimeout(() => dlg && dlg.close(), 0) },
        h('span', { class: 'ct-choose__label' }, it.label), h('span', { class: 'ct-num', dir: 'ltr' }, it.number))
      : h('button', { type: 'button', class: 'btn btn--secondary ct-choose__opt', id: `ct-choose-${i}`, onClick: () => { dlg.close(); onPick(it); } },
        h('span', { class: 'ct-choose__label' }, it.label), h('span', { class: 'ct-num', dir: 'ltr' }, it.number)))));
  dlg = openDialog({ title, content: list, container, size: 'sm' });
  const first = list.querySelector('a, button'); if (first) first.focus();
  return dlg;
}
