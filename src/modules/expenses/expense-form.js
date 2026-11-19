/**
 * Expense entry. Quick add = Amount + Category + Note + Wallet → Add. "More details" opens the full
 * dialog (wallet, date, merchant, paid-by, cycle). V6.2.1: Wallet is the ONLY source (no payment method). Defaults are shown, never
 * hidden: the chosen wallet/date are always visible before saving.
 */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { openDialog, confirmDialog } from '../../ui/components/dialog.js';
import { banner, errorText, setBusy } from '../../ui/components/common.js';
import { toast } from '../../ui/components/toast.js';
import { EXPENSE_CATEGORIES, validateExpenseInput } from './finance-model.js';
import { sourceOptions, currentSource, editPaymentMethod } from './wallet-choice.js';
import { minorToPlain } from './money.js';
import { cycleFor } from './ledger.js';
import { amountInput, field, select, catLabel, walletLabel } from './finance-ui.js';

const vmsg = (err) => (err && err.detail && String(err.detail).startsWith('finance.') ? t(err.detail.split(',')[0]) : errorText(err));

/** Wallets the member may record into (active, and writable per their permissions). */
export function writableWallets(store, can, uid) {
  return store.activeWallets().filter((w) => (w.visibility === 'household' ? can('expenses.create') : (w.readers || []).includes(uid) && can('expenses.personal')));
}

export function defaultWallet(store, wallets, today, uid) {
  const withCycle = wallets.find((w) => store.cycleFor(w.id, today));
  // Phase 4A fix: members without household wallets (e.g. a child) default to their OWN
  // personal wallet, so Quick add works for them instead of silently doing nothing.
  return withCycle || wallets.find((w) => w.type === 'cash' && w.visibility === 'household')
    || wallets.find((w) => w.scope === 'personal' && w.ownerUid === uid) || null;
}

/** V6.2.1: the Wallet choices (Cash / Bank, or own wallets) for this member and scope. */
export function sourcesFor(store, ctx, scope = 'home') {
  const { permissions, identity } = ctx.getState();
  return sourceOptions(store.getSnapshot().wallets, { uid: identity.uid, canHousehold: permissions.can('expenses.create'), canPersonal: permissions.can('expenses.personal'), scope });
}
const optLabel = (o) => (o.slot === 'cash' ? `💵 ${t('finance.v62.cash')}` : o.slot === 'bank' ? `🏦 ${t('finance.v62.bank')}` : o.wallet.name);
/** No silent default: an unconfigured source is said plainly. */
export const missingText = (src) => (src.kind === 'household' ? t('finance.v621.setupWallets') : t('finance.validation.walletRequired'));
/** <select> of wallet ids; `extra` = [{ value, label, disabled }] for special states of an edited record. */
export function walletSelect(id, src, value, extra = []) {
  return h('select', { id, name: id, class: 'input', 'aria-label': t('finance.field.wallet') },
    [...src.options.map((o) => ({ value: o.id, label: optLabel(o) })), ...extra].map((o) => h('option', { value: o.value, disabled: !!o.disabled, selected: String(o.value) === String(value ?? '') }, o.label)));
}

