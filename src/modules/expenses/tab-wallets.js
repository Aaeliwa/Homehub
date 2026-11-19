/**
 * Wallets: household (Cash, Bank, Visa, Digital) and personal (own, shared with selected
 * members, a child's allowance). Balances, funding, transfers, archiving and restoring, sharing, and —
 * for the owner — the one-time historical CSV import.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { toast } from '../../ui/components/toast.js';
import { CURRENCIES } from '../../config/app-config.js';
import { WALLET_TYPES } from './finance-model.js';
import { money, amountInput, field, select } from './finance-ui.js';
import { parseMinor, minorToPlain } from './money.js';
import { formatDateShort } from './calendar.js';
import { getLocale } from '../../core/i18n/i18n.js';
import { formDialog, vmsg, val } from './dialogs.js';
import { openImport } from './import-dialog.js';

/**
 * V6.2.1 (moved from the retired Household tab): set up the household Cash and Bank accounts — the two
 * wallet records the Wallet choice of every expense maps to. Shown on Home scope until they exist.
 */
function cashBankSetup(env) {
  const { store, today, can, ctx, identity } = env; const container = ctx.financeRoot;
  const F = (...a) => field(...a).root;
  const minor = (raw) => { const r = parseMinor(raw, { allowNegative: true, allowZero: true }); if (r.error || r.value === null) throw Object.assign(new Error(r.error || 'finance.validation.amountRequired'), { detail: r.error || 'finance.validation.amountRequired' }); return r.value; };
  const memberUids = (ctx.financeMembers || []).map((m) => m.uid).concat(identity.uid);
  return h('section', { class: 'card fin-card fin-callout', id: 'v6-setup' },
    h('h2', { class: 'card__title' }, t('finance.v6.setupTitle')), h('p', { class: 'field__hint' }, t('finance.v6.setupHint')),
    can('expenses.manageWallets') ? h('button', { type: 'button', class: 'btn btn--primary', id: 'v6-setup-btn', onClick: () => formDialog({
      title: t('finance.v6.setupTitle'), id: 'v6-setup-form', submitLabel: t('common.save'), container,
      fields: [F(t('finance.v6.openingDate'), h('input', { id: 'v6-od', type: 'date', class: 'input', value: today }), { id: 'v6-od', hint: t('finance.v6.openingDateHint') }),
        F(t('finance.v6.bankOpening'), amountInput('v6-bank-open', '0'), { id: 'v6-bank-open', hint: t('finance.v6.negativeHint') }),
        F(t('finance.v6.cashOpening'), amountInput('v6-cash-open', '0'), { id: 'v6-cash-open' })],
      onSubmit: async () => {
        const root = document.getElementById('v6-setup-form'); const od = val(root, '#v6-od');
        const b = minor(val(root, '#v6-bank-open')); const c = minor(val(root, '#v6-cash-open'));
        await store.createAccount({ name: t('finance.v6.bank'), role: 'bank', openingDate: od, openingMinor: b }, { memberUids });
        await store.createAccount({ name: t('finance.v6.cash'), role: 'cash', openingDate: od, openingMinor: c }, { memberUids });
        return 'finance.v6.toast.setup';
      } }) }, t('finance.v6.setupBtn')) : h('p', { class: 'field__hint' }, t('finance.v6.setupNoPermission')));
}

const TYPE_ICON = { cash: '💵', bank: '🏦', card: '💳', digital: '📱', allowance: '🧒', other: '👛' };

function memberChecks(env, selected = [], exclude = null) {
  const members = (env.ctx.financeMembers || []).filter((m) => m.uid !== exclude);
  if (!members.length) return h('p', { class: 'field__hint' }, t('finance.wallet.noMembers'));
  return h('fieldset', { class: 'fin-members' }, h('legend', { class: 'field__label' }, t('finance.wallet.shareWith')),
    members.map((m) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name: 'wl-share', value: m.uid, checked: selected.includes(m.uid) }), h('span', null, m.displayName))));
}

