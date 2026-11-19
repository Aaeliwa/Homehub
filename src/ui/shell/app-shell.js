/**
 * Authenticated application shell: desktop sidebar dock, sticky top bar with Home badge
 * and user menu, mobile bottom dock, and the page outlet. Navigation entries come from
 * the module registry (only implemented modules the user may view).
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { icon } from '../components/icons.js';
import { brandMark, roleLabel, initials } from '../components/common.js';

function navItems(registry, permissions) {
  return [
    { id: 'dashboard', path: '/dashboard', label: t('nav.dashboard'), glyph: () => icon('dashboard', { size: 22 }) },
    ...registry.navigableFor(permissions).map((m) => ({
      id: m.id, path: m.route, label: t(m.nameKey), glyph: () => h('span', { class: 'nav-emoji', 'aria-hidden': 'true' }, m.icon),
    })),
  ];
}

function isActive(item, route) {
  if (item.id === 'dashboard') return route.name === 'dashboard';
  if (item.id === 'settings') return route.name === 'settings';
  return route.name === 'module' && route.params.moduleId === item.id;
}

export function appShell({ state, registry, session, prefs, route }) {
  const perms = state.permissions;
  const bellEl = perms && (perms.can('cleaning.view') || perms.can('maintenance.view'))
    ? h('a', { class: 'bell-btn', href: '#/reminders', id: 'reminders-bell', 'aria-label': t('reminders.title') },
      icon('bell', { size: 16 }), h('span', { class: 'bell-btn__badge', hidden: true, 'aria-hidden': 'true' }))
    : null;
  const { home, profile, role, permissions, identity } = state;
  const items = navItems(registry, permissions);
  // glyph is a factory: each nav (rail + dock) needs its own DOM node.
  const settingsItem = { id: 'settings', path: '/settings', label: t('nav.settings'), glyph: () => icon('settings', { size: 22 }) };

  const link = (item, variant) => h('a', {
    href: `#${item.path}`,
    class: ['nav-link', `nav-link--${variant}`, isActive(item, route) && 'is-active'],
    'aria-current': isActive(item, route) ? 'page' : null,
    title: variant === 'rail' ? item.label : null,
    'aria-label': variant === 'rail' ? item.label : null,
  }, item.glyph(), variant === 'rail' ? null : h('span', { class: 'nav-link__label' }, item.label));

  // Elements updated in place when names change (no full re-render needed).
  const menuNameEl = h('p', { class: 'menu__name' }, profile.displayName);
  const avatarEl = h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(profile.displayName));
  const userNameEl = h('span', { class: 'user-btn__name' }, profile.displayName);
  const homeNameEl = h('span', { class: 'home-badge__name' }, home.name);

  // ---- user menu -------------------------------------------------------------------
  const menuId = 'user-menu';
  const menu = h('div', { class: 'menu', id: menuId, role: 'menu', hidden: true },
    h('div', { class: 'menu__head' },
      menuNameEl,
      h('p', { class: 'menu__email', dir: 'ltr' }, identity.email),
      h('p', { class: 'menu__role' }, roleLabel(role))),
    h('a', { href: '#/settings', class: 'menu__item', role: 'menuitem', onClick: () => closeMenu() }, icon('settings', { size: 18 }), t('nav.settings')),
    h('button', { type: 'button', class: 'menu__item menu__item--danger', role: 'menuitem', onClick: () => { closeMenu(); session.signOut(); } },
      icon('logout', { size: 18 }), t('common.signOut')));

  const menuButton = h('button', {
    type: 'button', class: 'user-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId,
    onClick: (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); },
  }, avatarEl, userNameEl, icon('chevronDown', { size: 16 }));

  function onDocClick(e) { if (!menu.contains(e.target)) closeMenu(); }
  function onKey(e) { if (e.key === 'Escape') { closeMenu(); menuButton.focus(); } }
  function openMenu() {
    menu.hidden = false;
    menuButton.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    const first = menu.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }
  function closeMenu() {
    menu.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  }

  // ---- layout ------------------------------------------------------------------------
  const outlet = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  const isDark = prefs.isDark;

  const el = h('div', { class: 'app' },
    h('a', { class: 'skip-link', href: '#main', onClick: (e) => { e.preventDefault(); outlet.focus(); } }, t('common.skipToContent')),

    h('aside', { class: 'rail', 'aria-label': t('nav.label') },
      h('a', { href: '#/dashboard', class: 'rail__brand', 'aria-label': 'HomeHub' }, brandMark('md')),
      h('nav', { class: 'rail__nav' }, items.map((i) => link(i, 'rail'))),
      h('div', { class: 'rail__tools' },
        link(settingsItem, 'rail'),
        h('button', { type: 'button', class: 'rail__btn', onClick: prefs.onToggleLanguage, title: t('prefs.switchLanguage'), 'aria-label': t('prefs.switchLanguage') },
          h('span', { class: 'rail__lang' }, t('prefs.otherLanguageShort'))),
        h('button', { type: 'button', class: 'rail__btn', onClick: prefs.onToggleTheme, title: isDark ? t('prefs.useLight') : t('prefs.useDark'), 'aria-label': isDark ? t('prefs.useLight') : t('prefs.useDark') },
          icon(isDark ? 'sun' : 'moon', { size: 20 })),
        h('button', { type: 'button', class: 'rail__btn rail__btn--danger', onClick: () => session.signOut(), title: t('common.signOut'), 'aria-label': t('common.signOut') },
          icon('logout', { size: 20 })))),

    h('header', { class: 'topbar' },
      h('div', { class: 'topbar__inner' },
        h('div', { class: 'topbar__home' },
          h('span', { class: 'topbar__brand' }, brandMark('sm')),
          h('span', { class: 'home-badge', title: t('shell.currentHome') },
            h('span', { class: 'home-badge__dot', 'aria-hidden': 'true' }),
            homeNameEl)),
        h('div', { class: 'topbar__actions' },
          // Phase 5.6: in-app Reminders (only with Cleaning or Maintenance view); own class, not a chip.
          bellEl,
          h('button', { type: 'button', class: 'chip-btn topbar__toggle', onClick: prefs.onToggleLanguage, 'aria-label': t('prefs.switchLanguage') },
            icon('globe', { size: 16 }), h('span', null, t('prefs.otherLanguageShort'))),
          h('button', { type: 'button', class: 'chip-btn chip-btn--icon topbar__toggle', onClick: prefs.onToggleTheme, 'aria-label': isDark ? t('prefs.useLight') : t('prefs.useDark') },
            icon(isDark ? 'sun' : 'moon', { size: 16 })),
          h('div', { class: 'user-menu' }, menuButton, menu)))),

    outlet,

    h('nav', { class: 'dock', 'aria-label': t('nav.label') }, dockItems()));

  // V6.4: the mobile dock is ONE horizontally scrollable row of every navigable destination (+ Settings):
  // no "More" overflow. Touch targets never shrink; the active item is scrolled into view; Arrow / Home /
  // End keys move between items (RTL aware); the row itself never causes page-level horizontal overflow.
  function dockItems() { return [...items, settingsItem].map((i) => link(i, 'dock')); }
  const dockEl = el.querySelector('.dock');
  dockEl.addEventListener('keydown', (e) => {
    const links = [...dockEl.querySelectorAll('a.nav-link')]; const i = links.indexOf(document.activeElement);
    if (i < 0) return;
    const rtl = getComputedStyle(dockEl).direction === 'rtl';
    const step = e.key === 'ArrowRight' ? (rtl ? -1 : 1) : e.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : step ? Math.min(links.length - 1, Math.max(0, i + step)) : -1;
    if (next < 0) return;
    e.preventDefault(); links[next].focus();
  });
  // Keep the current page's item visible (the shell is rebuilt on every route change).
  requestAnimationFrame(() => {
    const scrollable = dockEl.scrollWidth > dockEl.clientWidth + 1;
    dockEl.classList.toggle('dock--scroll', scrollable);   // edge fade hints that more items exist
    const active = dockEl.querySelector('.nav-link.is-active');
    if (active && scrollable) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
  });

  return {
    el,
    outlet,
    bellEl,   // Phase 5.6: main.js attaches the live count controller
    /** Refresh names after a live home rename or a profile edit. */
    update(next) {
      homeNameEl.textContent = next.home.name;
      menuNameEl.textContent = next.profile.displayName;
      userNameEl.textContent = next.profile.displayName;
      avatarEl.textContent = initials(next.profile.displayName);
    },
    destroy: closeMenu,
  };
}
