/**
 * Fixed / recurring commitments. A commitment is a TEMPLATE (rent, internet, Microsoft 365
 * yearly…). It becomes an expense only when marked paid — one expense per due date.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { toast } from '../../ui/components/toast.js';
import { formatDateLong } from './calendar.js';
import { EXPENSE_CATEGORIES, PAYMENT_METHODS, categoryIcon } from './finance-model.js';
import { RECURRENCE_PRESETS, RECURRENCE_UNITS, presetOf, monthlyReserveMinor } from './recurrence.js';
import { money, catLabel, pmLabel, recurrenceLabel, amountInput, field, select } from './finance-ui.js';
import { minorToPlain } from './money.js';
import { formDialog, vmsg, val } from './dialogs.js';

const PRESET_IDS = [...Object.keys(RECURRENCE_PRESETS), 'custom'];

function walletChoices(env, action) {
  const { store, can, identity } = env;
  return store.activeWallets().filter((w) => (w.visibility === 'household' ? can(action) : (w.readers || []).includes(identity.uid) && can('expenses.personal')));
}

export function openCommitmentForm(env, existing, preset = {}) {
  const { store, today, ctx, can } = env;
  const v = existing ? { ...existing, amount: minorToPlain(existing.amountMinor) } : { category: 'subscriptions', recurrence: RECURRENCE_PRESETS.monthly, nextDueDate: today, ...preset };
  const wallets = walletChoices(env, 'expenses.manageCommitments');
  const name = field(t('finance.field.name'), h('input', { id: 'cm-name', class: 'input', maxlength: 60, dir: 'auto', value: v.name || '' }), { id: 'cm-name' });
  const amount = field(t('finance.field.amount'), amountInput('cm-amount', v.amount || ''), { id: 'cm-amount' });
  const cat = field(t('finance.field.category'), select('cm-category', EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: `${c.icon} ${catLabel(c.id)}` })), v.category), { id: 'cm-category' });
  const freq = field(t('finance.field.frequency'), select('cm-freq', PRESET_IDS.map((p) => ({ value: p, label: t(`finance.recurrence.${p}`) })), presetOf(v.recurrence)), { id: 'cm-freq' });
  const every = field(t('finance.field.every'), h('input', { id: 'cm-interval', type: 'number', min: 1, max: 36, class: 'input', value: v.recurrence.interval, inputmode: 'numeric' }), { id: 'cm-interval' });
  const unit = field(t('finance.field.unit'), select('cm-unit', RECURRENCE_UNITS.map((u) => ({ value: u, label: t(`finance.unit.${u}`) })), v.recurrence.unit), { id: 'cm-unit' });
  const syncFreq = () => { const custom = freq.root.querySelector('select').value === 'custom'; every.root.hidden = !custom; unit.root.hidden = !custom; };
  freq.root.querySelector('select').addEventListener('change', syncFreq); syncFreq();
  const due = field(t('finance.field.nextDue'), h('input', { id: 'cm-due', type: 'date', class: 'input', value: v.nextDueDate }), { id: 'cm-due' });
  const wallet = field(t('finance.field.preferredWallet'), select('cm-wallet', [...(can('expenses.manageCommitments') ? [{ value: '', label: t('finance.wallet.none') }] : []), ...wallets.map((w) => ({ value: w.id, label: w.name }))], v.walletId || ''), { id: 'cm-wallet' });
  const pm = field(t('finance.field.paymentMethod'), select('cm-pm', [{ value: '', label: t('finance.payment.unknown') }, ...PAYMENT_METHODS.map((p) => ({ value: p, label: pmLabel(p) }))], v.paymentMethod || ''), { id: 'cm-pm' });
  const notes = field(t('finance.field.notes'), h('textarea', { id: 'cm-notes', class: 'input input--area', rows: 2, maxlength: 1000, dir: 'auto' }), { id: 'cm-notes' });
  notes.root.querySelector('textarea').value = v.notes || '';
  return formDialog({
    title: existing ? t('finance.commitment.editTitle') : t('finance.commitment.addTitle'), id: 'commitment-form',
    submitLabel: existing ? t('common.save') : t('finance.commitment.add'), container: ctx.financeRoot,
    fields: [name.root, h('div', { class: 'form-grid form-grid--tight' }, amount.root, cat.root, freq.root, every.root, unit.root, due.root, wallet.root, pm.root), notes.root],
    onSubmit: async () => {
      const r = ctx.financeRoot; const f = val(r, '#cm-freq');
      const input = { name: val(r, '#cm-name'), amount: val(r, '#cm-amount'), category: val(r, '#cm-category'),
        recurrence: f === 'custom' ? { unit: val(r, '#cm-unit'), interval: Number(val(r, '#cm-interval')) } : RECURRENCE_PRESETS[f],
        nextDueDate: val(r, '#cm-due'), walletId: val(r, '#cm-wallet') || null, paymentMethod: val(r, '#cm-pm') || null, notes: val(r, '#cm-notes') };
      if (existing) { await store.editCommitment(existing.id, input); return 'finance.toast.saved'; }
      await store.createCommitment(input); return 'finance.toast.commitmentAdded';
    },
  });
}

function openPay(env, c) {
  const { store, today, ctx } = env;
  const wallets = walletChoices(env, 'expenses.create');
  const date = field(t('finance.field.paidOn'), h('input', { id: 'pay-date', type: 'date', class: 'input', value: today }), { id: 'pay-date' });
  const amount = field(t('finance.field.amount'), amountInput('pay-amount', minorToPlain(c.amountMinor)), { id: 'pay-amount' });
  const wallet = field(t('finance.field.wallet'), select('pay-wallet', [{ value: '', label: t('finance.wallet.none') }, ...wallets.map((w) => ({ value: w.id, label: w.name }))], c.walletId || ''), { id: 'pay-wallet' });
  return formDialog({
    title: t('finance.commitment.payTitle', { name: c.name }), id: 'pay-form', submitLabel: t('finance.commitment.markPaid'), container: ctx.financeRoot,
    fields: [h('p', { class: 'fin-callout' }, t('finance.commitment.payExplain', { due: formatDateLong(c.nextDueDate, env.locale) })), h('div', { class: 'form-grid form-grid--tight' }, date.root, amount.root, wallet.root)],
    onSubmit: async () => {
      const r = ctx.financeRoot;
      await store.payCommitment(c.id, { date: val(r, '#pay-date'), amount: val(r, '#pay-amount'), walletId: val(r, '#pay-wallet') || null });
      return 'finance.toast.paid';
    },
  });
}

export function renderCommitmentsTab(env) {
  const { store, today, locale, inScope, showTotals, can, identity } = env;
  const all = inScope(store.getSnapshot().commitments);
  const active = all.filter((c) => c.active === true).sort((a, b) => (a.nextDueDate < b.nextDueDate ? -1 : 1));
  const archived = all.filter((c) => c.active === false);
  const mayManage = (c) => { if (!c.walletId) return can('expenses.manageCommitments'); const w = store.wallet(c.walletId); return !!w && (w.visibility === 'household' ? can('expenses.manageCommitments') : (w.readers || []).includes(identity.uid) && can('expenses.personal')); };
  const mayPay = (c) => { if (!c.walletId) return can('expenses.create'); const w = store.wallet(c.walletId); return !!w && (w.visibility === 'household' ? can('expenses.create') : (w.readers || []).includes(identity.uid) && can('expenses.personal')); };
  const canAdd = can('expenses.manageCommitments') || (can('expenses.personal') && walletChoices(env, 'expenses.manageCommitments').length > 0);

  const row = (c) => h('li', { class: ['fin-commit', c.active === false && 'fin-commit--archived'], dataset: { id: c.id } },
    h('span', { class: 'fin-commit__icon', 'aria-hidden': 'true' }, categoryIcon(c.category)),
    h('div', { class: 'fin-commit__main' },
      h('p', { class: 'fin-commit__name', dir: 'auto' }, c.name),
      h('p', { class: 'fin-commit__sub' }, `${recurrenceLabel(c.recurrence)} · ${t('finance.commitment.nextDue', { date: formatDateLong(c.nextDueDate, locale) })}`),
      showTotals() && !(c.recurrence.unit === 'month' && c.recurrence.interval === 1) ? h('p', { class: 'field__hint' }, t('finance.commitment.reserve', { amount: money(monthlyReserveMinor(c.amountMinor, c.recurrence), c.currency) })) : null,
      c.nextDueDate < today && c.active ? h('span', { class: 'pill pill--warn' }, t('finance.upcoming.overdue')) : null),
    h('div', { class: 'fin-commit__side' },
      showTotals() ? h('span', { class: 'fin-commit__amount', dir: 'ltr' }, money(c.amountMinor, c.currency)) : null,
      h('div', { class: 'fin-actions' },
        c.active && mayPay(c) ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', onClick: () => openPay(env, c) }, t('finance.commitment.markPaid')) : null,
        c.active && mayManage(c) ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onClick: () => openCommitmentForm(env, c) }, t('rooms.edit')) : null,
        mayManage(c) ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm', onClick: async () => {
          if (c.active) {
            const ok = await confirmDialog({ title: t('finance.commitment.archiveTitle', { name: c.name }), message: t('finance.commitment.archiveBody'), confirmLabel: t('finance.archive'), container: env.ctx.financeRoot });
            if (!ok) return;
          }
          try { await (c.active ? store.archiveCommitment(c.id) : store.restoreCommitment(c.id)); toast(t(c.active ? 'finance.toast.archived' : 'finance.toast.restored'), { tone: 'success' }); }
          catch (e) { toast(vmsg(e), { tone: 'error' }); }
        } }, c.active ? t('finance.archive') : t('rooms.restore')) : null)));

  return h('div', { class: 'fin-stack' },
    h('div', { class: 'fin-intro' }, h('p', null, t('finance.commitment.intro')),
      canAdd ? h('button', { type: 'button', class: 'btn btn--primary', onClick: () => openCommitmentForm(env) }, t('finance.commitment.add')) : null),
    canAdd && !active.length ? h('div', { class: 'quick-rooms' }, [['rent', 'monthly'], ['utilities', 'monthly'], ['subscriptions', 'annual'], ['insurance', 'annual']].map(([cat, p]) =>
      h('button', { type: 'button', class: 'chip-btn quick-rooms__btn', onClick: () => openCommitmentForm(env, null, { category: cat, recurrence: RECURRENCE_PRESETS[p] }) },
        `${categoryIcon(cat)} ${catLabel(cat)} · ${t(`finance.recurrence.${p}`)}`))) : null,
    active.length ? h('ul', { class: 'fin-commits' }, active.map(row))
      : h('section', { class: 'card empty-state empty-state--compact' }, h('h2', { class: 'empty-state__title' }, t('finance.commitment.none')), h('p', { class: 'empty-state__body' }, t('finance.commitment.noneBody'))),
    archived.length ? h('details', { class: 'form-section' }, h('summary', { class: 'form-section__summary' }, t('finance.commitment.archived', { n: archived.length })), h('ul', { class: 'fin-commits' }, archived.map(row))) : null);
}
