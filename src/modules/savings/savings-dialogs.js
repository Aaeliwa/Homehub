/** Life Savings dialogs. Every write goes through the scope-bound store; rules re-check it all. */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { CURRENCIES } from '../../config/app-config.js';
import { field, select, amountInput } from '../expenses/finance-ui.js';
import { formDialog, val } from '../expenses/dialogs.js';
import { ASSET_TYPES, PURITIES, DEFAULT_PURITY, isMetal, percentToBps, TYPE_ICONS } from './savings-model.js';
import { typeLabel, purityLabel, qtyText } from './savings-ui.js';
import { metalKey } from './valuation.js';

const checkboxList = (name, members, selected = []) => h('fieldset', { class: 'fin-members' },
  members.map((m) => h('label', { class: 'fin-check' }, h('input', { type: 'checkbox', name, value: m.uid, checked: selected.includes(m.uid) }), h('span', null, m.displayName))));

export function openAssetForm(env, existing) {
  const { store, ctx, can, identity, home, members, children, today } = env;
  const editing = Boolean(existing);
  let form = null;
  const r = () => form; // this dialog's own form (never a root-wide id lookup)
  const scopes = [...(can('savings.personal') ? ['personal'] : []), ...(can('savings.manageHousehold') ? ['home'] : [])];
  const v = existing || { type: 'cash', scope: scopes[0], visibility: 'private', zakatTreatment: 'included', currency: home.currency, purity: '21' };
  const type = field(t('savings.field.type'), select('sa-type', ASSET_TYPES.map((x) => ({ value: x, label: `${TYPE_ICONS[x]} ${typeLabel(x)}` })), v.type), { id: 'sa-type' });
  const name = field(t('savings.field.name'), h('input', { id: 'sa-name', class: 'input', maxlength: 60, dir: 'auto', value: v.name || '' }), { id: 'sa-name' });
  const scope = field(t('savings.field.ownership'), select('sa-scope', scopes.map((s) => ({ value: s, label: t(`savings.scope.${s}`) })), v.scope), { id: 'sa-scope' });
  // Owner: myself, or (as an explicit guardian) one of my children.
  const ownerOpts = [{ value: identity.uid, label: t('settings.you') }, ...children.map((c) => ({ value: c.uid, label: c.displayName }))];
  const owner = field(t('savings.field.owner'), select('sa-owner', ownerOpts, v.ownerUid || identity.uid), { id: 'sa-owner', hint: t('savings.ownerHint') });
  const vis = field(t('savings.field.visibility'), select('sa-vis', ['private', 'shared'].map((x) => ({ value: x, label: t(`finance.visibility.${x}`) })), v.visibility === 'household' ? 'private' : v.visibility), { id: 'sa-vis' });
  const share = h('div', { id: 'sa-share' });
  const currency = field(t('settings.currency'), select('sa-currency', [...new Set([v.currency || home.currency, ...CURRENCIES])].map((c) => ({ value: c, label: c })), v.currency || home.currency), { id: 'sa-currency' });
  const purity = field(t('savings.field.purity'), select('sa-purity', [], v.purity), { id: 'sa-purity' });
  const institution = field(t('savings.field.institution'), h('input', { id: 'sa-inst', class: 'input', maxlength: 60, dir: 'auto', value: v.institution || '' }), { id: 'sa-inst', hint: t('savings.institutionHint') });
  const opening = field(t('savings.field.opening'), amountInput('sa-opening'), { id: 'sa-opening' });
  const zakat = field(t('savings.field.zakat'), select('sa-zakat', ['included', 'excluded'].map((x) => ({ value: x, label: t(`savings.zakatTreatment.${x}`) })), v.zakatTreatment), { id: 'sa-zakat', hint: t('savings.zakatTreatmentHint') });
  const alloc = h('fieldset', { class: 'fin-members', id: 'sa-alloc' }, h('legend', { class: 'field__label' }, t('savings.allocation.label')),
    h('p', { class: 'field__hint' }, t('savings.allocation.hint')),
    // Allocation candidates include ME (members excludes the current user).
    [{ uid: identity.uid, displayName: t('settings.you') }, ...members].map((m) => {
      const cur = (v.allocations || []).find((a) => a.uid === m.uid);
      return h('label', { class: 'alloc-row' }, h('span', null, m.displayName),
        h('input', { class: 'input input--sm', name: 'sa-alloc', 'data-uid': m.uid, inputmode: 'decimal', dir: 'ltr', placeholder: '0', value: cur ? String(cur.bps / 100) : '', 'aria-label': t('savings.allocation.percentFor', { name: m.displayName }) }), h('span', null, '%'));
    }));
  const notes = field(t('finance.field.notes'), h('textarea', { id: 'sa-notes', class: 'input input--area', rows: 2, maxlength: 1000, dir: 'auto' }), { id: 'sa-notes' });
  notes.root.querySelector('textarea').value = v.notes || '';

  let lastOwner = null;
  function sync() {
    const root = r(); if (!root || !root.querySelector('#sa-type')) return;
    const ty = val(root, '#sa-type'); const sc = val(root, '#sa-scope'); const metal = isMetal(ty);
    purity.root.hidden = !metal; currency.root.hidden = metal; institution.root.hidden = !['bank', 'investment', 'other'].includes(ty);
    const ps = root.querySelector('#sa-purity');
    if (metal) ps.replaceChildren(...PURITIES[ty].map((p) => h('option', { value: p, selected: p === (existing ? existing.purity : DEFAULT_PURITY[ty]) }, purityLabel(ty, p))));
    opening.root.querySelector('label').textContent = metal ? t('savings.field.openingGrams') : t('savings.field.opening');
    const personal = sc === 'personal';
    owner.root.hidden = !personal || editing || !children.length; vis.root.hidden = !personal;
    const ownerUid = editing ? existing.ownerUid : val(root, '#sa-owner');
    // Creating for a CHILD: default to shared with that child's guardians (incl. me), so the
    // guardian who creates it keeps access. The user can still adjust the list.
    const child = !editing && ownerUid !== identity.uid ? children.find((c) => c.uid === ownerUid) : null;
    if (child && lastOwner !== ownerUid) root.querySelector('#sa-vis').value = 'shared';
    const shared = personal && val(root, '#sa-vis') === 'shared';
    const candidates = [{ uid: identity.uid, displayName: t('settings.you') }, ...members].filter((m) => m.uid !== ownerUid);
    const preset = editing ? existing.sharedWith || [] : child ? [...new Set([identity.uid, ...(child.guardianUids || [])])] : [];
    // Fix (found by E2E S17): clearing with replaceChildren('') left an empty text node, so the
    // "already rendered" guard skipped the member list when switching to Shared while editing.
    if (!shared) share.replaceChildren();
    else if (lastOwner !== ownerUid || !share.querySelector('fieldset')) {
      share.replaceChildren(h('div', null, h('p', { class: 'field__label' }, t('finance.wallet.shareWith')), checkboxList('sa-share', candidates, preset)));
    }
    lastOwner = ownerUid;
    alloc.hidden = sc !== 'home' || val(root, '#sa-zakat') !== 'included';
  }

  const dlg = formDialog({
    title: editing ? t('savings.asset.editTitle') : t('savings.asset.addTitle'), id: 'asset-form',
    submitLabel: editing ? t('common.save') : t('savings.asset.add'), container: ctx.savingsRoot,
    fields: [h('div', { class: 'form-grid form-grid--tight' }, type.root, name.root, scope.root, owner.root, vis.root, currency.root, purity.root, institution.root),
      share, editing ? null : opening.root, zakat.root, alloc, notes.root, h('p', { class: 'field__hint' }, t('savings.privacyNote'))],
    onSubmit: async () => {
      const root = r();
      const allocations = [...root.querySelectorAll('input[name="sa-alloc"]')].filter((x) => x.value.trim()).map((x) => ({ uid: x.dataset.uid, bps: percentToBps(x.value) || -1 }));
      const input = { name: val(root, '#sa-name'), type: val(root, '#sa-type'), scope: val(root, '#sa-scope'),
        ownerUid: editing ? existing.ownerUid : val(root, '#sa-owner'), visibility: val(root, '#sa-vis'),
        sharedWith: [...root.querySelectorAll('input[name="sa-share"]:checked')].map((x) => x.value),
        currency: val(root, '#sa-currency'), purity: val(root, '#sa-purity'), institution: val(root, '#sa-inst'),
        notes: val(root, '#sa-notes'), zakatTreatment: val(root, '#sa-zakat'), allocations, opening: editing ? null : val(root, '#sa-opening') };
      const memberUids = [...members.map((m) => m.uid), identity.uid, ...children.map((c) => c.uid)];
      if (editing) { const ch = await store.updateAsset(existing.id, input, { memberUids }); return ch ? 'finance.toast.saved' : 'rooms.toast.noChanges'; }
      await store.createAsset(input, { memberUids, date: today });
      // Show the view where the new asset lives (a personal asset is not listed under "Home").
      if (env.showScope) env.showScope(input.scope === 'home' ? 'home' : 'mine');
      return 'savings.toast.assetAdded';
    },
  });
  form = type.root.closest('form');
  if (editing) { type.root.querySelector('select').disabled = true; scope.root.querySelector('select').disabled = true; currency.root.querySelector('select').disabled = true; }
  for (const id of ['#sa-type', '#sa-scope', '#sa-vis', '#sa-owner', '#sa-zakat']) { const el = r().querySelector(id); if (el) el.addEventListener('change', sync); }
  sync();
  return dlg;
}

