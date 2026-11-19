/**
 * Contact media UI (V6.4 Batch C): circular avatar with initials fallback, the Restaurants "Menu" section and
 * a fullscreen image viewer (prev / next, swipe, pinch / double-tap / button zoom, pan, page counter, open
 * original, Esc / Back to exit).
 *
 * Privacy & safety:
 *  - Every URL was validated (https, no credentials, bounded) by contact-media.js AND by the Firestore rules;
 *    it is only ever assigned to img.src / iframe.src / a.href — never parsed as HTML.
 *  - Images: loading="lazy", referrerpolicy="no-referrer", no crossorigin (no credentials sent cross-site).
 *  - Menus make NO external request until the user opens the Menu section (and an embed only on "Show preview").
 *  - Embeds: Google Drive / Docs "/preview" URLs only (CSP frame-src allow-list + code allow-list), in an
 *    iframe sandboxed to "allow-scripts allow-same-origin" (no top navigation, popups, forms or downloads),
 *    no feature permissions, no referrer. An iframe "load" event is NOT treated as success: the hint about
 *    blocked / private previews and the "Open original" link are always shown.
 *  - External links: target=_blank + rel="noopener noreferrer" + referrerpolicy="no-referrer".
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { initials } from '../../ui/components/common.js';
import { isStoredUrl, menusOf, menuPresentation, driveEmbedUrl } from './contact-media.js';

export const EMBED_SANDBOX = 'allow-scripts allow-same-origin';

/** Circular avatar: initials underneath, the external picture on top; a missing / broken picture → initials. */
export function avatarEl(name, url, { lg = false, id } = {}) {
  const box = h('span', { class: ['avatar', lg && 'avatar--lg', 'ct-avatar'], 'aria-hidden': 'true', id, dataset: { avatar: 'initials' } },
    h('span', { class: 'ct-avatar__initials' }, initials(name)));
  if (isStoredUrl(url)) {
    box.dataset.avatar = 'loading';
    const img = h('img', { class: 'ct-avatar__img', alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false',
      onLoad: () => { box.dataset.avatar = 'image'; },
      onError: () => { img.remove(); box.dataset.avatar = 'broken'; } });
    img.src = url;                                                        // after referrerpolicy / loading are set
    box.append(img);
  }
  return box;
}

/** External link that never exposes this page (opener) or its URL (referrer). */
export const extLink = (url, text, attrs = {}) => h('a', { ...attrs, href: url, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer',
  class: attrs.class || 'btn btn--ghost btn--sm' }, text, h('span', { class: 'ct-sr' }, ` ${t('contacts.menu.newTab')}`));

/**
 * Menu section of a contact detail. `state` = { open: bool, previews: Set<index> } owned by the page (kept
 * across re-renders); `onChange()` re-renders. Nothing external is requested while `open` is false.
 */
