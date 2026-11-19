/**
 * Devices & household assets — domain model. PURE (no Firebase, no DOM). Unit-tested.
 *
 * Stored values are stable machine ids (category 'air_conditioning', subtype 'split_ac',
 * status 'needs_attention', icon 'snowflake'). Labels come from i18n. firestore.rules
 * (deviceSubtypes / validDeviceContent) enforces the same taxonomy and limits; a static
 * test keeps the two in sync.
 *
 * Dates (purchaseDate, installationDate, warrantyExpiry) are calendar dates stored as
 * 'YYYY-MM-DD' strings — never Date/Timestamp — so they can't shift across time zones.
 */
import { AppError, ErrorCode } from '../../core/errors/app-error.js';
import { normalizeText, isCurrencyCode } from '../../core/utils/validate.js';

export const DEVICE_SCHEMA_VERSION = 1;
export const DEVICE_LIMITS = Object.freeze({
  name: 80, brand: 60, model: 60, serialNumber: 80, notes: 1000, maxPrice: 1000000000000,
});

/** Icon id -> emoji. Unknown ids fall back (iconFor). */
export const DEVICE_ICONS = Object.freeze({
  snowflake: '❄️', fridge: '🧊', laundry: '🧺', cooking: '🍳', coffee: '☕', water: '💧',
  shower: '🚿', tv: '📺', speaker: '🔊', computer: '💻', printer: '🖨️', router: '📡',
  vacuum: '🧹', light: '💡', plug: '🔌', battery: '🔋', solar: '☀️', fan: '🌀', heat: '🔥',
  camera: '📹', lock: '🔒', sofa: '🛋️', bed: '🛏️', tree: '🌳', tools: '🛠️', box: '📦',
  phone: '📱', faucet: '🚰', gear: '⚙️',
});
export const DEVICE_ICON_IDS = Object.freeze(Object.keys(DEVICE_ICONS));
export const FALLBACK_ICON = 'gear';

/**
 * Category -> { icon, subtypes }. Subtype ids are unique across categories. 'other' is
 * allowed as a subtype wherever a category has subtypes; subtype may also be null.
 */
export const DEVICE_CATEGORIES = Object.freeze({
  air_conditioning: { icon: 'snowflake', subtypes: ['split_ac', 'window_ac', 'portable_ac', 'central_ac', 'other'] },
  refrigeration: { icon: 'fridge', subtypes: ['refrigerator', 'freezer', 'water_dispenser', 'other'] },
  laundry: { icon: 'laundry', subtypes: ['washing_machine', 'dryer', 'washer_dryer', 'iron', 'other'] },
  kitchen_appliance: { icon: 'cooking', subtypes: ['oven', 'cooker', 'microwave', 'dishwasher', 'coffee_machine', 'blender', 'kettle', 'air_fryer', 'other'] },
  water_system: { icon: 'water', subtypes: ['water_heater', 'water_filter', 'water_pump', 'water_tank', 'other'] },
  audio_video: { icon: 'tv', subtypes: ['television', 'receiver', 'speaker', 'projector', 'other'] },
  computing: { icon: 'computer', subtypes: ['desktop_computer', 'laptop', 'tablet', 'printer', 'other'] },
  networking: { icon: 'router', subtypes: ['router', 'modem', 'access_point', 'network_switch', 'other'] },
  cleaning_equipment: { icon: 'vacuum', subtypes: ['vacuum_cleaner', 'robot_vacuum', 'steam_cleaner', 'other'] },
  lighting: { icon: 'light', subtypes: ['ceiling_light', 'lamp', 'outdoor_light', 'other'] },
  electrical: { icon: 'plug', subtypes: ['electrical_panel', 'ups', 'voltage_stabilizer', 'other'] },
  power: { icon: 'battery', subtypes: ['generator', 'solar_panel', 'inverter', 'battery_bank', 'other'] },
  heating: { icon: 'heat', subtypes: ['space_heater', 'other'] },
  ventilation: { icon: 'fan', subtypes: ['ceiling_fan', 'stand_fan', 'exhaust_fan', 'air_purifier', 'other'] },
  plumbing: { icon: 'faucet', subtypes: ['faucet', 'toilet', 'shower_unit', 'other'] },
  security: { icon: 'lock', subtypes: ['camera', 'alarm', 'smart_lock', 'intercom', 'other'] },
  furniture: { icon: 'sofa', subtypes: ['sofa', 'bed', 'wardrobe', 'table', 'other'] },
  outdoor: { icon: 'tree', subtypes: ['garden_equipment', 'pool_equipment', 'grill', 'other'] },
  other: { icon: 'gear', subtypes: [] },
});
export const DEVICE_CATEGORY_IDS = Object.freeze(Object.keys(DEVICE_CATEGORIES));

