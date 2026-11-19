/**
 * Finance page (#/m/expenses). Tabs: Overview · History · Bills · Wallets (V6.2.1: the 10-day budget,
 * Advanced and Household tabs are gone from navigation; their records stay readable and keep balances right).
 * Scope switch: Home (household records the member may see) / Mine (wallets the member owns).
 * Everything renders from the shared scope-bound finance store (no listeners of its own).
 */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { icon } from '../../ui/components/icons.js';
import { banner, errorText } from '../../ui/components/common.js';
import { getFinanceStore } from './finance-service.js';
import { getFamilyStore } from '../../core/family/family-service.js';
import { todayIn, formatDateLong, formatDateShort, formatMonth } from './calendar.js';
import { spendingTotals } from './ledger.js';
import { categoryIcon } from './finance-model.js';
import { money, catLabel, stat } from './finance-ui.js';
import { quickAdd } from './expense-form.js';
import { renderCommitmentsTab } from './tab-commitments.js';
import { renderWalletsTab } from './tab-wallets.js';
import { renderMonthlyTab, renderHistoryTab } from './tab-monthly.js';   // V6.2 daily Finance; V6.2.1 shared History table
import { getCalendarStore } from '../calendar/calendar-service.js';

const TABS = Object.freeze(['overview', 'history', 'commitments', 'wallets']);   // V6.2.1: no 10-day budget / Advanced / Household