export function quickAdd({ store, ctx, today, scope = 'home' }) {
  const src = sourcesFor(store, ctx, scope);
  const amount = amountInput('qa-amount');
  amount.setAttribute('placeholder', t('finance.field.amount'));
  amount.setAttribute('aria-label', t('finance.field.amount'));
  const category = select('qa-category', EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: `${c.icon} ${catLabel(c.id)}` })), 'groceries');
  category.setAttribute('aria-label', t('finance.field.category'));
  const note = h('input', { id: 'qa-note', class: 'input', placeholder: t('finance.field.note'), 'aria-label': t('finance.field.note'), maxlength: 200, dir: 'auto' });
  const wallet = walletSelect('qa-wallet', src, src.options.length ? src.options[0].id : '');
  const err = h('p', { class: 'field__error', role: 'alert', hidden: true });
  const target = h('p', { class: 'qa__target', id: 'qa-target' }, src.missing.length && src.kind === 'household' ? missingText(src) : '');
  const add = h('button', { type: 'submit', class: 'btn btn--primary', disabled: !src.options.length }, t('finance.add'));
  const more = h('button', { type: 'button', class: 'link-like qa__more', onClick: () => openExpenseDialog({ store, ctx, today, scope, preset: { amount: amount.value, category: category.value, note: note.value, walletId: wallet.value } }) }, t('finance.moreDetails'));
  const form = h('form', {
    class: 'qa', novalidate: true, 'aria-label': t('finance.quick.title'),
    onSubmit: async (e) => {
      e.preventDefault();
      if (!wallet.value) { err.textContent = missingText(src); err.hidden = false; return; }
      const input = { amount: amount.value, category: category.value, note: note.value, date: today, walletId: wallet.value, paymentMethod: null };
      const { errors } = validateExpenseInput(input);
      if (errors.amount) { err.textContent = t(errors.amount); err.hidden = false; amount.focus(); return; }
      err.hidden = true;
      const restore = setBusy(add, t('common.saving'));
      try {
        await store.addExpense(input);
        toast(t('finance.toast.added'), { tone: 'success' });
        amount.value = ''; note.value = ''; amount.focus();
      } catch (ex) { err.textContent = vmsg(ex); err.hidden = false; }
      finally { restore(); }
    },
  }, h('div', { class: 'qa__row' }, amount, category, note, wallet, add), h('div', { class: 'qa__meta' }, target, more), err);
  return form;
}

