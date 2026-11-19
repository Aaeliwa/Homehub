/** Display helpers (translated labels). Never stored. */
import { t } from '../../core/i18n/i18n.js';
import { isCategory, DEVICE_STATUSES } from './device-model.js';

export const categoryLabel = (c) => t(isCategory(c) ? `devices.category.${c}` : 'devices.category.other');
export const subtypeLabel = (s) => (s ? t(`devices.subtype.${s}`) : '');
export const statusLabel = (s) => t(DEVICE_STATUSES.includes(s) ? `devices.status.${s}` : 'devices.status.operational');
export const iconLabel = (i) => t(`devices.icon.${i}`);

/**
 * Room label for a device, resolved from the shared rooms store:
 *   null → "Unassigned"; archived room → "Bedroom (Archived)"; missing → "Unknown room".
 */
export function roomLabel(roomId, getRoom) {
  if (!roomId) return t('devices.unassigned');
  const room = getRoom(roomId);
  if (!room) return t('devices.roomUnknown');
  return room.active === false ? t('devices.roomArchivedLabel', { name: room.name }) : room.name;
}

export function formatPrice(value, currency, locale) {
  if (value === null || value === undefined) return '';
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value} ${currency || ''}`.trim(); }
}

/** 'YYYY-MM-DD' → localised long date, computed in UTC so the day never shifts. */
export function formatCalendarDate(value, locale) {
  if (!value) return '';
  const [y, m, d] = value.split('-').map(Number);
  try { return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d))); }
  catch { return value; }
}
