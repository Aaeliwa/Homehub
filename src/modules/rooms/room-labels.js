/** Display helpers for rooms: translated type/icon labels. Never stored. */
import { t } from '../../core/i18n/i18n.js';
import { ROOM_TYPE_IDS } from './room-model.js';

export const typeLabel = (type) => t(ROOM_TYPE_IDS.includes(type) ? `rooms.type.${type}` : 'rooms.type.other');
export const iconLabel = (iconId) => t(`rooms.icon.${iconId}`);