/** contribution | withdrawal | adjustment */
export function openEventForm(env, asset, kind) {
  const { store, ctx, today } = env;
  const metal = isMetal(asset.type);
  const amt = field(metal ? t('savings.field.grams') : t('finance.field.amount'), amountInput('ev-amount'), { id: 'ev-amount', hint: kind === 'adjustment' ? t('savings.event.adjustHint') : t('savings.event.balanceNow', { qty: qtyText(asset, store.balance(asset.id)) }) });
  const date = field(t('finance.field.date'), h('input', { id: 'ev-date', type: 'date', class: 'input', value: today }), { id: 'ev-date' });
  const note = field(t('finance.field.note'), h('input', { id: 'ev-note', class: 'input', maxlength: 200, dir: 'auto' }), { id: 'ev-note' });
  return formDialog({ title: t(`savings.event.${kind}Title`, { name: asset.name }), id: 'event-form', submitLabel: t(`savings.event.${kind}`), container: ctx.savingsRoot,
    fields: [h('div', { class: 'form-grid form-grid--tight' }, amt.root, date.root), note.root],
    onSubmit: async () => { const root = amt.root.closest('form'); await store.addEvent(asset.id, { type: kind, amount: val(root, '#ev-amount'), date: val(root, '#ev-date'), note: val(root, '#ev-note') }); return 'savings.toast.recorded'; } });
}

