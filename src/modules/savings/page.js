/**
 * Life Savings / مدخراتي (#/m/savings). Tabs: Overview · Assets · Activity · Valuation · Zakat.
 * Scope: Home (household assets, savings.view) / Mine (assets I can read as a person).
 * Renders only what the shared stores hold — i.e. only what Firestore rules let this member read.
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { icon } from '../../ui/components/icons.js';
import { banner, errorText } from '../../ui/components/common.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { toast } from '../../ui/components/toast.js';
import { vmsg } from '../expenses/dialogs.js';
import { todayIn, formatDateLong } from '../expenses/calendar.js';
import { getSavingsStore } from './savings-service.js';
import { TYPE_ICONS, ASSET_TYPES, isMetal } from './savings-model.js';
import { valueOf, quoteKeyFor, metalPrice, latestQuote, freshness, isLive, metalKey } from './valuation.js';
import { createHttpProvider } from './providers.js';
import { money, typeLabel, purityLabel, qtyText, freshPill, ownerName, quoteTime } from './savings-ui.js';
import { openAssetForm, openEventForm, openTransfer, openWalletTransfer, openPriceForm } from './savings-dialogs.js';
import { renderZakatTab } from './zakat-tab.js';

const TABS = ['overview', 'assets', 'activity', 'valuation', 'zakat'];

export function mount(outlet, ctx) {
  const state = ctx.getState();
  const { permissions, identity, home } = state;
  const can = permissions.can;
  let store;
  try { store = getSavingsStore(ctx); } catch (err) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err)))); return () => {}; }
  const canHousehold = can('savings.view');
  const locale = getLocale();
  const today = todayIn(home.timezone);
  let tab = 'overview';
  let scope = canHousehold ? 'home' : 'mine';
  const filter = { type: 'all', visibility: 'all', archived: false };
  const act = { assetId: '', type: '' };
  let zakatOwner = identity.uid;
  const provider = createHttpProvider();

  // Shared directories (no extra listeners): family members + Finance wallets, when permitted.
  let family = null; let finance = null;
  const env = { store, can, identity, home, today, locale, members: [], children: [], wallets: [] };
  const offs = [];
  Promise.all([import('../../core/family/family-service.js'), import('../expenses/finance-service.js')]).then(([fam, fin]) => {
    try { family = fam.getFamilyStore(ctx); offs.push(family.subscribe(() => { refreshDirs(); })); } catch { /* no family access */ }
    try { if (can('expenses.view') || can('expenses.personal')) { finance = fin.getFinanceStore(ctx); offs.push(finance.subscribe(() => { refreshDirs(); })); } } catch { /* no finance */ }
  });
  function refreshDirs() {
    const dir = family ? family.directory() : null;
    env.directory = dir;
    env.members = dir ? dir.active().filter((m) => m.uid !== identity.uid && m.relationship !== 'child') : [];
    env.children = dir ? dir.childrenOf(identity.uid) : [];
    env.wallets = finance ? finance.activeWallets().filter((w) => (w.visibility === 'household' ? can('expenses.transfer') : (w.readers || []).includes(identity.uid) && can('expenses.personal'))) : [];
  }

  const root = h('div', { class: 'page page--savings accent-amber' });
  const ctxS = { ...ctx, savingsRoot: root };
  env.ctx = ctxS;
  env.showScope = (sc) => { if (sc !== scope && (sc === 'mine' || canHousehold)) { scope = sc; render(); } };
  const tabBar = h('div', { class: 'fin-tabs', role: 'tablist', 'aria-label': t('module.savings.name') });
  const scopeBar = h('div', { class: 'view-switch', role: 'group', 'aria-label': t('finance.scope.label') });
  const panel = h('div', { class: 'fin-panel', role: 'tabpanel', id: 'sv-panel', tabindex: '-1' });
  const status = h('div', { 'aria-live': 'polite' });
  root.append(h('header', { class: 'page-head page-head--row' },
    h('div', null, h('h1', { class: 'page-head__title' }, t('module.savings.name')), h('p', { class: 'page-head__sub' }, t('savings.subtitle'))), scopeBar),
  tabBar, status, panel);
  outlet.replaceChildren(root);

  const inScope = (list) => (scope === 'home' ? list.filter((a) => a.visibility === 'household')
    : list.filter((a) => a.visibility !== 'household' && (a.readers || []).includes(identity.uid)));
  const showTotals = () => scope === 'mine' || can('savings.viewTotals');
  const mayManage = (a) => (a.scope === 'home' ? can('savings.manageHousehold')
    : can('savings.personal') && (a.createdBy === identity.uid || (a.ownerUid === identity.uid && !['child'].includes(state.membership.roleId))));
  const mayMove = (a, transfer) => (a.scope === 'home' ? can(transfer ? 'savings.transfer' : 'savings.manageHousehold') : (a.readers || []).includes(identity.uid) && can('savings.personal'));

  function renderTabs() {
    tabBar.replaceChildren(...TABS.map((id) => h('button', { type: 'button', role: 'tab', id: `sv-tab-${id}`, class: 'fin-tab', 'aria-selected': String(tab === id), 'aria-controls': 'sv-panel', tabindex: tab === id ? '0' : '-1',
      onClick: () => { tab = id; render(); } }, t(`savings.tab.${id}`))));
    scopeBar.replaceChildren(...(canHousehold ? ['home', 'mine'] : ['mine']).map((id) => h('button', { type: 'button', class: 'view-switch__btn', 'aria-pressed': String(scope === id), onClick: () => { scope = id; render(); } }, t(`finance.scope.${id}`))));
  }

  // ---- overview -------------------------------------------------------------------------
  function overview() {
    const assets = inScope(store.getSnapshot().assets);
    const p = store.portfolio(assets);
    const add = can('savings.personal') || can('savings.manageHousehold') ? h('button', { type: 'button', class: 'btn btn--primary', id: 'sv-add', onClick: () => openAssetForm(env) }, icon('plus', { size: 18 }), t('savings.asset.add')) : null;
    if (!assets.filter((a) => a.active).length) {
      return h('section', { class: 'card empty-state' }, h('span', { class: 'empty-state__mark', 'aria-hidden': 'true' }, '🪙'),
        h('h2', { class: 'empty-state__title' }, t('savings.empty.title')), h('p', { class: 'empty-state__body' }, t('savings.empty.body')), add);
    }
    const z = scope === 'mine' && can('savings.zakat') ? store.zakatFor(identity.uid, today) : null;
    return h('div', { class: 'fin-grid' },
      h('section', { class: 'card fin-card' },
        h('h2', { class: 'card__title' }, t('savings.overview.total')),
        showTotals() ? h('p', { class: 'sv-total', id: 'sv-total', dir: 'ltr' }, money(p.totalMinor, home.currency)) : h('p', { class: 'muted-note' }, t('finance.totalsHidden')),
        p.stale ? h('p', { class: 'field__hint' }, t('savings.overview.stale')) : null,
        p.unvalued.length ? h('p', { class: 'field__hint', id: 'sv-unvalued' }, t('savings.overview.unvalued', { names: p.unvalued.map((a) => a.name).join('، ') })) : null,
        showTotals() ? h('ul', { class: 'fin-bars' }, ASSET_TYPES.filter((ty) => p.byType[ty]).map((ty) => h('li', null,
          h('span', { class: 'fin-bars__label' }, `${TYPE_ICONS[ty]} ${typeLabel(ty)}`),
          h('span', { class: 'fin-bars__track', 'aria-hidden': 'true' }, h('span', { class: 'fin-bars__fill', style: { inlineSize: `${Math.max(4, Math.round((p.byType[ty] / Math.max(1, p.totalMinor)) * 100))}%` } })),
          h('span', { class: 'fin-bars__value', dir: 'ltr' }, money(p.byType[ty], home.currency))))) : null,
        add),
      z ? h('section', { class: 'card fin-card' }, h('h2', { class: 'card__title' }, t('zakat.title')), h('p', null, t(`zakat.short.${z.status}`)),
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onClick: () => { tab = 'zakat'; render(); } }, t('zakat.open'))) : null);
  }

  // ---- assets ------------------------------------------------------------------------------
  function assetCard(a) {
    const qty = store.balance(a.id);
    const v = valueOf(a, qty, store.getSnapshot().quotes, { homeCurrency: home.currency, nowMs: Date.now() });
    const btn = (label, fn, cls = 'btn--secondary') => h('button', { type: 'button', class: ['btn', 'btn--sm', cls], onClick: fn }, label);
    return h('li', { class: ['sv-asset', !a.active && 'sv-asset--archived'], dataset: { id: a.id } },
      h('span', { class: 'fin-wallet__icon', 'aria-hidden': 'true' }, TYPE_ICONS[a.type]),
      h('div', { class: 'fin-wallet__main' },
        h('p', { class: 'fin-wallet__name', dir: 'auto' }, a.name),
        h('p', { class: 'fin-wallet__sub' }, [typeLabel(a.type), isMetal(a.type) ? purityLabel(a.type, a.purity) : a.currency, ownerName(a, env.directory, identity.uid),
          t(`finance.visibility.${a.visibility}`), a.zakatTreatment === 'excluded' ? t('savings.zakatTreatment.excluded') : null].filter(Boolean).join(' · ')),
        h('p', { class: 'sv-asset__qty', dir: 'ltr', id: `sv-qty-${a.id}` }, qtyText(a, qty))),
      h('div', { class: 'sv-asset__side' },
        showTotals() || a.ownerUid === identity.uid ? h('span', { class: 'fin-wallet__balance', dir: 'ltr', id: `sv-val-${a.id}` }, v.valueMinor === null ? t('savings.noValue') : money(v.valueMinor, home.currency)) : null,
        freshPill(v.status, v.quote)),
      h('div', { class: 'fin-actions sv-asset__actions' },
        a.active && mayMove(a, false) ? btn(t('savings.event.contribution'), () => openEventForm(env, a, 'contribution')) : null,
        a.active && mayMove(a, false) ? btn(t('savings.event.withdrawal'), () => openEventForm(env, a, 'withdrawal')) : null,
        a.active && mayMove(a, false) ? btn(t('savings.event.adjustment'), () => openEventForm(env, a, 'adjustment'), 'btn--ghost') : null,
        a.active && mayMove(a, true) ? btn(t('finance.transfer.title'), () => openTransfer(env, a) || toast(t('savings.transfer.noTarget'), { tone: 'info' }), 'btn--ghost') : null,
        a.active && mayMove(a, true) && env.wallets.length ? btn(t('savings.wallet.in'), () => openWalletTransfer(env, a, 'in', env.wallets) || toast(t('savings.wallet.noWallet'), { tone: 'info' }), 'btn--ghost') : null,
        a.active && mayMove(a, true) && env.wallets.length && !isMetal(a.type) ? btn(t('savings.wallet.out'), () => openWalletTransfer(env, a, 'out', env.wallets) || toast(t('savings.wallet.noWallet'), { tone: 'info' }), 'btn--ghost') : null,
        mayManage(a) && a.active ? btn(t('rooms.edit'), () => openAssetForm(env, a), 'btn--ghost') : null,
        mayManage(a) ? btn(a.active ? t('finance.archive') : t('rooms.restore'), async () => {
          if (a.active && !(await confirmDialog({ title: t('savings.asset.archiveTitle', { name: a.name }), message: t('savings.asset.archiveBody'), confirmLabel: t('finance.archive'), container: root }))) return;
          try { await (a.active ? store.archiveAsset(a.id) : store.restoreAsset(a.id)); toast(t(a.active ? 'finance.toast.archived' : 'finance.toast.restored'), { tone: 'success' }); } catch (e) { toast(vmsg(e), { tone: 'error' }); }
        }, 'btn--ghost') : null));
  }
  function assets() {
    const all = inScope(store.getSnapshot().assets);
    const list = all.filter((a) => (filter.archived ? !a.active : a.active) && (filter.type === 'all' || a.type === filter.type) && (filter.visibility === 'all' || a.visibility === filter.visibility))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sel = (id, label, opts, key) => h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, label),
      h('select', { id, class: 'input input--sm', onChange: (e) => { filter[key] = e.target.value === 'true' ? true : e.target.value === 'false' ? false : e.target.value; render(); } }, opts.map((o) => h('option', { value: String(o.value), selected: o.value === filter[key] }, o.label))));
    return h('div', { class: 'fin-stack' },
      h('div', { class: 'toolbar' }, h('div', { class: 'toolbar__filters' },
        sel('sv-f-type', t('savings.field.type'), [{ value: 'all', label: t('savings.filter.allTypes') }, ...ASSET_TYPES.map((x) => ({ value: x, label: typeLabel(x) }))], 'type'),
        sel('sv-f-vis', t('savings.field.visibility'), ['all', 'private', 'shared', 'household'].map((x) => ({ value: x, label: x === 'all' ? t('savings.filter.all') : t(`finance.visibility.${x}`) })), 'visibility'),
        sel('sv-f-arch', t('savings.filter.state'), [{ value: false, label: t('rooms.status.active') }, { value: true, label: t('rooms.status.archived') }], 'archived')),
      (can('savings.personal') || can('savings.manageHousehold')) ? h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openAssetForm(env) }, icon('plus', { size: 18 }), t('savings.asset.add')) : null),
      list.length ? h('ul', { class: 'fin-wallets', id: 'sv-assets' }, list.map(assetCard)) : h('p', { class: 'empty' }, t('savings.assets.none')));
  }

  // ---- activity (newest first) ---------------------------------------------------------------
  function activity() {
    const visibleIds = new Set(inScope(store.getSnapshot().assets).map((a) => a.id));
    const evs = store.activity({ assetId: act.assetId || undefined, type: act.type || undefined }).filter((e) => visibleIds.has(e.assetId));
    const assetsList = inScope(store.getSnapshot().assets);
    return h('div', { class: 'fin-stack' },
      h('div', { class: 'toolbar' }, h('div', { class: 'toolbar__filters' },
        h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t('savings.activity.asset')), h('select', { id: 'sv-a-asset', class: 'input input--sm', onChange: (e) => { act.assetId = e.target.value; render(); } },
          h('option', { value: '' }, t('savings.filter.all')), assetsList.map((a) => h('option', { value: a.id, selected: a.id === act.assetId }, a.name)))),
        h('label', { class: 'toolbar__field' }, h('span', { class: 'toolbar__label' }, t('savings.activity.type')), h('select', { id: 'sv-a-type', class: 'input input--sm', onChange: (e) => { act.type = e.target.value; render(); } },
          h('option', { value: '' }, t('savings.filter.all')), ['opening', 'contribution', 'withdrawal', 'adjustment', 'transfer_in', 'transfer_out'].map((x) => h('option', { value: x, selected: x === act.type }, t(`savings.eventType.${x}`))))))),
      evs.length ? h('ul', { class: 'fin-list', id: 'sv-activity' }, evs.map((e) => {
        const a = store.asset(e.assetId);
        return h('li', { class: 'fin-row', dataset: { type: e.type } },
          h('span', { class: 'fin-row__date' }, formatDateLong(e.date, locale, { month: 'short', year: undefined })),
          h('span', { class: 'fin-row__main' }, h('span', { class: 'fin-row__note', dir: 'auto' }, `${t(`savings.eventType.${e.type}`)} · ${a ? a.name : ''}`),
            h('span', { class: 'fin-row__sub' }, [e.walletId ? t('savings.activity.wallet') : null, e.costMinor ? t('savings.activity.cost', { cost: money(e.costMinor, e.costCurrency) }) : null,
              env.directory ? t('finance.history.addedBy', { name: env.directory.nameOf(e.createdBy, t('family.formerMember')) }) : null, e.note].filter(Boolean).join(' · '))),
          h('span', { class: 'fin-row__amount', dir: 'ltr' }, `${e.qty > 0 ? '+' : '−'}${a ? qtyText(a, Math.abs(e.qty)) : Math.abs(e.qty)}`));
      })) : h('p', { class: 'empty' }, t('savings.activity.none')));
  }

  // ---- valuation -----------------------------------------------------------------------------
  function valuation() {
    const s = store.getSnapshot();
    const keys = new Set(['gold-21', 'gold-24', 'silver-999']);
    for (const a of inScope(s.assets)) { const k = quoteKeyFor(a, home.currency); if (k) keys.add(k); }
    const now = Date.now();
    const row = (k) => {
      const metal = k.includes('-');
      const q = metal ? metalPrice(s.quotes, k.split('-')[0], k.split('-')[1]) : latestQuote(s.quotes, k);
      const fr = q ? (q.derived ? 'derived' : q.source === 'manual' ? (freshness(q, now) === 'stale' ? 'staleManual' : 'manual') : isLive(q, now) ? 'live' : 'stale') : 'unavailable';
      return h('li', { class: 'fin-row', dataset: { key: k } },
        h('span', { class: 'fin-row__main' }, h('span', { class: 'fin-row__note' }, t(`savings.priceKey.${metal ? k : 'fx'}`, { c: k })),
          h('span', { class: 'fin-row__sub' }, q ? `${quoteTime(q, locale)}${q.note ? ` · ${q.note}` : ''}` : t('savings.price.none'))),
        h('span', { class: ['pill', `fresh--${fr}`] }, t(`savings.fresh.${fr}`)),
        h('span', { class: 'fin-row__amount', dir: 'ltr', id: `sv-price-${k}` }, q ? `${money(q.priceMinor, home.currency)}${metal ? '/g' : ''}` : '—'),
        can('savings.prices') ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: () => openPriceForm(env, k) }, t('savings.price.update')) : null);
    };
    const hist = [...s.quotes].sort((a, b) => b.observedAt - a.observedAt).slice(0, 15);
    return h('div', { class: 'fin-stack' },
      h('section', { class: 'card fin-card' }, h('h2', { class: 'card__title' }, t('savings.price.current')),
        h('p', { class: 'field__hint', id: 'sv-provider' }, provider.configured ? t('savings.provider.configured') : t('savings.provider.unconfigured')),
        h('ul', { class: 'fin-list', id: 'sv-prices' }, [...keys].map(row)),
        can('savings.prices') ? h('button', { type: 'button', class: 'btn btn--secondary', id: 'sv-add-price', onClick: () => openPriceForm(env) }, t('savings.price.add')) : null),
      h('section', { class: 'card fin-card' }, h('h2', { class: 'card__title' }, t('savings.price.history')),
        hist.length ? h('ul', { class: 'fin-list' }, hist.map((q) => h('li', { class: 'fin-row' }, h('span', { class: 'fin-row__date' }, quoteTime(q, locale)),
          h('span', { class: 'fin-row__main' }, `${t(`savings.priceKey.${q.key.includes('-') ? q.key : 'fx'}`, { c: q.key })} · ${t(q.source === 'manual' ? 'savings.fresh.manual' : 'savings.fresh.live')}${env.directory ? ` · ${env.directory.nameOf(q.createdBy, '')}` : ''}`),
          h('span', { class: 'fin-row__amount', dir: 'ltr' }, money(q.priceMinor, home.currency))))) : h('p', { class: 'empty' }, t('savings.price.none'))));
  }

  function render() {
    refreshDirs();
    const snap = store.getSnapshot();
    renderTabs();
    if (snap.status === 'error') status.replaceChildren(banner('error', errorText(snap.error)));
    else if (snap.status !== 'ready') status.replaceChildren(h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') }));
    else status.replaceChildren();
    const z = { ...env, zakatOwner, setZakatOwner: (u) => { zakatOwner = u; render(); } };
    panel.replaceChildren({ overview, assets, activity, valuation, zakat: () => renderZakatTab(z) }[tab]());
  }
  offs.push(store.subscribe(() => render()));
  return () => offs.forEach((o) => o());
}