/** Subtypes whose icon is more specific than their category's. */
const SUBTYPE_ICONS = Object.freeze({
  coffee_machine: 'coffee', water_heater: 'shower', speaker: 'speaker', printer: 'printer',
  laptop: 'computer', tablet: 'phone', solar_panel: 'solar', camera: 'camera', bed: 'bed',
  shower_unit: 'shower', robot_vacuum: 'vacuum', microwave: 'cooking', freezer: 'fridge',
});

/** Display/sort priority: what needs a look comes first when sorting by status. */
export const DEVICE_STATUSES = Object.freeze(['operational', 'needs_attention', 'out_of_service', 'stored']);
const STATUS_RANK = Object.freeze({ needs_attention: 0, out_of_service: 1, operational: 2, stored: 3 });

/** Quick-add templates: prefill the form only — never written without Save. */
export const QUICK_TEMPLATES = Object.freeze([
  { category: 'air_conditioning', subtype: 'split_ac' },
  { category: 'refrigeration', subtype: 'refrigerator' },
  { category: 'laundry', subtype: 'washing_machine' },
  { category: 'audio_video', subtype: 'television' },
  { category: 'water_system', subtype: 'water_heater' },
  { category: 'networking', subtype: 'router' },
]);

export const SORT_MODES = Object.freeze(['name', 'room', 'category', 'status']);

const ICON_ID = /^[a-z][a-z0-9_]{0,31}$/;
const ROOM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isCategory = (c) => DEVICE_CATEGORY_IDS.includes(c);
export const subtypesFor = (category) => (isCategory(category) ? DEVICE_CATEGORIES[category].subtypes : []);
export const isValidRoomId = (id) => typeof id === 'string' && ROOM_ID.test(id);

export function defaultIconFor(category, subtype) {
  if (subtype && SUBTYPE_ICONS[subtype]) return SUBTYPE_ICONS[subtype];
  return isCategory(category) ? DEVICE_CATEGORIES[category].icon : FALLBACK_ICON;
}

/** Emoji for a device: chosen icon → subtype/category icon → gear. */
export function iconFor(device) {
  if (device && DEVICE_ICONS[device.icon]) return DEVICE_ICONS[device.icon];
  return DEVICE_ICONS[defaultIconFor(device && device.category, device && device.subtype)] || DEVICE_ICONS[FALLBACK_ICON];
}

/** Strict calendar date 'YYYY-MM-DD' between 1900 and 2100 (Feb 30 is rejected). */
export function isCalendarDate(value) {
  const m = typeof value === 'string' && DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function optionalText(value, max, field, errors) {
  const v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!v) return null;
  if (v.length > max) errors[field] = `devices.validation.tooLong.${field}`;
  return v;
}
function optionalNotes(value, errors) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return null;
  if (v.length > DEVICE_LIMITS.notes) errors.notes = 'devices.validation.tooLong.notes';
  return v;
}
function optionalDate(value, field, errors) {
  if (value === null || value === undefined || value === '') return null;
  if (!isCalendarDate(value)) errors[field] = 'devices.validation.dateInvalid';
  return value;
}

/**
 * Parse a price from user input. '' / null → null (no price). 0 is a real price.
 * Returns { value } or { error }.
 */
export function parsePrice(raw) {
  if (raw === null || raw === undefined) return { value: null };
  const s = typeof raw === 'number' ? String(raw) : String(raw).trim().replace(/[,\s]/g, '');
  if (s === '') return { value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: 'devices.validation.priceInvalid' };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > DEVICE_LIMITS.maxPrice) return { error: 'devices.validation.priceInvalid' };
  return { value: n };
}