export function openTransfer(env, from) {
  const { store, ctx, today } = env;
  const targets = store.getSnapshot().assets.filter((a) => a.active && a.id !== from.id);
  if (!targets.length) return null;
  const to = field(t('finance.transfer.to'), select('tr-to', targets.map((a) => ({ value: a.id, label: `${TYPE_ICONS[a.type]} ${a.name}` })), targets[0].id), { id: 'tr-to' });
  const amt = field(isMetal(from.type) ? t('savings.field.gramsOut') : t('savings.field.amountOut'), amountInput('tr-amount'), { id: 'tr-amount' });
  const inAmt = field(t('savings.field.amountIn'), amountInput('tr-in'), { id: 'tr-in', hint: t('savings.transfer.conversionHint') });
  const date = field(t('finance.field.date'), h('input', { id: 'tr-date', type: 'date', class: 'input', value: today }), { id: 'tr-date' });
  const sync = () => {
    const dest = store.asset(to.root.querySelector('select').value);
    const same = dest && !isMetal(from.type) && !isMetal(dest.type) && dest.currency === from.currency;
    inAmt.root.hidden = same;
    inAmt.root.querySelector('label').textContent = dest && isMetal(dest.type) ? t('savings.field.gramsIn') : t('savings.field.amountIn');
  };
  const dlg = formDialog({ title: t('savings.transfer.title', { name: from.name }), id: 'transfer-form', submitLabel: t('finance.transfer.submit'), container: ctx.savingsRoot,
    fields: [h('p', { class: 'fin-callout' }, t('savings.transfer.explain')), h('div', { class: 'form-grid form-grid--tight' }, to.root, amt.root, inAmt.root, date.root)],
    onSubmit: async () => { const root = to.root.closest('form'); await store.transfer({ fromId: from.id, toId: val(root, '#tr-to'), amount: val(root, '#tr-amount'), inAmount: val(root, '#tr-in'), date: val(root, '#tr-date') }); return 'savings.toast.transferred'; } });
  to.root.querySelector('select').addEventListener('change', sync); sync();
  return dlg;
}