export function openWalletForm(env, existing) {
  const { store, can, identity, home, ctx, today } = env;
  const editing = Boolean(existing);
  const scopes = [...(can('expenses.manageWallets') ? ['home'] : []), ...(can('expenses.personal') || can('expenses.manageWallets') ? ['personal'] : [])];
  const scope = editing ? existing.scope : scopes[0];
  const name = field(t('finance.field.name'), h('input', { id: 'wl-name', class: 'input', maxlength: 60, dir: 'auto', value: editing ? existing.name : '' }), { id: 'wl-name' });
  const type = field(t('finance.wallet.type'), select('wl-type', WALLET_TYPES.map((x) => ({ value: x, label: `${TYPE_ICON[x]} ${t(`finance.walletType.${x}`)}` })), editing ? existing.type : 'cash'), { id: 'wl-type' });
  const sc = field(t('finance.wallet.scope'), select('wl-scope', scopes.map((s) => ({ value: s, label: t(`finance.walletScope.${s}`) })), scope), { id: 'wl-scope' });
  if (editing) sc.root.querySelector('select').disabled = true;
  const members = ctx.financeMembers || [];
  const owner = field(t('finance.wallet.owner'), select('wl-owner', (can('expenses.manageWallets') ? members : members.filter((m) => m.uid === identity.uid)).map((m) => ({ value: m.uid, label: m.uid === identity.uid ? t('settings.you') : m.displayName }))
    .concat(members.some((m) => m.uid === identity.uid) ? [] : [{ value: identity.uid, label: t('settings.you') }]), editing ? existing.ownerUid : identity.uid), { id: 'wl-owner', hint: t('finance.wallet.ownerHint') });
  if (editing) owner.root.querySelector('select').disabled = true;
  const vis = field(t('finance.wallet.visibility'), select('wl-vis', ['private', 'shared'].map((x) => ({ value: x, label: t(`finance.visibility.${x}`) })), editing ? existing.visibility : 'private'), { id: 'wl-vis' });
  const shareSlot = h('div');
  const currency = field(t('settings.currency'), select('wl-currency', [...new Set([home.currency, ...CURRENCIES])].map((c) => ({ value: c, label: c })), editing ? existing.currency : home.currency), { id: 'wl-currency', hint: t('finance.wallet.currencyHint') });
  if (editing) currency.root.querySelector('select').disabled = true;
  const opening = field(t('finance.wallet.opening'), amountInput('wl-opening'), { id: 'wl-opening', hint: t('finance.wallet.openingHint') });
  const sync = () => {
    const personal = val(ctx.financeRoot || document, '#wl-scope') === 'personal';
    owner.root.hidden = !personal; vis.root.hidden = !personal;
    const shared = personal && vis.root.querySelector('select').value === 'shared';
    const ownerUid = owner.root.querySelector('select').value;
    // Phase 4A: a child's wallet pre-selects the child's guardians (still editable, still explicit).
    const guardians = !editing && ctx.directory ? ctx.directory.guardiansOf(ownerUid) : [];
    if (!editing && guardians.length && personal && vis.root.querySelector('select').value === 'private' && !sync.autoShared) {
      sync.autoShared = true; vis.root.querySelector('select').value = 'shared';
    }
    const isShared = personal && vis.root.querySelector('select').value === 'shared';
    shareSlot.replaceChildren(isShared ? h('div', null, memberChecks(env, editing ? existing.sharedWith || [] : guardians, ownerUid),
      guardians.length ? h('p', { class: 'field__hint' }, t('finance.wallet.guardiansDefault')) : null) : '');
  };
  return formDialog({
    title: editing ? t('finance.wallet.editTitle') : t('finance.wallet.addTitle'), id: 'wallet-form',
    submitLabel: editing ? t('common.save') : t('finance.wallet.add'), container: ctx.financeRoot,
    fields: [h('div', { class: 'form-grid form-grid--tight' }, name.root, type.root, sc.root, owner.root, vis.root, currency.root), shareSlot, editing ? null : opening.root,
      // V6.2.2: the opening balance is never rewritten here — a difference is corrected as its own record.
      editing ? h('div', { class: 'fin-callout', id: 'wl-correct-callout' }, h('p', { class: 'field__hint' }, t('finance.v622.editBalanceHint')),
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', id: 'wl-correct-from-edit',
          onClick: (e) => { const d = e.currentTarget.closest('dialog'); if (d) d.close(); openCorrection(env, existing); } }, `⚖ ${t('finance.v622.correct')}`)) : null,
      h('p', { class: 'field__hint' }, t('finance.wallet.privacyNote'))].filter(Boolean),
    onSubmit: async () => {
      const r = ctx.financeRoot;
      const memberUids = members.map((m) => m.uid).concat(identity.uid);
      const shared = [...r.querySelectorAll('input[name="wl-share"]:checked')].map((x) => x.value);
      const input = { name: val(r, '#wl-name'), type: val(r, '#wl-type'), scope: val(r, '#wl-scope'), ownerUid: val(r, '#wl-owner'),
        visibility: val(r, '#wl-vis'), sharedWith: shared, currency: val(r, '#wl-currency'), openingBalance: editing ? null : val(r, '#wl-opening') };
      if (editing) { await store.updateWallet(existing.id, input, { memberUids }); return 'finance.toast.saved'; }
      await store.createWallet(input, { memberUids, date: today }); return 'finance.toast.walletAdded';
    },
  }) && setTimeout(() => {
    const r = ctx.financeRoot;
    for (const id of ['#wl-scope', '#wl-vis', '#wl-owner']) { const el = r.querySelector(id); if (el) el.addEventListener('change', sync); }
    sync();
  }, 0);
}

