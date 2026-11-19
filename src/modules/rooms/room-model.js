/**
 * Rooms domain model — PURE (no Firebase, no DOM). Unit-tested in Node.
 *
 * Stored values are stable machine identifiers (type 'kitchen', icon 'kitchen');
 * display text comes from i18n keys `rooms.type.<id>` / `rooms.icon.<id>`.
 * The Firestore rules (firestore.rules → validRoomContent) enforce the same limits.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { normalizeText } from '../../core/utils/validate.js';

export const ROOM_SCHEMA_VERSION = 1;
export const ROOM_LIMITS = Object.freeze({ name: 60, floor: 40, notes: 500, maxSortOrder: 1000000000 });

/** Icon id -> emoji. Unknown/missing ids fall back gracefully (see iconFor). */
export const ROOM_ICONS = Object.freeze({
  sofa: '🛋️', bed: '🛏️', kids: '🧸', kitchen: '🍳', bath: '🛁', dining: '🍽️', office: '💻',
  plant: '🪴', laundry: '🧺', storage: '📦', garage: '🚗', garden: '🌳', door: '🚪', lamp: '💡',
  stairs: '🪜', tv: '📺', gym: '🏋️', prayer: '🕌', home: '🏠',
});
export const ROOM_ICON_IDS = Object.freeze(Object.keys(ROOM_ICONS));
export const FALLBACK_ICON = 'home';

/** Room types (stored ids) with the icon suggested when the type is chosen. */
export const ROOM_TYPES = Object.freeze([
  { id: 'living_room', icon: 'sofa' },
  { id: 'bedroom', icon: 'bed' },
  { id: 'master_bedroom', icon: 'bed' },
  { id: 'kids_room', icon: 'kids' },
  { id: 'kitchen', icon: 'kitchen' },
  { id: 'bathroom', icon: 'bath' },
  { id: 'dining_room', icon: 'dining' },
  { id: 'office', icon: 'office' },
  { id: 'balcony', icon: 'plant' },
  { id: 'laundry', icon: 'laundry' },
  { id: 'storage', icon: 'storage' },
  { id: 'garage', icon: 'garage' },
  { id: 'garden', icon: 'garden' },
  { id: 'hallway', icon: 'lamp' },
  { id: 'entrance', icon: 'door' },
  { id: 'other', icon: 'home' },
]);
export const ROOM_TYPE_IDS = Object.freeze(ROOM_TYPES.map((t) => t.id));

/** Offered as one-tap starting points in the empty state (opens the form; never auto-writes). */
export const QUICK_TEMPLATES = Object.freeze(['living_room', 'kitchen', 'bedroom', 'bathroom']);

/** Floor/zone suggestions (i18n keys). The stored floor is the user's own free text. */
export const FLOOR_SUGGESTION_KEYS = Object.freeze(['ground', 'first', 'second', 'roof', 'basement']);

const ICON_ID = /^[a-z][a-z0-9_]{0,31}$/;

export function defaultIconForType(type) {
  return (ROOM_TYPES.find((t) => t.id === type) || ROOM_TYPES.at(-1)).icon;
}

/** Emoji for a room: its icon, else its type's icon, else the generic home icon. */
export function iconFor(room) {
  if (room && ROOM_ICONS[room.icon]) return ROOM_ICONS[room.icon];
  if (room && ROOM_TYPE_IDS.includes(room.type)) return ROOM_ICONS[defaultIconForType(room.type)];
  return ROOM_ICONS[FALLBACK_ICON];
}

function optionalText(value, max) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return { value: null };
  if (v.length > max) return { error: 'tooLong' };
  return { value: v };
}

/**
 * Validate + normalise user input for the editable room fields.
 * Returns { value: {name,type,icon,floor,notes}, errors: {field: i18nKey} }.
 */
export function validateRoomInput(input = {}) {
  const errors = {};
  const name = normalizeText(input.name);
  if (!name) errors.name = 'rooms.validation.nameRequired';
  else if (name.length > ROOM_LIMITS.name) errors.name = 'rooms.validation.nameTooLong';

  const type = ROOM_TYPE_IDS.includes(input.type) ? input.type : null;
  if (!type) errors.type = 'rooms.validation.typeInvalid';

  let icon = typeof input.icon === 'string' ? input.icon : '';
  if (!icon) icon = defaultIconForType(type || 'other');
  if (!ICON_ID.test(icon)) errors.icon = 'rooms.validation.iconInvalid';

  const floor = optionalText(input.floor, ROOM_LIMITS.floor);
  if (floor.error) errors.floor = 'rooms.validation.floorTooLong';
  const notes = optionalText(input.notes, ROOM_LIMITS.notes);
  if (notes.error) errors.notes = 'rooms.validation.notesTooLong';

  return { value: { name, type, icon, floor: floor.value ?? null, notes: notes.value ?? null }, errors };
}