/**
 * Validate + normalise the editable fields. Room *assignability* (active room) is checked
 * separately by checkRoomAssignment because it needs the rooms store.
 */
export function validateDeviceInput(input = {}) {
  const errors = {};
  const name = normalizeText(input.name);
  if (!name) errors.name = 'devices.validation.nameRequired';
  else if (name.length > DEVICE_LIMITS.name) errors.name = 'devices.validation.tooLong.name';

  const category = isCategory(input.category) ? input.category : null;
  if (!category) errors.category = 'devices.validation.categoryInvalid';

  let subtype = input.subtype === '' || input.subtype === undefined ? null : input.subtype;
  if (subtype !== null && !(category && subtypesFor(category).includes(subtype))) errors.subtype = 'devices.validation.subtypeInvalid';

  const roomId = input.roomId === '' || input.roomId === undefined ? null : input.roomId;
  if (roomId !== null && !isValidRoomId(roomId)) errors.roomId = 'devices.validation.roomInvalid';

  const status = input.status === undefined || input.status === '' ? 'operational' : input.status;
  if (!DEVICE_STATUSES.includes(status)) errors.status = 'devices.validation.statusInvalid';

  let icon = typeof input.icon === 'string' && input.icon ? input.icon : defaultIconFor(category, subtype);
  if (!ICON_ID.test(icon)) errors.icon = 'devices.validation.iconInvalid';

  const brand = optionalText(input.brand, DEVICE_LIMITS.brand, 'brand', errors);
  const model = optionalText(input.model, DEVICE_LIMITS.model, 'model', errors);
  const serialNumber = optionalText(input.serialNumber, DEVICE_LIMITS.serialNumber, 'serialNumber', errors);
  const notes = optionalNotes(input.notes, errors);
  const purchaseDate = optionalDate(input.purchaseDate, 'purchaseDate', errors);
  const installationDate = optionalDate(input.installationDate, 'installationDate', errors);
  const warrantyExpiry = optionalDate(input.warrantyExpiry, 'warrantyExpiry', errors);

  const price = parsePrice(input.purchasePrice);
  if (price.error) errors.purchasePrice = price.error;
  const purchasePrice = price.error ? null : price.value;
  let currency = null;
  if (purchasePrice !== null) {
    currency = input.currency;
    if (!isCurrencyCode(currency)) errors.currency = 'devices.validation.currencyInvalid';
  }

  return {
    value: {
      name, category, subtype, roomId, status, icon, brand, model, serialNumber,
      purchaseDate, installationDate, purchasePrice, currency, warrantyExpiry, notes,
    },
    errors,
  };
}

export const EDITABLE_FIELDS = Object.freeze([
  'name', 'category', 'subtype', 'roomId', 'status', 'icon', 'brand', 'model', 'serialNumber',
  'purchaseDate', 'installationDate', 'purchasePrice', 'currency', 'warrantyExpiry', 'notes',
]);

function assertValid(input) {
  const { value, errors } = validateDeviceInput(input);
  const keys = Object.keys(errors);
  if (keys.length) throw new AppError(ErrorCode.VALIDATION, { detail: keys.join(',') });
  return value;
}

/**
 * Room assignment policy (mirrors firestore.rules):
 *  - null (Unassigned) is always allowed;
 *  - a NEW assignment (create, or roomId changed) must target an existing ACTIVE room;
 *  - an UNCHANGED reference stays valid even if that room was archived later.
 * `getRoom(id)` resolves from the shared rooms store (archived rooms included).
 */
export function checkRoomAssignment({ roomId, previousRoomId, getRoom }) {
  if (roomId === null) return null;
  if (previousRoomId !== undefined && roomId === previousRoomId) return null;
  const room = getRoom(roomId);
  if (!room) return 'devices.validation.roomNotFound';
  if (room.active !== true) return 'devices.validation.roomArchived';
  return null;
}

// ---- selectors (pure) ----------------------------------------------------------------