/** Wallet ↔ savings: direction 'in' (wallet → asset) or 'out' (asset → wallet). */
export function openWalletTransfer(env, asset, direction, wallets) {
  const { store, ctx, today } = env;
  const usable = wallets.filter((w) => isMetal(asset.type) || w.currency === asset.currency);
  if (!usable.length) return null;
  const wallet = field(t('finance.field.wallet'), select('wt-wallet', usable.map((w) => ({ value: w.id, label: `${w.name} (${w.currency})` })), usable[0].id), { id: 'wt-wallet' });
  const amt = field(t('finance.field.amount'), amountInput('wt-amount'), { id: 'wt-amount' });
  const grams = field(t('savings.field.gramsIn'), amountInput('wt-grams'), { id: 'wt-grams' });
  grams.root.hidden = !isMetal(asset.type);
  const date = field(t('finance.field.date'), h('input', { id: 'wt-date', type: 'date', class: 'input', value: today }), { id: 'wt-date' });
  return formDialog({ title: t(direction === 'in' ? 'savings.wallet.inTitle' : 'savings.wallet.outTitle', { name: asset.name }), id: 'wallet-transfer-form', submitLabel: t('finance.transfer.submit'), container: ctx.savingsRoot,
    fields: [h('p', { class: 'fin-callout' }, t(isMetal(asset.type) ? 'savings.wallet.buyExplain' : 'savings.wallet.explain')), h('div', { class: 'form-grid form-grid--tight' }, wallet.root, amt.root, grams.root, date.root)],
    onSubmit: async () => {
      const root = wallet.root.closest('form'); const w = usable.find((x) => x.id === val(root, '#wt-wallet'));
      await store.walletTransfer({ wallet: w, assetId: asset.id, direction, amount: val(root, '#wt-amount'), inAmount: val(root, '#wt-grams'), date: val(root, '#wt-date') });
      return 'savings.toast.transferred';
    } });
}

export function openPriceForm(env, presetKey) {
  const { store, ctx, home } = env;
  const keys = [...['24', '22', '21', '18'].map((p) => metalKey('gold', p)), ...['999', '925'].map((p) => metalKey('silver', p)), ...CURRENCIES.filter((c) => c !== home.currency)];
  const key = field(t('savings.price.item'), select('pr-key', keys.map((k) => ({ value: k, label: t(`savings.priceKey.${k.includes('-') ? k : 'fx'}`, { c: k }) })), presetKey || 'gold-21'), { id: 'pr-key' });
  const price = field(t('savings.price.value', { currency: home.currency }), amountInput('pr-price'), { id: 'pr-price', hint: t('savings.price.hint') });
  const note = field(t('savings.price.source'), h('input', { id: 'pr-note', class: 'input', maxlength: 200, dir: 'auto', placeholder: t('savings.price.sourcePlaceholder') }), { id: 'pr-note' });
  return formDialog({ title: t('savings.price.title'), id: 'price-form', submitLabel: t('common.save'), container: ctx.savingsRoot,
    fields: [h('p', { class: 'fin-callout' }, t('savings.price.manualExplain')), key.root, price.root, note.root],
    onSubmit: async () => {
      const root = key.root.closest('form'); const k = val(root, '#pr-key');
      await store.addQuote({ kind: k.includes('-') ? 'metal' : 'fx', key: k, price: val(root, '#pr-price'), note: val(root, '#pr-note') });
      return 'savings.toast.priceSaved';
    } });
}