function assertValid(input) {
  const { value, errors } = validateRoomInput(input);
  const keys = Object.keys(errors);
  if (keys.length) throw new AppError(ErrorCode.VALIDATION, { detail: keys.join(',') });
  return value;
}

export function isValidSortOrder(n) {
  return Number.isInteger(n) && n >= 0 && n <= ROOM_LIMITS.maxSortOrder;
}

/** Deterministic display order: sortOrder, then name (locale-aware), then id. */
export function compareRooms(a, b) {
  const sa = isValidSortOrder(a.sortOrder) ? a.sortOrder : ROOM_LIMITS.maxSortOrder;
  const sb = isValidSortOrder(b.sortOrder) ? b.sortOrder : ROOM_LIMITS.maxSortOrder;
  if (sa !== sb) return sa - sb;
  const byName = String(a.name || '').localeCompare(String(b.name || ''));
  if (byName) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortRooms(rooms) { return [...rooms].sort(compareRooms); }
export function activeRooms(rooms) { return sortRooms(rooms.filter((r) => r.active === true)); }
export function archivedRooms(rooms) { return sortRooms(rooms.filter((r) => r.active === false)); }

/** Module summary exposed to the Dashboard (the Dashboard never sees room internals). */
export function summarizeRooms(rooms) {
  let activeCount = 0;
  let archivedCount = 0;
  for (const r of rooms) { if (r.active === true) activeCount++; else if (r.active === false) archivedCount++; }
  return Object.freeze({ activeCount, archivedCount });
}

/** Next sortOrder: after every existing room (active or archived). */
export function nextSortOrder(rooms) {
  const max = rooms.reduce((m, r) => (isValidSortOrder(r.sortOrder) ? Math.max(m, r.sortOrder) : m), 0);
  if (max >= ROOM_LIMITS.maxSortOrder) throw new AppError(ErrorCode.VALIDATION, { detail: 'sortOrder overflow' });
  return max + 1;
}

/**
 * Move one active room up/down. Returns the minimal list of {id, sortOrder} changes that
 * renumbers the active rooms 1..n in the new order (also repairs duplicates left by
 * concurrent creates). Empty list = nothing to do.
 */
export function computeMove(rooms, roomId, direction) {
  const list = activeRooms(rooms);
  const i = list.findIndex((r) => r.id === roomId);
  const j = direction === 'up' ? i - 1 : direction === 'down' ? i + 1 : -1;
  if (i < 0 || j < 0 || j >= list.length) return [];
  [list[i], list[j]] = [list[j], list[i]];
  return list
    .map((r, index) => ({ id: r.id, sortOrder: index + 1, current: r.sortOrder }))
    .filter((c) => c.sortOrder !== c.current)
    .map(({ id, sortOrder }) => ({ id, sortOrder }));
}

// ---- write builders (shapes must match firestore.rules exactly) -----------------------

export function buildRoomCreate({ input, uid, sortOrder, now }) {
  const v = assertValid(input);
  if (!isValidSortOrder(sortOrder)) throw new AppError(ErrorCode.VALIDATION, { detail: 'sortOrder' });
  return {
    ...v,
    sortOrder,
    active: true,
    archivedAt: null,
    archivedBy: null,
    createdBy: uid,
    createdAt: now,
    updatedBy: uid,
    updatedAt: now,
    schemaVersion: ROOM_SCHEMA_VERSION,
  };
}

/**
 * Field-level patch containing ONLY fields that differ from `original`, so two people
 * editing different fields at the same time don't overwrite each other.
 * Returns null when nothing changed.
 */
export function buildRoomEdit({ original, input, uid, now }) {
  const v = assertValid(input);
  const patch = {};
  for (const key of ['name', 'type', 'icon', 'floor', 'notes']) {
    if ((original[key] ?? null) !== v[key]) patch[key] = v[key];
  }
  if (!Object.keys(patch).length) return null;
  return { ...patch, updatedBy: uid, updatedAt: now };
}

export function buildRoomArchive({ uid, now }) {
  return { active: false, archivedAt: now, archivedBy: uid, updatedBy: uid, updatedAt: now };
}

export function buildRoomRestore({ uid, now, sortOrder }) {
  if (!isValidSortOrder(sortOrder)) throw new AppError(ErrorCode.VALIDATION, { detail: 'sortOrder' });
  return { active: true, archivedAt: null, archivedBy: null, sortOrder, updatedBy: uid, updatedAt: now };
}

export function buildRoomOrder({ uid, now, sortOrder }) {
  return { sortOrder, updatedBy: uid, updatedAt: now };
}