export function openMovement(env, kind, preset = {}) {
  const { store, can, identity, today, ctx } = env;
  const usable = store.activeWallets().filter((w) => (w.visibility === 'household' ? can('expenses.transfer') : (w.readers || []).includes(identity.uid) && can('expenses.personal')));
  if (!usable.length) { toast(t('finance.wallet.noneUsable'), { tone: 'info' }); return; }
  const opts = usable.map((w) => ({ value: w.id, label: `${w.name} (${w.currency})` }));
  const from = field(t('finance.transfer.from'), select('mv-from', opts, preset.fromWalletId || opts[0].value), { id: 'mv-from' });
  const to = field(t('finance.transfer.to'), select('mv-to', opts, preset.toWalletId || (opts[1] || opts[0]).value), { id: 'mv-to' });
  const amount = field(t('finance.field.amount'), amountInput('mv-amount'), { id: 'mv-amount' });
  const date = field(t('finance.field.date'), h('input', { id: 'mv-date', type: 'date', class: 'input', value: today }), { id: 'mv-date' });
  const note = field(t('finance.field.note'), h('input', { id: 'mv-note', class: 'input', maxlength: 200, dir: 'auto' }), { id: 'mv-note' });
  const transfer = kind === 'transfer';
  return formDialog({
    title: t(transfer ? 'finance.transfer.title' : 'finance.funding.title'), id: 'movement-form',
    submitLabel: t(transfer ? 'finance.transfer.submit' : 'finance.funding.submit'), container: ctx.financeRoot,
    fields: [h('p', { class: 'fin-callout' }, t(transfer ? 'finance.transfer.explain' : 'finance.funding.explain')),
      h('div', { class: 'form-grid form-grid--tight' }, transfer ? from.root : null, to.root, amount.root, date.root), note.root],
    onSubmit: async () => {
      const r = ctx.financeRoot;
      await store.addMovement({ type: transfer ? 'transfer' : 'funding', amount: val(r, '#mv-amount'), date: val(r, '#mv-date'),
        fromWalletId: transfer ? val(r, '#mv-from') : null, toWalletId: val(r, '#mv-to'), note: val(r, '#mv-note') });
      return transfer ? 'finance.toast.transferred' : 'finance.toast.funded';
    },
  });
}

/**
 * V6.2.2 Correct Balance: shows the calculated balance, asks for the actual one, previews the signed
 * difference and writes ONE append-only correction (store.correctBalance). Never income / spending.
 */
export function openCorrection(env, w) {
  const { store, today, ctx } = env;
  const current = store.balance(w.id);   // the figure the user is looking at (stale check on confirm)
  const fmt = (m) => money(m, w.currency);
  const delta = h('p', { class: 'fin-callout', id: 'cb-delta', 'aria-live': 'polite' });
  const actual = amountInput('cb-actual', minorToPlain(current));
  const parse = () => { const r = parseMinor(actual.value, { allowNegative: true, allowZero: true }); return r.error || r.value === null ? null : r.value; };
  const preview = () => { const v = parse();
    delta.textContent = v === null ? t('finance.validation.amountInvalid') : v === current ? t('finance.v622.noChange')
      : t('finance.v622.preview', { delta: `${v > current ? '+' : '−'}${fmt(Math.abs(v - current))}`, before: fmt(current), after: fmt(v) }); };
  actual.addEventListener('input', preview); preview();
  return formDialog({ title: t('finance.v622.correctTitle', { name: w.name }), id: 'cb-form', submitLabel: t('finance.v622.correctConfirm'), container: ctx.financeRoot,
    fields: [h('p', { class: 'field__hint' }, `${w.name} · ${w.currency}`),
      h('p', null, `${t('finance.v622.current')}: `, h('b', { id: 'cb-current', dir: 'ltr' }, fmt(current))),
      field(t('finance.v622.actual'), actual, { id: 'cb-actual', hint: t('finance.v6.negativeHint') }).root,
      field(t('finance.field.date'), h('input', { id: 'cb-date', type: 'date', class: 'input', value: today, max: today, min: w.openingDate || null }), { id: 'cb-date' }).root,
      field(t('finance.v6.reason'), h('input', { id: 'cb-reason', class: 'input', maxlength: 200, dir: 'auto', required: true }), { id: 'cb-reason' }).root,
      delta, h('p', { class: 'field__hint' }, t('finance.v622.correctNote'))],
    onSubmit: async () => {
      const r = document.getElementById('cb-form'); const v = parse();
      if (v === null) throw Object.assign(new Error('x'), { detail: 'finance.validation.amountInvalid' });
      await store.correctBalance({ walletId: w.id, actualMinor: v, date: val(r, '#cb-date'), reason: val(r, '#cb-reason'), expectedBeforeMinor: current, today });
      return 'finance.v622.toast.corrected';
    } });
}