export function menuSection(c, { state, onChange, canEdit, openViewer }) {
  const menus = menusOf(c);
  const images = menus.map((m, i) => ({ ...m, i })).filter((m) => menuPresentation(m) === 'image');
  const toggle = h('button', { type: 'button', class: 'btn btn--secondary', id: 'ct-menu-toggle', 'aria-expanded': String(state.open), 'aria-controls': 'ct-menu-body',
    disabled: !menus.length, onClick: () => { state.open = !state.open; if (!state.open) state.previews.clear(); onChange(); } },
    state.open ? t('contacts.menu.hide') : t('contacts.menu.show', { n: menus.length }));
  const head = h('div', { class: 'ct-menu__head' }, h('h3', { class: 'ct-menu__title' }, `🍽 ${t('contacts.menu.title')}`), menus.length ? toggle : null);
  if (!menus.length) return h('section', { class: 'ct-menu', id: 'ct-menu' }, head, h('p', { class: 'field__hint', id: 'ct-menu-none' }, t(canEdit ? 'contacts.menu.noneEdit' : 'contacts.menu.none')));
  const bodyEl = h('div', { id: 'ct-menu-body', class: 'ct-menu__body', hidden: !state.open });
  if (state.open) {
    bodyEl.append(h('ol', { class: 'ct-menu__list', id: 'ct-menu-list' }, menus.map((m, i) => {
      const how = menuPresentation(m); const title = m.label || t('contacts.menu.page', { n: i + 1 });
      const li = h('li', { class: 'ct-menu-item', dataset: { kind: m.kind, how, index: String(i) } },
        h('div', { class: 'ct-menu-item__head' }, h('span', { class: 'ct-menu-item__label', dir: 'auto' }, title), h('span', { class: 'pill' }, t(`contacts.kind.${m.kind}`))));
      if (how === 'image') {
        const status = h('span', { class: 'ct-menu-thumb__status', role: 'status' }, t('contacts.menu.loading'));
        const img = h('img', { class: 'ct-menu-thumb__img', alt: t('contacts.menu.thumbAlt', { name: title }), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false',
          onLoad: () => { thumb.dataset.state = 'loaded'; status.textContent = ''; },
          onError: () => { thumb.dataset.state = 'error'; img.hidden = true; status.textContent = t('contacts.menu.imgError'); } });
        img.src = m.url;
        const thumb = h('button', { type: 'button', class: 'ct-menu-thumb', id: `ct-menu-thumb-${i}`, dataset: { state: 'loading' }, 'aria-label': t('contacts.menu.view', { name: title }),
          onClick: () => openViewer(images, images.findIndex((x) => x.i === i)) }, img, status);
        li.append(thumb, h('div', { class: 'cl-item__actions' }, extLink(m.url, t('contacts.menu.open'), { id: `ct-menu-open-${i}` })));
      } else if (how === 'embed') {
        const shown = state.previews.has(i);
        li.append(h('div', { class: 'cl-item__actions' },
          h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: `ct-menu-preview-${i}`, 'aria-expanded': String(shown),
            onClick: () => { if (shown) state.previews.delete(i); else state.previews.add(i); onChange(); } }, t(shown ? 'contacts.menu.hidePreview' : 'contacts.menu.preview')),
          extLink(m.url, t('contacts.menu.open'), { id: `ct-menu-open-${i}` })));
        if (shown) {
          li.append(h('div', { class: 'ct-menu-embed' }, h('iframe', { class: 'ct-menu-embed__frame', id: `ct-menu-frame-${i}`, title: t('contacts.menu.frameTitle', { name: title }),
            sandbox: EMBED_SANDBOX, allow: '', referrerpolicy: 'no-referrer', loading: 'lazy', src: driveEmbedUrl(m.url) })));
        }
        li.append(h('p', { class: 'field__hint' }, t('contacts.menu.previewHint')));
      } else {
        li.append(h('div', { class: 'cl-item__actions' }, extLink(m.url, t(m.kind === 'pdf' ? 'contacts.menu.openPdf' : 'contacts.menu.openWeb'), { id: `ct-menu-open-${i}`, class: 'btn btn--secondary btn--sm' })),
          h('p', { class: 'field__hint' }, t(m.kind === 'pdf' ? 'contacts.menu.pdfHint' : 'contacts.menu.webHint')));
      }
      return li;
    })));
  }
  return h('section', { class: 'ct-menu', id: 'ct-menu', dataset: { open: String(state.open) } }, head,
    h('p', { class: 'field__hint' }, t('contacts.menu.privacy')), bodyEl);
}

/**
 * Fullscreen image viewer. items: [{ url, label }]. Returns { close }. Back (history) and Esc close it; focus
 * is trapped inside and restored afterwards. Gestures: swipe (when not zoomed), pinch, double-tap, drag-pan.
 */