export function mount(outlet, ctx) {
  const state = ctx.getState();
  const { permissions, identity, home } = state;
  const can = permissions.can;
  let store;
  try { store = getFinanceStore(ctx); } catch (err) { outlet.replaceChildren(h('div', { class: 'page' }, banner('error', errorText(err)))); return () => {}; }

  const canHousehold = can('expenses.view');
  const canTotals = can('expenses.viewFinancialTotals');
  const today = todayIn(home.timezone);
  const locale = getLocale();
  let tab = 'overview';
  let calStore = null; try { calStore = getCalendarStore(ctx, { optional: true }); } catch { calStore = null; }
  // V6.2: page-session state of the daily view (selected month survives re-renders and tab switches).
  const ui = { ym: null, q: '', cal: 'all', cat: 'all', wallet: 'all', limit: 50, picker: false, budgetOpen: false };
  let scope = canHousehold ? 'home' : 'mine';

  const root = h('div', { class: 'page page--finance accent-emerald' });
  // Phase 4A: names come from the SHARED member directory (one members listener per home),
  // never per-row reads. Without members.view, only "you" can be named.
  const fctx = { ...ctx, financeRoot: root, financeMembers: [], directory: null };
  let family = null;
  try { family = getFamilyStore(ctx); } catch { family = null; }
  const syncDirectory = () => {
    const dir = family ? family.directory() : null;
    fctx.directory = dir;
    fctx.financeMembers = dir ? dir.active() : [];
  };
  syncDirectory();
  const nameOf = (uid) => (uid === identity.uid ? (state.profile.displayName || t('settings.you'))
    : (fctx.directory && fctx.directory.nameOf(uid, t('finance.member.former'))) || t('finance.member.former'));
  /** "Added by …" (· "paid by …") — shown under each transaction name in the shared table. */
  const attribution = (e) => {
    if (e.source === 'import') return t('finance.history.importedLabel');
    const parts = [t('finance.history.addedBy', { name: nameOf(e.createdBy) })];
    if (e.paidBy && e.paidBy !== e.createdBy) parts.push(t('finance.history.paidBy', { name: nameOf(e.paidBy) }));
    return parts.join(' · ');
  };

  const tabBar = h('div', { class: 'fin-tabs', role: 'tablist', 'aria-label': t('module.expenses.name') });
  const scopeBar = h('div', { class: 'view-switch', role: 'group', 'aria-label': t('finance.scope.label') });
  const panel = h('div', { class: 'fin-panel', role: 'tabpanel', id: 'fin-panel', tabindex: '-1' });
  const status = h('div', { 'aria-live': 'polite' });
  const qaSlot = h('div');

  root.append(
    h('header', { class: 'page-head page-head--row' },
      h('div', null, h('h1', { class: 'page-head__title' }, t('module.expenses.name')), h('p', { class: 'page-head__sub' }, formatDateLong(today, locale))),
      scopeBar),
    qaSlot, tabBar, status, panel);
  outlet.replaceChildren(root);

  /** Records in the current scope. Home = household audience; Mine = wallets I own. */
  function inScope(list, walletKeys = ['walletId']) {
    if (scope === 'home') return list.filter((r) => (r.audience ?? 'household') === 'household');
    const mine = new Set(store.getSnapshot().wallets.filter((w) => w.ownerUid === identity.uid).map((w) => w.id));
    return list.filter((r) => walletKeys.some((k) => mine.has(r[k])));
  }
  const showTotals = () => (scope === 'mine' ? true : canTotals);

  function renderTabs() {
    const shown = TABS; if (!shown.includes(tab)) tab = 'overview';
    tabBar.replaceChildren(...shown.map((id) => h('button', {
      type: 'button', role: 'tab', id: `fin-tab-${id}`, class: 'fin-tab', 'aria-selected': String(tab === id), 'aria-controls': 'fin-panel',
      tabindex: tab === id ? '0' : '-1',
      onClick: () => { tab = id; render(); },
      onKeydown: (e) => {
        const i = shown.indexOf(tab);
        const next = e.key === 'ArrowRight' ? (document.dir === 'rtl' ? i - 1 : i + 1) : e.key === 'ArrowLeft' ? (document.dir === 'rtl' ? i + 1 : i - 1) : null;
        if (next === null) return;
        tab = shown[(next + shown.length) % shown.length]; render();
        root.querySelector(`#fin-tab-${tab}`).focus();
      },
    }, t(`finance.tab.${id === 'commitments' ? 'bills' : id}`))));
    scopeBar.replaceChildren(...(canHousehold ? ['home', 'mine'] : ['mine']).map((id) => h('button', {
      type: 'button', class: 'view-switch__btn', 'aria-pressed': String(scope === id), onClick: () => { scope = id; render(); },
    }, t(`finance.scope.${id}`))));
  }

  // ---- overview ------------------------------------------------------------------------
  function overview() {
    const s = store.getSnapshot();
    const month = today.slice(0, 7);
    const exp = inScope(s.expenses);
    const tot = spendingTotals(exp, { month });
    const up = inScope(store.upcoming(today, 45)).slice(0, 4);
    const cats = Object.entries(tot.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return h('div', { class: 'fin-grid' },
      // V6.2: the simple monthly view starts once household Cash / Bank accounts exist.
      scope === 'home' && can('expenses.manageWallets') ? h('section', { class: 'card fin-card fin-callout', id: 'fm-setup' },
        h('h2', { class: 'card__title' }, t('finance.v62.setupTitle')), h('p', null, t('finance.v62.setupHint')),
        h('button', { type: 'button', class: 'btn btn--primary btn--sm', id: 'fm-setup-open', onClick: () => { tab = 'wallets'; render(); } }, t('finance.v6.setupBtn'))) : null,
      showTotals() ? h('section', { class: 'card fin-card' },
        h('h2', { class: 'card__title' }, formatMonth(month, locale)),
        h('div', { class: 'fin-stats' },
          stat(t('finance.overview.total'), money(tot.totalMinor, home.currency), { id: 'fin-month-total' }),
          stat(t('finance.overview.fixed'), money(tot.fixedMinor, home.currency)),
          stat(t('finance.overview.variable'), money(tot.variableMinor, home.currency))),
        cats.length ? h('ul', { class: 'fin-bars', 'aria-label': t('finance.overview.byCategory') }, cats.map(([c, v]) => h('li', null,
          h('span', { class: 'fin-bars__label' }, `${categoryIcon(c)} ${catLabel(c)}`),
          h('span', { class: 'fin-bars__track', 'aria-hidden': 'true' }, h('span', { class: 'fin-bars__fill', style: { inlineSize: `${Math.max(4, Math.round((v / tot.totalMinor) * 100))}%` } })),
          h('span', { class: 'fin-bars__value', dir: 'ltr' }, money(v, home.currency))))) : h('p', { class: 'empty' }, t('finance.overview.noSpending')))
        : h('section', { class: 'card fin-card' }, h('p', { class: 'muted-note' }, icon('lock', { size: 16 }), t('finance.totalsHidden'))),
      h('section', { class: 'card fin-card' },
        h('h2', { class: 'card__title' }, t('finance.upcoming.title')),
        up.length ? h('ul', { class: 'fin-list' }, up.map((c) => h('li', { class: 'fin-row' },
          h('span', { class: 'fin-row__date' }, formatDateShort(c.nextDueDate, locale)),
          h('span', { class: 'fin-row__main', dir: 'auto' }, c.name, c.overdue ? h('span', { class: 'pill pill--warn' }, t('finance.upcoming.overdue')) : null),
          h('span', { class: 'fin-row__amount', dir: 'ltr' }, showTotals() ? money(c.amountMinor, c.currency) : '')))) : h('p', { class: 'empty' }, t('finance.upcoming.none')),
        h('p', { class: 'field__hint' }, t('finance.upcoming.note'))));
  }

  function canEdit(e) {
    if (!e.walletId) return can('expenses.edit');
    const w = store.wallet(e.walletId);
    if (!w) return false;
    return w.visibility === 'household' ? can('expenses.edit') : (w.readers || []).includes(identity.uid) && can('expenses.personal');
  }

  /** V6.2: the daily monthly view needs household Cash / Bank accounts; otherwise the previous overview (+ a setup prompt). */
  const dailyMode = () => scope === 'home' && store.getSnapshot().wallets.some((w) => w.active === true && w.role && w.visibility === 'household');
  function render() {
    const snap = store.getSnapshot();
    // Keep focus/caret across live re-renders (typing in search, using the tabs).
    const active = document.activeElement;
    const inQa = qaSlot.contains(active);
    const activeId = !inQa && root.contains(active) ? active.id : null;
    const caret = activeId && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    renderTabs();
    // The quick-add form is rebuilt only when the user is not typing in it.
    if (!inQa) qaSlot.replaceChildren(!dailyMode() && (can('expenses.create') || can('expenses.personal')) ? quickAdd({ store, ctx: fctx, today, scope }) : '');
    if (snap.status === 'error') status.replaceChildren(banner('error', errorText(snap.error)));
    else if (snap.status !== 'ready') status.replaceChildren(h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') }));
    else status.replaceChildren();
    panel.setAttribute('aria-labelledby', `fin-tab-${tab}`);
    const env = { store, ctx: fctx, today, locale, home, can, identity, inScope, showTotals, scope, rerender: render,
      // V6 batch 3: household budgets — owners / admins only (mirrors the rules' role check).
      budgetAdmin: can('expenses.manageBudgets') && ['owner', 'admin'].includes(state.membership && state.membership.roleId),
      ui, canEdit, attribution, nameOf, cal: calStore };
    if (!ui.ym) ui.ym = today.slice(0, 7);
    const views = { overview: () => (dailyMode() ? renderMonthlyTab(env) : overview()), history: () => renderHistoryTab(env), commitments: () => renderCommitmentsTab(env), wallets: () => renderWalletsTab(env) };
    panel.replaceChildren(views[tab]());
    if (activeId) {
      const el = root.querySelector(`#${CSS.escape(activeId)}`);
      if (el) { el.focus({ preventScroll: true }); if (caret !== null && el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch { /* not a text input */ } } }
    }
  }

  // Re-render on every data change (focus and caret are preserved inside render()).
  const offFamily = family ? family.subscribe(() => { syncDirectory(); }) : () => {};
  const off = store.subscribe(() => render());
  const offCal = calStore ? calStore.subscribe(() => { if (tab === 'overview' || tab === 'history') render(); }) : () => {};   // V6.2: work / vacation filter
  return () => { off(); offFamily(); offCal(); };
}