/** V6.2.2 Delete wallet = archive (soft). Required Cash / Bank and wallets with active bills are blocked. */
export function openDeleteWallet(env, w) {
  const { store, ctx } = env;
  const chk = store.removalCheck(w.id);
  if (chk.blocked) {
    return formDialog({ title: t('finance.v622.cannotDelete', { name: w.name }), id: 'wl-del-form', submitLabel: t('common.close'), container: ctx.financeRoot,
      fields: [h('p', { class: 'banner banner--warning', id: 'wl-del-blocked', role: 'alert' }, t(chk.blocked)),
        chk.bills.length ? h('ul', { class: 'fin-list', id: 'wl-del-bills' }, chk.bills.map((c) => h('li', { class: 'fin-row', dir: 'auto' }, c.name))) : null].filter(Boolean),
      onSubmit: async () => undefined });
  }
  return formDialog({ title: t('finance.v622.deleteTitle', { name: w.name }), id: 'wl-del-form', submitLabel: t('finance.v622.delete'), container: ctx.financeRoot,
    fields: [h('p', { id: 'wl-del-body' }, t('finance.v622.deleteBody')),
      ...chk.warnings.map((k) => h('p', { class: 'banner banner--warning', dataset: { warn: k } }, t(`finance.v622.warn.${k}`, { balance: money(store.balance(w.id), w.currency) })))],
    onSubmit: async () => { await store.archiveWallet(w.id); return 'finance.v622.toast.deleted'; } });
}

/** V6.2.2 Balance adjustments history (newest first): date · signed delta (before → after) · reason · by. */
function adjustments(env, w) {
  const rows = env.store.adjustmentHistory(w.id); if (!rows.length) return null;
  const fmt = (m) => money(m, w.currency);
  return h('details', { class: 'form-section fin-adj', id: `wl-adj-${w.id}` },
    h('summary', { class: 'form-section__summary' }, t('finance.v622.history', { n: rows.length })),
    h('ul', { class: 'fin-list' }, rows.map((r) => h('li', { class: 'fin-row', dataset: { adj: r.id } },
      h('span', { class: 'fin-row__main', dir: 'auto' }, r.reason,
        h('span', { class: 'fin-row__sub' }, [formatDateShort(r.date, getLocale()), r.beforeMinor !== null ? `${fmt(r.beforeMinor)} → ${fmt(r.afterMinor)}` : null,
          env.nameOf ? t('finance.history.addedBy', { name: env.nameOf(r.by) }) : null, r.status === 'void' ? t('finance.v622.voided') : null].filter(Boolean).join(' · '))),
      h('span', { class: 'fin-row__amount', dir: 'ltr' }, `${r.deltaMinor > 0 ? '+' : '−'}${fmt(Math.abs(r.deltaMinor))}`)))));
}

