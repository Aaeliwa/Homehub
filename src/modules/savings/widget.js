/**
 * Life Savings dashboard card — only the member's OWN visible wealth (personal assets they can
 * read) plus household savings when permitted. Hidden entirely without any savings access.
 * Never includes other adults' private assets (the store cannot even read them).
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { getSavingsStore } from './savings-service.js';
import { todayIn } from '../expenses/calendar.js';
import { money } from './savings-ui.js';

export function mount(slot, ctx) {
  const { permissions, home, identity } = ctx.getState();
  if (!permissions.can('savings.view') && !permissions.can('savings.personal')) { slot.remove(); return () => {}; }
  let store;
  try { store = getSavingsStore(ctx); } catch { slot.remove(); return () => {}; }
  const body = h('span', { class: 'summary-card__body' });
  slot.replaceChildren(h('a', { class: 'summary-card accent-amber', href: '#/m/savings', id: 'sv-widget' }, h('span', { class: 'summary-card__icon', 'aria-hidden': 'true' }, '🪙'), body));
  return store.subscribe((snap) => {
    if (snap.status !== 'ready') return;
    const mine = snap.assets.filter((a) => a.visibility !== 'household' && (a.readers || []).includes(identity.uid));
    const household = permissions.can('savings.viewTotals') ? snap.assets.filter((a) => a.visibility === 'household') : [];
    const p = store.portfolio([...mine, ...household]);
    const z = permissions.can('savings.zakat') ? store.zakatFor(identity.uid, todayIn(home.timezone)) : null;
    body.replaceChildren(
      h('span', { class: 'summary-card__title' }, t('module.savings.name')),
      h('span', { class: 'summary-card__figure' }, h('span', { class: 'summary-card__value', id: 'sv-widget-total' }, money(p.totalMinor, home.currency)), h('span', { class: 'summary-card__label' }, t('savings.widget.visible'))),
      z ? h('span', { class: 'summary-card__extra', id: 'sv-widget-zakat' }, t(`zakat.short.${z.status}`)) : '');
  });
}