export function compareByName(a, b) {
  const n = String(a.name || '').localeCompare(String(b.name || ''));
  if (n) return n;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Deterministic sort. `roomOrder(id)` gives a room's display position (rooms store order);
 * unassigned devices sort after every room.
 */
export function sortDevices(devices, mode = 'name', { roomOrder = () => Infinity, categoryLabel = (c) => c } = {}) {
  const list = [...devices];
  const by = {
    name: compareByName,
    room: (a, b) => {
      const ra = a.roomId ? roomOrder(a.roomId) : Infinity;
      const rb = b.roomId ? roomOrder(b.roomId) : Infinity;
      return ra === rb ? compareByName(a, b) : ra < rb ? -1 : 1;
    },
    category: (a, b) => String(categoryLabel(a.category)).localeCompare(String(categoryLabel(b.category))) || compareByName(a, b),
    status: (a, b) => ((STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)) || compareByName(a, b),
  }[SORT_MODES.includes(mode) ? mode : 'name'];
  return list.sort(by);
}

export const activeDevices = (devices) => devices.filter((d) => d.active === true);
export const archivedDevices = (devices) => devices.filter((d) => d.active === false);

function groupBy(devices, key) {
  const map = new Map();
  for (const d of devices) {
    const k = d[key] ?? null;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  return map;
}
export const devicesByRoom = (devices) => groupBy(devices, 'roomId');
export const devicesByCategory = (devices) => groupBy(devices, 'category');
export const devicesByStatus = (devices) => groupBy(devices, 'status');

/** Case-insensitive search over name, brand, model and serial number. */
export function matchesQuery(device, query) {
  const q = normalizeText(query).toLowerCase();
  if (!q) return true;
  return ['name', 'brand', 'model', 'serialNumber'].some((f) => String(device[f] || '').toLowerCase().includes(q));
}

/**
 * Client-side filtering over the already-loaded collection.
 * filter = { view: 'active'|'archived', query, room: 'all'|'unassigned'|roomId, category: 'all'|id, status: 'all'|id }
 */
export function filterDevices(devices, filter = {}) {
  const { view = 'active', query = '', room = 'all', category = 'all', status = 'all' } = filter;
  return devices.filter((d) => (view === 'archived' ? d.active === false : d.active === true)
    && (room === 'all' || (room === 'unassigned' ? d.roomId == null : d.roomId === room))
    && (category === 'all' || d.category === category)
    && (status === 'all' || d.status === status)
    && matchesQuery(d, query));
}

/** Dashboard contract. */
export function summarizeDevices(devices) {
  let activeCount = 0; let needsAttentionCount = 0; let outOfServiceCount = 0; let archivedCount = 0;
  for (const d of devices) {
    if (d.active === true) {
      activeCount++;
      if (d.status === 'needs_attention') needsAttentionCount++;
      if (d.status === 'out_of_service') outOfServiceCount++;
    } else if (d.active === false) archivedCount++;
  }
  return Object.freeze({ activeCount, needsAttentionCount, outOfServiceCount, archivedCount });
}

// ---- write builders (shapes match firestore.rules exactly) ----------------------------

export function buildDeviceCreate({ input, uid, now }) {
  const v = assertValid(input);
  return {
    ...v,
    active: true,
    archivedAt: null,
    archivedBy: null,
    createdBy: uid,
    createdAt: now,
    updatedBy: uid,
    updatedAt: now,
    schemaVersion: DEVICE_SCHEMA_VERSION,
  };
}

/** Only fields that differ from `original` (what the user saw). null = nothing changed. */
export function buildDeviceEdit({ original, input, uid, now }) {
  const v = assertValid(input);
  const patch = {};
  for (const key of EDITABLE_FIELDS) {
    if ((original[key] ?? null) !== v[key]) patch[key] = v[key];
  }
  if (!Object.keys(patch).length) return null;
  return { ...patch, updatedBy: uid, updatedAt: now };
}

export const buildDeviceArchive = ({ uid, now }) => ({ active: false, archivedAt: now, archivedBy: uid, updatedBy: uid, updatedAt: now });
export const buildDeviceRestore = ({ uid, now }) => ({ active: true, archivedAt: null, archivedBy: null, updatedBy: uid, updatedAt: now });
