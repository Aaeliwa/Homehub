/** Shared finance UI helpers: labels, money, wallet names, chips. Display only. */
import { h } from '../../core/utils/dom.js';
import { t, getLocale } from '../../core/i18n/i18n.js';
import { formatMoney } from './money.js';
import { categoryIcon, CATEGORY_IDS } from './finance-model.js';
import { presetOf } from './recurrence.js';

export const money = (minor, currency) => formatMoney(minor, currency, getLocale());
export const catLabel = (id) => t(CATEGORY_IDS.includes(id) ? `finance.category.${id}` : 'finance.category.other');
export const catChip = (e) => h('span', { class: 'fin-cat' }, h('span', { 'aria-hidden': 'true' }, categoryIcon(e.category)),
  h('span', null, e.category === 'other' && e.importedCategory ? e.importedCategory : catLabel(e.category)));
export const pmLabel = (pm) => t(pm ? `finance.payment.${pm}` : 'finance.payment.unknown');

/** Wallet label; unreadable / missing / no wallet are presented honestly. */
export function walletLabel(walletId, store, record) {
  if (!walletId) return record && record.source === 'import' ? t('finance.wallet.imported') : t('finance.wallet.none');
  const w = store.wallet(walletId);
  if (!w) return t('finance.wallet.restricted');
  return w.active === false ? t('finance.wallet.archivedLabel', { name: w.name }) : w.name;
}

export function recurrenceLabel(r) {
  const p = presetOf(r);
  if (p !== 'custom') return t(`finance.recurrence.${p}`);
  return t(`finance.recurrence.every.${r.unit}`, { n: r.interval });
}

export function amountInput(id, value = '') {
  const el = h('input', { id, name: id, class: 'input input--amount', inputmode: 'decimal', autocomplete: 'off', dir: 'ltr', value });
  return el;
}

export function field(label, control, { id, hint, error } = {}) {
  const err = h('p', { class: 'field__error', id: id ? `${id}-error` : null, hidden: !error }, error || '');
  return { root: h('div', { class: 'field' }, h('label', { class: 'field__label', for: id }, label), control, hint ? h('p', { class: 'field__hint' }, hint) : null, err),
    setError: (text) => { err.textContent = text || ''; err.hidden = !text; if (control.setAttribute) control.setAttribute('aria-invalid', text ? 'true' : 'false'); } };
}

export function select(id, options, value) {
  return h('select', { id, name: id, class: 'input' }, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
}

export const stat = (label, value, { tone, id } = {}) => h('div', { class: ['fin-stat', tone && `fin-stat--${tone}`], id },
  h('span', { class: 'fin-stat__label' }, label), h('span', { class: 'fin-stat__value', dir: 'ltr' }, value));