export function renderWalletsTab(env) {
  const { store, can, identity, inScope, showTotals, scope } = env;
  const s = store.getSnapshot();
  const list = s.wallets.filter((w) => (scope === 'home' ? w.visibility === 'household' : w.ownerUid === identity.uid || (w.readers || []).includes(identity.uid)));
  const active = list.filter((w) => w.active === true); const archived = list.filter((w) => w.active === false);
  const canAdd = can('expenses.manageWallets') || can('expenses.personal');
  // Phase 4A: a child cannot manage (re-share / archive) an allowance wallet a guardian created.
  const isChild = env.ctx.getState().membership.roleId === 'child' || env.ctx.getState().membership.relationship === 'child';
  const mayManage = (w) => (w.scope === 'home' ? can('expenses.manageWallets')
    : (identity.uid === w.createdBy || (identity.uid === w.ownerUid && !isChild)) && can('expenses.personal'));
  const visText = (w) => (w.visibility === 'household' ? t('finance.visibility.household') : w.visibility === 'shared' ? t('finance.visibility.sharedN', { n: (w.sharedWith || []).length }) : t('finance.visibility.private'));
  const card = (w) => h('li', { class: ['fin-wallet', w.active === false && 'fin-wallet--archived'], dataset: { id: w.id } },
    h('span', { class: 'fin-wallet__icon', 'aria-hidden': 'true' }, TYPE_ICON[w.type] || '👛'),
    h('div', { class: 'fin-wallet__main' },
      h('p', { class: 'fin-wallet__name', dir: 'auto' }, w.name),
      h('p', { class: 'fin-wallet__sub' }, `${t(`finance.walletType.${w.type}`)} · ${visText(w)} · ${w.currency}`)),
    showTotals() || w.ownerUid === identity.uid ? h('span', { class: 'fin-wallet__balance', dir: 'ltr', id: `wl-bal-${w.id}` }, money(store.balance(w.id), w.currency)) : null,
    mayManage(w) ? h('div', { class: 'fin-actions' },
      w.active ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'edit', 'aria-label': t('finance.v622.editX', { name: w.name }), onClick: () => openWalletForm(env, w) }, t('rooms.edit')) : null,
      w.active ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'correct', 'aria-label': t('finance.v622.correctX', { name: w.name }), onClick: () => openCorrection(env, w) }, t('finance.v622.correct')) : null,
      w.active ? h('button', { type: 'button', class: 'btn btn--danger-ghost btn--sm', 'data-action': 'delete', 'aria-label': t('finance.v622.deleteX', { name: w.name }), onClick: () => openDeleteWallet(env, w) }, t('finance.v622.delete'))
        : h('button', { type: 'button', class: 'btn btn--secondary btn--sm', 'data-action': 'restore', 'aria-label': t('finance.v622.restoreX', { name: w.name }), onClick: async () => {
          const chk = store.restoreCheck(w.id); if (chk.blocked) { toast(t(chk.blocked), { tone: 'error' }); return; }
          try { await store.restoreWallet(w.id); toast(t('finance.toast.restored'), { tone: 'success' }); } catch (e) { toast(vmsg(e), { tone: 'error' }); }
        } }, t('finance.v622.restore'))) : null,
    showTotals() || w.ownerUid === identity.uid ? adjustments(env, w) : null);

  const needsSetup = scope === 'home' && !s.wallets.some((w) => w.active === true && w.role && w.visibility === 'household');
  return h('div', { class: 'fin-stack' },
    needsSetup ? cashBankSetup(env) : null,
    h('div', { class: 'fin-intro' }, h('p', null, t('finance.wallet.intro')),
      h('div', { class: 'fin-actions' },
        canAdd ? h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openWalletForm(env) }, t('finance.wallet.add')) : null,
        can('expenses.transfer') || can('expenses.personal') ? h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => openMovement(env, 'transfer') }, t('finance.transfer.title')) : null,
        can('expenses.transfer') || can('expenses.personal') ? h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => openMovement(env, 'funding') }, t('finance.funding.title')) : null)),
    active.length ? h('ul', { class: 'fin-wallets' }, active.map(card))
      : h('section', { class: 'card empty-state empty-state--compact' }, h('span', { class: 'empty-state__mark', 'aria-hidden': 'true' }, '👛'),
        h('h2', { class: 'empty-state__title' }, t('finance.wallet.noneTitle')), h('p', { class: 'empty-state__body' }, t('finance.wallet.noneBody'))),
    archived.length ? h('details', { class: 'form-section' }, h('summary', { class: 'form-section__summary' }, t('finance.wallet.archived', { n: archived.length })), h('ul', { class: 'fin-wallets' }, archived.map(card))) : null,
    can('expenses.import') && scope === 'home' ? h('section', { class: 'card fin-card' },
      h('h2', { class: 'card__title' }, t('finance.import.title')),
      h('p', { class: 'card__hint' }, t('finance.import.intro')),
      h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => openImport(env) }, t('finance.import.open'))) : null);
}