export function openImageViewer(items, start = 0, { dir = document.documentElement.dir || 'ltr' } = {}) {
  const rtl = dir === 'rtl'; const back = document.activeElement;
  let i = Math.max(0, Math.min(start, items.length - 1)); let scale = 1; let tx = 0; let ty = 0;
  const img = h('img', { class: 'ct-viewer__img', id: 'ct-viewer-img', alt: '', referrerpolicy: 'no-referrer', decoding: 'async', draggable: 'false' });
  const status = h('p', { class: 'ct-viewer__status', id: 'ct-viewer-status', role: 'status' });
  const stage = h('div', { class: 'ct-viewer__stage', id: 'ct-viewer-stage', dataset: { state: 'loading' } }, img, status);
  const count = h('span', { class: 'ct-viewer__count', id: 'ct-viewer-count', dir: 'ltr', 'aria-live': 'polite' });   // "2 / 5" never mirrored
  const label = h('span', { class: 'ct-viewer__label', dir: 'auto' });
  const open = h('a', { class: 'btn btn--ghost btn--sm', id: 'ct-viewer-open', target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' }, t('contacts.menu.open'));
  const btn = (id, text, aria, fn) => h('button', { type: 'button', class: 'ct-viewer__btn', id, 'aria-label': aria, title: aria, onClick: fn }, text);
  const prev = btn('ct-viewer-prev', '‹',   // ‹ › are bidi-mirrored glyphs: RTL flips them automatically
   t('contacts.viewer.prev'), () => go(i - 1));
  const next = btn('ct-viewer-next', '›', t('contacts.viewer.next'), () => go(i + 1));
  const closeBtn = btn('ct-viewer-close', '✕', t('contacts.viewer.close'), () => finish('ui'));
  const zoomIn = btn('ct-viewer-zoomin', '+', t('contacts.viewer.zoomIn'), () => zoomTo(scale + 0.5));
  const zoomOut = btn('ct-viewer-zoomout', '−', t('contacts.viewer.zoomOut'), () => zoomTo(scale - 0.5));
  const reset = btn('ct-viewer-reset', '1:1', t('contacts.viewer.reset'), () => zoomTo(1));
  const overlay = h('div', { class: 'ct-viewer', id: 'ct-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('contacts.viewer.label'), dir },
    h('div', { class: 'ct-viewer__bar' }, count, label, h('span', { class: 'ct-viewer__tools' }, zoomOut, reset, zoomIn, open, closeBtn)),
    stage, h('div', { class: 'ct-viewer__nav' }, prev, next),
    h('p', { class: 'ct-viewer__hint' }, t('contacts.viewer.hint')));

  // a control that just became disabled (Next on the last page, Zoom out at 1×) must not drop focus to <body>
  const keepFocus = () => { const a = document.activeElement; if (a && a.disabled && overlay.contains(a)) (a === next && !prev.disabled ? prev : a === prev && !next.disabled ? next : closeBtn).focus(); };
  const apply = () => {
    const r = stage.getBoundingClientRect();
    const mx = Math.max(0, ((scale - 1) * r.width) / 2); const my = Math.max(0, ((scale - 1) * r.height) / 2);
    tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    stage.dataset.zoom = scale > 1 ? 'in' : 'out'; overlay.dataset.scale = String(Math.round(scale * 100) / 100);
    zoomOut.disabled = scale <= 1; reset.disabled = scale === 1; zoomIn.disabled = scale >= 4;
    keepFocus();
  };
  const zoomTo = (s) => { scale = Math.max(1, Math.min(4, s)); if (scale === 1) { tx = 0; ty = 0; } apply(); };
  function go(n) {
    if (n < 0 || n >= items.length) return;
    i = n; scale = 1; tx = 0; ty = 0; apply();
    const it = items[i];
    stage.dataset.state = 'loading'; status.textContent = t('contacts.menu.loading'); img.hidden = false;
    img.alt = it.label || t('contacts.menu.page', { n: i + 1 });
    img.onload = () => { stage.dataset.state = 'loaded'; status.textContent = ''; };
    img.onerror = () => { stage.dataset.state = 'error'; img.hidden = true; status.textContent = t('contacts.viewer.error'); };
    img.src = it.url;
    open.href = it.url; label.textContent = it.label || '';
    count.textContent = t('contacts.viewer.count', { i: i + 1, n: items.length });
    prev.disabled = i === 0; next.disabled = i === items.length - 1;
    keepFocus();
  }
  // ---- gestures (pointer events: mouse, pen, touch)
  const pts = new Map(); let pinch = null; let swipe = null; let lastTap = 0;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: scale }; swipe = null; }
    else if (pts.size === 1) swipe = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; zoomTo(pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)); return; }
    if (swipe) {
      const dx = e.clientX - swipe.x; const dy = e.clientY - swipe.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) swipe.moved = true;
      if (scale > 1) { tx = swipe.tx + dx; ty = swipe.ty + dy; apply(); }
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (swipe && pts.size === 0) {
      const dx = e.clientX - swipe.x; const dy = e.clientY - swipe.y;
      if (scale === 1 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(i + ((dx < 0) !== rtl ? 1 : -1));   // swipe toward the next page
      else if (!swipe.moved && e.type === 'pointerup') {
        const now = Date.now();
        if (now - lastTap < 320) { zoomTo(scale > 1 ? 1 : 2.5); lastTap = 0; } else lastTap = now;
      }
      swipe = null;
    }
  };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
  // ---- keyboard: Esc, arrows (mirrored in RTL), +/-/0, focus trap
  // keys are handled at document level while open (focus can never escape the modal, but be robust anyway)
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish('ui'); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); go(i + ((e.key === 'ArrowRight') !== rtl ? 1 : -1)); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(scale + 0.5); return; }
    if (e.key === '-') { e.preventDefault(); zoomTo(scale - 0.5); return; }
    if (e.key === '0') { e.preventDefault(); zoomTo(1); return; }
    if (e.key === 'Tab') {
      const f = [...overlay.querySelectorAll('button:not([disabled]), a[href]')]; if (!f.length) return;
      const k = f.indexOf(document.activeElement);
      if (e.shiftKey && k <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (k === f.length - 1 || k < 0)) { e.preventDefault(); f[0].focus(); }
    }
  };
  // ---- lifecycle (rev 2). One temporary history entry per open viewer, marked { ctViewer: token } on the SAME
  // URL (the hash route never changes, so the router never sees it). Closing:
  //   'ui'      button / Esc  → listeners + overlay removed NOW, then history.back() drops the entry (its popstate
  //             is recognised and ignored; a viewer opened before it arrives waits for it before pushing).
  //   'pop'     Android / browser Back → the entry is already gone.
  //   'unmount' the page is torn down (route change, household switch, sign-out, language / theme re-render):
  //             everything is removed synchronously and the marker is stripped with replaceState — never an
  //             asynchronous navigation in the middle of an app transition.
  let closed = false;
  const ctl = { token: ++seq, el: overlay, close: () => finish('ui'), finish };
  function finish(reason = 'unmount') {
    if (closed) return; closed = true;
    if (active === ctl) active = null;
    document.removeEventListener('keydown', onKey, true);
    img.onload = null; img.onerror = null; img.removeAttribute('src');
    overlay.remove();
    if (!active) document.documentElement.classList.remove('ct-viewer-open');
    const mine = !!(history.state && history.state[VIEWER_KEY] === ctl.token);
    if (reason === 'ui' && mine) { ownBacks++; armFallback(); history.back(); }
    else if (mine && reason !== 'handover') stripMarker();
    if ((reason === 'ui' || reason === 'pop') && back && back.isConnected && back.focus) back.focus();
  }
  installPopHandler();
  // never two viewers: a second open takes over the first one's history entry instead of stacking another
  const reuse = !!(active && history.state && history.state[VIEWER_KEY] === active.token);
  if (active) active.finish('handover');
  active = ctl;
  const mark = () => { if (!closed) history.pushState({ ...(history.state || {}), [VIEWER_KEY]: ctl.token }, ''); };
  if (reuse) history.replaceState({ ...(history.state || {}), [VIEWER_KEY]: ctl.token }, '');
  else if (ownBacks > 0) afterOwnBacks.push(mark);                      // a close's history.back() is still pending
  else mark();
  document.addEventListener('keydown', onKey, true);
  document.documentElement.classList.add('ct-viewer-open');
  document.body.append(overlay);
  go(i); closeBtn.focus();
  return ctl;
}

