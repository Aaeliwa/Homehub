/**
 * Route handler for #/m/<moduleId>. Implemented modules are lazy-loaded through their
 * `page()` loader; planned modules show an honest "coming soon" page. Access is checked
 * against the module's viewPermission (Firestore rules enforce the data side).
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { icon } from '../components/icons.js';
import { log } from '../../core/utils/logger.js';
import { canSeeModule } from '../../modules/registry.js';

function notice(outlet, { mark, title, body, accent }) {
  outlet.replaceChildren(h('div', { class: 'page' },
    h('section', { class: ['card', 'card--notice', accent && `accent-${accent}`] },
      h('div', { class: 'notice__mark', 'aria-hidden': 'true' }, mark),
      h('h1', { class: 'notice__title' }, title),
      h('p', { class: 'notice__body' }, body),
      h('a', { class: 'btn btn--secondary', href: '#/dashboard' }, icon('back', { size: 18 }), t('common.backToDashboard')))));
}

export function mountModulePage(outlet, ctx, moduleId, view = null) {
  const m = ctx.registry.get(moduleId);
  const { permissions } = ctx.getState();

  if (!m) { ctx.navigate('/dashboard'); return {}; }

  if (!canSeeModule(m, permissions)) {
    notice(outlet, { mark: icon('lock', { size: 28 }), title: t('error.PERMISSION_DENIED.title'), body: t('module.noAccess') });
    return {};
  }

  if (!m.enabled) {
    notice(outlet, {
      mark: m.icon, accent: m.accent,
      title: t(m.nameKey),
      body: `${t(m.descriptionKey)} ${t('module.comingSoonBody')}`,
    });
    return {};
  }

  let alive = true;
  let unmount = null;
  outlet.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') })));
  m.page()
    .then((mod) => { if (alive) unmount = mod.mount(outlet, ctx, { view: view || null }); })   // Phase 5.4a: optional sub-view
    .catch((err) => {
      log.error(`Module ${m.id} failed to load`, err);
      if (alive) notice(outlet, { mark: icon('alert', { size: 28 }), title: t('error.UNKNOWN.title'), body: t('module.loadFailed') });
    });
  return { destroy() { alive = false; if (typeof unmount === 'function') unmount(); } };
}
