/** Shared Life Savings display helpers. */
import { h } from '../../core/utils/dom.js';
import { t } from '../../core/i18n/i18n.js';
import { money } from '../expenses/finance-ui.js';
import { mgToPlain } from './quantity.js';
import { isMetal } from './savings-model.js';

export { money };
export const typeLabel = (type) => t(`savings.type.${type}`);
export const purityLabel = (type, p) => (type === 'gold' ? t('savings.karat', { k: p }) : t('savings.fineness', { f: p }));
export const grams = (mg) => t('savings.grams', { g: mgToPlain(mg) });
export function qtyText(asset, qty) { return isMetal(asset.type) ? grams(qty) : money(qty, asset.currency); }
export function freshPill(status, quote) {
  const key = !quote && status === 'native' ? null : quote && quote.source === 'manual' ? (status === 'stale' ? 'staleManual' : 'manual') : status;
  if (!key) return null;
  return h('span', { class: ['pill', `fresh--${key}`] }, t(`savings.fresh.${key}`));
}
export function ownerName(asset, directory, uid) {
  if (asset.scope === 'home') return t('savings.scope.home');
  if (asset.ownerUid === uid) return t('settings.you');
  return directory ? directory.nameOf(asset.ownerUid, t('family.formerMember')) : t('family.formerMember');
}
export const quoteTime = (q, locale) => (q ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(q.observedAt)) : '');
