/**
 * Dashboard shell. Shows only real data from the foundation (home, user, role, settings,
 * member count). Tool tiles come from the registry; tools that are not built yet are
 * shown as "Coming soon". Implemented modules may contribute widgets through
 * `dashboardWidget` in their module definition — the dashboard mounts them without any
 * change here.
 */
import { h } from '../../core/utils/dom.js';
import { t, formatLongDate, hourIn, formatNumber, getLocale } from '../../core/i18n/i18n.js';
import { roleLabel } from '../components/common.js';
import { log } from '../../core/utils/logger.js';

function greetingKey(hour) {
  if (hour < 5) return 'dashboard.greeting.evening';
  if (hour < 12) return 'dashboard.greeting.morning';
  if (hour < 17) return 'dashboard.greeting.afternoon';
  return 'dashboard.greeting.evening';
}

function weekdayName(index) {
  // 2023-01-01 was a Sunday; add `index` days.
  const d = new Date(Date.UTC(2023, 0, 1 + index));
  return new Intl.DateTimeFormat(getLocale(), { weekday: 'long', timeZone: 'UTC' }).format(d);
}

function moduleTile(m) {
  const body = [
    h('span', { class: 'tile__icon', 'aria-hidden': 'true' }, m.icon),
    h('span', { class: 'tile__text' },
      h('span', { class: 'tile__name' }, t(m.nameKey)),
      h('span', { class: 'tile__desc' }, t(m.descriptionKey))),
    m.enabled ? null : h('span', { class: 'tile__status' }, t('common.comingSoon')),
  ];
  return h('a', { href: `#${m.route}`, class: ['tile', !m.enabled && 'tile--planned', `accent-${m.accent}`] }, body);
}

export function mountDashboard(outlet, ctx) {
  const state = ctx.getState();
  const { home, profile, role, permissions, homeSettings } = state;
  const now = new Date();

  const heroTitle = h('h1', { class: 'hero__home' }, home.name);
  const heroGreeting = h('p', { class: 'hero__greeting' },
    t(greetingKey(hourIn(now, home.timezone)), { name: profile.displayName }));

  const memberCount = h('dd', null, '—');
  const facts = h('dl', { class: 'facts' },
    h('div', null, h('dt', null, t('dashboard.yourRole')), h('dd', null, roleLabel(role))),
    permissions.can('members.view') ? h('div', null, h('dt', null, t('dashboard.members')), memberCount) : null,
    h('div', null, h('dt', null, t('settings.currency')), h('dd', null, home.currency)),
    h('div', null, h('dt', null, t('settings.timezone')), h('dd', { dir: 'ltr' }, home.timezone)),
    homeSettings ? h('div', null, h('dt', null, t('settings.weekStartsOn')), h('dd', null, weekdayName(homeSettings.weekStartsOn))) : null);
  // V6.4: active Rooms / Devices counts live here (their standalone dashboard tiles were removed).
  const countSlots = ctx.registry.homeCountsFor ? ctx.registry.homeCountsFor(permissions).map((m) => {
    const dd = h('dd', null, '…');
    facts.appendChild(h('div', { class: 'facts__row--count', dataset: { module: m.id } }, h('dt', null, t(m.nameKey)), dd));
    return { m, dd };
  }) : [];

  const tools = ctx.registry.visibleFor(permissions);
  const widgets = ctx.registry.widgetsFor(permissions);
  const widgetGrid = h('div', { class: 'widget-grid' });

  const page = h('div', { class: 'page page--dashboard' },
    h('section', { class: 'hero', 'aria-labelledby': 'hero-home' },
      h('div', { class: 'hero__body' },
        heroGreeting,
        Object.assign(heroTitle, { id: 'hero-home' }),
        h('p', { class: 'hero__date' }, formatLongDate(now, home.timezone))),
      h('span', { class: 'hero__mark', 'aria-hidden': 'true' }, '🏠')),

    // Module summaries sit right under the hero (Phase 2: first widget = Rooms).
    widgets.length ? h('section', { class: 'summaries', 'aria-label': t('dashboard.summaries') }, widgetGrid) : null,

    h('div', { class: 'dash-grid' },
      h('section', { class: 'card card--facts', 'aria-labelledby': 'facts-title' },
        h('div', { class: 'card__head' },
          h('h2', { class: 'card__title', id: 'facts-title' }, t('dashboard.homeCard')),
          permissions.can('home.edit') ? h('a', { class: 'text-link', href: '#/settings' }, t('dashboard.editHome')) : null),
        facts),

      h('section', { class: 'card card--tools', 'aria-labelledby': 'tools-title' },
        h('div', { class: 'card__head' },
          h('h2', { class: 'card__title', id: 'tools-title' }, t('dashboard.tools')),
          h('p', { class: 'card__hint' }, t('dashboard.toolsHint'))),
        tools.length
          ? h('div', { class: 'tile-grid' }, tools.map(moduleTile),
            // V6.4: Reminders keeps a Tools entry now that its dashboard tile is gone (same audience as the bell).
            permissions.can('cleaning.view') || permissions.can('maintenance.view')
              ? h('a', { href: '#/reminders', class: 'tile accent-amber', id: 'tool-reminders' },
                h('span', { class: 'tile__icon', 'aria-hidden': 'true' }, '🔔'),
                h('span', { class: 'tile__text' }, h('span', { class: 'tile__name' }, t('reminders.title')), h('span', { class: 'tile__desc' }, t('reminders.sub'))))
              : null)
          : h('p', { class: 'empty' }, t('dashboard.noTools')))));

  outlet.replaceChildren(page);

  // Real member count (requires members.view; rules enforce it).
  let alive = true;
  if (permissions.can('members.view')) {
    ctx.services.listMembers(home.id)
      .then((list) => { if (alive) memberCount.textContent = formatNumber(list.filter((m) => m.status === 'active').length); })
      .catch((err) => { log.warn('Member count unavailable', err && err.code); });
  }

  // Module widgets. Each widget: mount(el, ctx) -> unmount. The dashboard knows nothing
  // about a module's data; the widget renders the module's own summary.
  const unmounts = [];
  for (const m of widgets) {
    const slot = h('div', { class: ['widget', `widget--${m.dashboardWidget.size || 'md'}`] });
    widgetGrid.appendChild(slot);
    m.dashboardWidget.load()
      .then((mod) => { if (alive) { const off = mod.mount(slot, ctx); if (typeof off === 'function') unmounts.push(off); } })
      .catch((err) => { log.error(`Widget ${m.id} failed`, err); slot.remove(); });
  }
  // V6.4: the Reminders dashboard tile was removed. Reminders stay available via the bell (with its
  // badge), the Reminders page and the Tools entry; notifications are unchanged.
  for (const { m, dd } of countSlots) {
    m.homeCount.load()
      .then((mod) => { if (alive) { const off = mod.mountCount(dd, ctx); if (typeof off === 'function') unmounts.push(off); } })
      .catch((err) => { log.warn(`Home count ${m.id} unavailable`, err && err.code); dd.textContent = '—'; });
  }

  return {
    update(next) {
      heroTitle.textContent = next.home.name;
      heroGreeting.textContent = t(greetingKey(hourIn(new Date(), next.home.timezone)), { name: next.profile.displayName });
    },
    destroy() { alive = false; unmounts.forEach((fn) => fn()); },
  };
}