/** Full add / edit dialog. The only source control is Wallet (no Payment Method). */
export function openExpenseDialog({ store, ctx, today, expense, preset = {}, scope }) {
  const { permissions, identity } = ctx.getState();
  const editing = Boolean(expense);
  const base = editing ? { ...expense } : null;
  const v = editing ? { ...expense, amount: minorToPlain(expense.amountMinor) } : { date: today, category: 'groceries', ...preset };
  // An edited record keeps the source list of its own audience (household vs personal).
  const src = sourcesFor(store, ctx, scope || (editing && expense.audience && expense.audience !== 'household' ? 'mine' : 'home'));
  const state = editing ? currentSource(expense, src.options, (id) => store.wallet(id)) : 'listed';
  const extra = state === 'other' ? [{ value: expense.walletId, label: walletLabel(expense.walletId, store, expense) }]
    : state === 'none' ? [{ value: '', label: t('finance.v621.noWalletOld') }]
    : state === 'unknown' ? [{ value: '__unknown__', label: t('finance.v621.unknownWallet'), disabled: true }] : [];
  const initial = state === 'unknown' ? '__unknown__' : editing ? (expense.walletId || '') : (v.walletId || (src.options[0] || {}).id || '');
  const amount = field(t('finance.field.amount'), amountInput('ex-amount', v.amount || ''), { id: 'ex-amount' });
  const cat = field(t('finance.field.category'), select('ex-category', EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: `${c.icon} ${catLabel(c.id)}` })), v.category), { id: 'ex-category' });
  const date = field(t('finance.field.date'), h('input', { id: 'ex-date', type: 'date', class: 'input', value: v.date }), { id: 'ex-date' });
  const wallet = field(t('finance.field.wallet'), walletSelect('ex-wallet', src, initial, extra), { id: 'ex-wallet',
    hint: state === 'unknown' ? t('finance.v621.unknownWalletHint') : !src.options.length ? missingText(src) : '' });
  const note = field(t('finance.field.note'), h('input', { id: 'ex-note', class: 'input', maxlength: 200, dir: 'auto', value: v.note || '' }), { id: 'ex-note' });
  const merchant = field(t('finance.field.merchant'), h('input', { id: 'ex-merchant', class: 'input', maxlength: 60, dir: 'auto', value: v.merchant || '' }), { id: 'ex-merchant' });
  const members = ctx.financeMembers || [];
  const paidBy = field(t('finance.field.paidBy'), select('ex-paidby', [{ value: '', label: t('finance.paidBy.unset') }, ...members.map((m) => ({ value: m.uid, label: m.displayName }))], v.paidBy || ''), { id: 'ex-paidby' });
  const cycleInfo = h('p', { class: 'field__hint', 'aria-live': 'polite' });
  const syncCycle = () => {
    const w = wallet.root.querySelector('select').value; const d = date.root.querySelector('input').value;
    const c = w ? cycleFor(store.getSnapshot().cycles, w, d) : null;
    cycleInfo.textContent = c ? t('finance.cycle.willCount', { start: c.startDate, end: c.endDate }) : '';
  };
  wallet.root.querySelector('select').addEventListener('change', syncCycle);
  date.root.querySelector('input').addEventListener('change', syncCycle);
  syncCycle();

  const messages = h('div', { class: 'gate__messages' });
  const submit = h('button', { type: 'submit', class: 'btn btn--primary', form: 'expense-form' }, editing ? t('common.save') : t('finance.add'));
  const cancel = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => dlg.close() }, t('common.cancel'));
  const footer = [cancel, submit];
  if (editing && permissions.can('expenses.delete') || (editing && expense.walletId && src.kind === 'personal' && src.options.some((o) => o.id === expense.walletId))) {
    footer.unshift(h('button', { type: 'button', class: 'btn btn--danger-ghost', onClick: async () => {
      dlg.close();
      const ok = await confirmDialog({ title: t('finance.void.title'), message: t('finance.void.body'), confirmLabel: t('finance.void.confirm'), container: ctx.financeRoot });
      if (!ok) return;
      try { await store.voidExpense(expense.id, null); toast(t('finance.toast.voided'), { tone: 'success' }); } catch (e) { toast(vmsg(e), { tone: 'error' }); }
    } }, t('finance.void.action')));
  }

  const form = h('form', {
    id: 'expense-form', class: 'room-form', novalidate: true,
    onSubmit: async (e) => {
      e.preventDefault();
      const input = {
        amount: amount.root.querySelector('input').value, category: cat.root.querySelector('select').value,
        date: date.root.querySelector('input').value, walletId: wallet.root.querySelector('select').value || null,
        paymentMethod: null, note: note.root.querySelector('input').value,
        merchant: merchant.root.querySelector('input').value, paidBy: paidBy.root.querySelector('select').value || null,
        budgetCycleId: 'auto',
      };
      // Explicit wallet states: unknown / deleted must be replaced; a NEW expense always needs a wallet.
      if (input.walletId === '__unknown__' || (!editing && !input.walletId)) { wallet.setError(state === 'unknown' ? t('finance.v621.unknownWalletHint') : missingText(src)); return; }
      wallet.setError('');
      if (editing) input.paymentMethod = editPaymentMethod(expense, input.walletId);   // older label kept unless the wallet changes
      const { errors } = validateExpenseInput({ ...input, budgetCycleId: null });
      amount.setError(errors.amount ? t(errors.amount) : '');
      date.setError(errors.date ? t(errors.date) : '');
      if (Object.keys(errors).length) return;
      const w = input.walletId; const c = w ? cycleFor(store.getSnapshot().cycles, w, input.date) : null;
      input.budgetCycleId = c ? c.id : null;
      const restore = setBusy(submit, t('common.saving'));
      try {
        if (editing) {
          const changed = await store.editExpense(expense.id, input, base);
          toast(t(changed ? 'finance.toast.saved' : 'rooms.toast.noChanges'), { tone: changed ? 'success' : 'info' });
        } else { await store.addExpense(input); toast(t('finance.toast.added'), { tone: 'success' }); }
        dlg.close();
      } catch (ex) { restore(); messages.replaceChildren(banner('error', vmsg(ex))); }
    },
  }, h('div', { class: 'form-grid form-grid--tight' }, amount.root, cat.root, date.root, wallet.root), cycleInfo,
  h('div', { class: 'form-grid form-grid--tight' }, paidBy.root, merchant.root), note.root, messages);

  const dlg = openDialog({ title: editing ? t('finance.editTitle') : t('finance.addTitle'), content: form, footer, container: ctx.financeRoot });
  return dlg;
}