// ------------------------------------------------------------------ viewer history controller (module singleton)
const VIEWER_KEY = 'ctViewer';
let active = null;           // the open viewer (at most one)
let seq = 0;
let ownBacks = 0;            // history.back() calls issued by 'ui' closes whose popstate must be ignored
let afterOwnBacks = [];      // pushes waiting for those popstates (a viewer reopened right after a close)
let fallback = null;
let popInstalled = false;
function settleOwnBacks() { ownBacks = 0; clearTimeout(fallback); fallback = null; const q = afterOwnBacks; afterOwnBacks = []; for (const f of q) f(); }
// if a browser never delivers the popstate (e.g. the document was frozen), do not swallow a real Back later
function armFallback() { clearTimeout(fallback); fallback = setTimeout(settleOwnBacks, 1500); }
function stripMarker() {
  if (!history.state || !history.state[VIEWER_KEY]) return;
  const s = { ...history.state }; delete s[VIEWER_KEY];
  history.replaceState(Object.keys(s).length ? s : null, '');
}
function installPopHandler() {
  if (popInstalled) return; popInstalled = true;                        // ONE listener for the app's lifetime
  window.addEventListener('popstate', () => {
    if (ownBacks > 0) { ownBacks--; if (!ownBacks) settleOwnBacks(); return; }
    if (active) { active.finish('pop'); return; }
    stripMarker();   // landed on a stale viewer entry (its page was left while open): it never reopens anything
  });
}
/** Test / diagnostics hook: the controller's state (no side effects). */
export const viewerState = () => ({ open: !!active, pendingBacks: ownBacks, queued: afterOwnBacks.length });
