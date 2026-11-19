/**
 * AI routine import (Phase 5.4c) — PURE. Manual workflow: the app builds a prompt from what the user
 * TICKS, the user pastes it into any AI tool, then pastes the JSON back. That JSON is UNTRUSTED:
 *   - JSON.parse only (no eval / Function / HTML insertion); size, depth and count limits;
 *   - __proto__ / constructor / prototype keys rejected anywhere; unknown keys rejected per item;
 *   - ids, home/member ids, creators, paths, dates are not in the whitelist → rejected;
 *   - URLs and control characters in text rejected;
 *   - rooms/devices resolved ONLY against the active household's own records.
 * Contract v1 is the standalone "personal-routine" package (accepted) extended with templates[].
 */
import { ROOM_TYPE_MAP, DEVICE_SUBTYPE_MAP } from './cleaning-integration.js';
import { validateTemplate, templateCreateDoc } from './cleaning-custom.js';

export const IMPORT_LIMITS = Object.freeze({ bytes: 100 * 1024, depth: 6, tasks: 100, templates: 50, title: 120, note: 300, minutes: [1, 240] });
export const PACKAGE_TYPES = Object.freeze(['homehub-cleaning-plan', 'personal-routine']);
export const AREA_TYPES = Object.freeze(['bedroom', 'kitchen', 'bathroom', 'living', 'entrance', 'balcony']);
export const DEVICE_TYPES = Object.freeze(['ac', 'dishwasher', 'fridge', 'airfryer', 'vacuum', 'microwave', 'stove']);
export const TRIGGER_TYPES_SUPPORTED = Object.freeze(['periodic', 'afterUse', 'afterCycle', 'inSeason', 'seasonStart', 'seasonEnd']);
export const TRIGGER_TYPES_UNSUPPORTED = Object.freeze(['conditionBased', 'manual']);
const TASK_KEYS = ['title', 'titleEn', 'areaType', 'deviceType', 'triggerType', 'frequency', 'estimatedMinutes', 'priority', 'note', 'reason'];
const TEMPLATE_KEYS = [...TASK_KEYS, 'pack'];
const TOP_KEYS = ['schemaVersion', 'packageType', 'metadata', 'problems', 'tasks', 'templates'];
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const URL_RE = /(https?:\/\/|www\.|javascript:|data:)/i;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Inverse maps: standalone type → HomeHub room types / device subtypes; HomeHub names also accepted. */
const roomTypesFor = (t) => (AREA_TYPES.includes(t) ? Object.keys(ROOM_TYPE_MAP).filter((k) => ROOM_TYPE_MAP[k] === t) : Object.keys(ROOM_TYPE_MAP).includes(t) || t ? [t] : []);
const deviceTypesFor = (t) => (DEVICE_TYPES.includes(t) ? Object.keys(DEVICE_SUBTYPE_MAP).filter((k) => DEVICE_SUBTYPE_MAP[k] === t) : [t]);

/** Step 1: parse + structural checks. Returns { ok, errors[], data }. */
export function parsePlan(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['empty'] };
  if (new TextEncoder().encode(text).length > IMPORT_LIMITS.bytes) return { ok: false, errors: ['tooLarge'] };
  let data;
  try { data = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { return { ok: false, errors: ['notJson'] }; }
  const errs = [];
  const walk = (v, depth) => {
    if (depth > IMPORT_LIMITS.depth) { errs.push('tooDeep'); return; }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (BAD_KEYS.has(k)) errs.push('dangerousKey'); else walk(v[k], depth + 1); }
  };
  walk(data, 0);
  if (Object.prototype.hasOwnProperty.call(data || {}, '__proto__')) errs.push('dangerousKey');
  if (errs.length) return { ok: false, errors: [...new Set(errs)] };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: ['notObject'] };
  const unknown = Object.keys(data).filter((k) => !TOP_KEYS.includes(k));
  if (unknown.length) errs.push('unknownTopKey');
  if (data.schemaVersion !== 1) errs.push(data.schemaVersion == null ? 'missingSchemaVersion' : 'unsupportedSchemaVersion');
  if (!PACKAGE_TYPES.includes(data.packageType)) errs.push('wrongPackageType');
  const tasks = data.tasks == null ? [] : data.tasks; const templates = data.templates == null ? [] : data.templates;
  if (!Array.isArray(tasks) || !Array.isArray(templates)) errs.push('notArray');
  else {
    if (tasks.length > IMPORT_LIMITS.tasks) errs.push('tooManyTasks');
    if (templates.length > IMPORT_LIMITS.templates) errs.push('tooManyTemplates');
    if (!tasks.length && !templates.length) errs.push('noItems');
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true, errors: [], data: { tasks, templates, name: data.metadata && typeof data.metadata.name === 'string' ? data.metadata.name.slice(0, 80) : '' } };
}

const textOk = (v, max, required = false) => (v == null || v === '' ? !required : typeof v === 'string' && v.trim().length > 0 && v.length <= max && !URL_RE.test(v) && !CTRL_RE.test(v));
/** Map a package frequency onto HomeHub recurrence (standalone semantics; months capped at 12). */
export function mapFrequency(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: 'frequency' };
  const extra = Object.keys(f).filter((k) => !['type', 'unit', 'n', 'weekday', 'day'].includes(k)); if (extra.length) return { error: 'frequency' };
  if (f.type === 'daily') return { recurrence: { kind: 'after', unit: 'day', interval: 1 } };
  if (f.type === 'interval') {
    const n = f.n;
    if (f.unit === 'day' && Number.isInteger(n) && n >= 1 && n <= 365) return { recurrence: { kind: 'after', unit: 'day', interval: n } };
    if (f.unit === 'month' && Number.isInteger(n) && n >= 1 && n <= 12) return { recurrence: { kind: 'after', unit: 'month', interval: n } };
    return { error: 'frequencyRange' };
  }
  if (f.type === 'weekly') return Number.isInteger(f.weekday) && f.weekday >= 0 && f.weekday <= 6 ? { recurrence: { kind: 'weeks', interval: 1, weekdays: [f.weekday] } } : { error: 'frequencyRange' };
  if (f.type === 'monthly') return Number.isInteger(f.day) && f.day >= 1 && f.day <= 31 ? { recurrence: { kind: 'months', interval: 1, dayOfMonth: f.day } } : { error: 'frequencyRange' };
  return { error: 'frequency' };
}

/** Step 2: validate + normalise ONE item. Returns { reasons[], norm }. */
export function normalizeItem(raw, kind) {
  const reasons = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reasons: ['notObject'] };
  const allowed = kind === 'template' ? TEMPLATE_KEYS : TASK_KEYS;
  const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (unknown.length) reasons.push(`unknownField:${unknown.slice(0, 3).join(',')}`);
  if (!textOk(raw.title, IMPORT_LIMITS.title, true)) reasons.push('title');
  if (!textOk(raw.titleEn, IMPORT_LIMITS.title)) reasons.push('titleEn');
  if (!textOk(raw.note, IMPORT_LIMITS.note) || !textOk(raw.reason, IMPORT_LIMITS.note)) reasons.push('note');
  if (kind === 'template' && !textOk(raw.pack, 60)) reasons.push('pack');
  const area = typeof raw.areaType === 'string' && raw.areaType.trim() ? raw.areaType.trim() : null;
  const device = typeof raw.deviceType === 'string' && raw.deviceType.trim() ? raw.deviceType.trim() : null;
  if (!!area === !!device) reasons.push('roomOrDevice');
  if (area && !AREA_TYPES.includes(area) && !Object.keys(ROOM_TYPE_MAP).includes(area)) reasons.push('unknownRoomType');
  if (device && !DEVICE_TYPES.includes(device) && !Object.keys(DEVICE_SUBTYPE_MAP).includes(device)) reasons.push('unknownDeviceType');
  const trig = device ? (raw.triggerType == null ? 'periodic' : raw.triggerType) : 'periodic';
  if (!device && raw.triggerType != null && raw.triggerType !== 'periodic') reasons.push('triggerNeedsDevice');
  if (TRIGGER_TYPES_UNSUPPORTED.includes(trig)) reasons.push(`unsupportedTrigger:${trig}`);
  else if (!TRIGGER_TYPES_SUPPORTED.includes(trig)) reasons.push('trigger');
  const m = raw.estimatedMinutes;
  if (!Number.isInteger(m) || m < IMPORT_LIMITS.minutes[0] || m > IMPORT_LIMITS.minutes[1]) reasons.push('minutes');
  if (raw.priority != null && !['low', 'normal', 'high'].includes(raw.priority)) reasons.push('priority');
  let recurrence = null; let trigger = null;
  if (trig === 'afterUse' || trig === 'afterCycle') { recurrence = { kind: 'onUse' }; trigger = { kind: 'afterUse' }; if (raw.frequency != null) reasons.push('frequencyNotAllowed'); }
  else if (trig === 'seasonStart' || trig === 'seasonEnd') { recurrence = { kind: 'onSeason' }; trigger = { kind: 'seasonal', phase: trig === 'seasonStart' ? 'start' : 'end' }; if (raw.frequency != null) reasons.push('frequencyNotAllowed'); }
  else if (TRIGGER_TYPES_SUPPORTED.includes(trig)) { const f = mapFrequency(raw.frequency); if (f.error) reasons.push(f.error); else recurrence = f.recurrence; if (trig === 'inSeason') trigger = { kind: 'seasonal', phase: 'active' }; }
  if (reasons.length) return { reasons };
  return { reasons, norm: {
    title: raw.title.trim(), titleEn: raw.titleEn ? raw.titleEn.trim() : null, instructions: raw.note ? raw.note.trim() : null,
    minutes: m, priority: raw.priority || 'normal', recurrence, trigger,
    targetKind: device ? 'device' : 'room', types: device ? deviceTypesFor(device) : roomTypesFor(area), typeLabel: device || area,
    pack: kind === 'template' ? (raw.pack ? raw.pack.trim() : 'AI import') : null } };
}

/** FNV-1a 64-bit (hex) — deterministic ids across retry / refresh / concurrent imports. */
export function fnv64(str) {
  let h = 0xcbf29ce484222325n; const P = 0x100000001b3n; const M = (1n << 64n) - 1n;
  for (const b of new TextEncoder().encode(str)) { h ^= BigInt(b); h = (h * P) & M; }
  return h.toString(16).padStart(16, '0');
}
const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Default target for an item: first active room / device of a matching type. */
export function defaultTarget(n, { rooms, devices }) {
  if (n.targetKind === 'room') return (rooms.find((r) => r.active !== false && n.types.includes(r.type)) || null);
  return (devices.find((d) => d.active !== false && n.types.includes(d.subtype)) || null);
}

/**
 * Step 3: dry-run preview. Nothing is written. Each item: create | duplicate | invalid (reasons).
 * `mapping` overrides the target per item key ('task:3' / 'template:0') with a room/device id.
 * A periodic DEVICE task is attached to the device's room (HomeHub tasks have no plain device link).
 */
export function buildImportPreview({ parsed, rooms, devices, tasks, templates, mapping = {}, lang, uid, now, today, canCreateTasks, canEditTemplates }) {
  const taskIds = new Set(tasks.map((t) => t.id)); const tplIds = new Set(templates.map((t) => t.id)); const seen = new Set();
  const out = [];
  const each = (list, kind) => list.forEach((raw, i) => {
    const key = `${kind}:${i}`; const { reasons, norm: n } = normalizeItem(raw, kind);
    const base = { key, kind, index: i, title: raw && typeof raw.title === 'string' ? raw.title.slice(0, 120) : `#${i + 1}` };
    if (!n) { out.push({ ...base, status: 'invalid', reasons }); return; }
    if (kind === 'task' && !canCreateTasks) { out.push({ ...base, status: 'invalid', reasons: ['noPermission'] }); return; }
    if (kind === 'template' && !canEditTemplates) { out.push({ ...base, status: 'invalid', reasons: ['noPermission'] }); return; }
    if (kind === 'template') {
      const v = validateTemplate({ pack: n.pack, title: n.title, titleEn: n.titleEn, instructions: n.instructions, minutes: n.minutes, priority: n.priority,
        target: n.targetKind === 'device' ? 'device' : 'room', recurrence: n.recurrence, trigger: n.trigger });
      if (Object.keys(v.errors).length) { out.push({ ...base, status: 'invalid', reasons: Object.values(v.errors) }); return; }
      const id = `ai_${fnv64(JSON.stringify(['template', v.value]))}`;
      if (tplIds.has(id) || seen.has(id)) { out.push({ ...base, id, status: 'duplicate', norm: n }); return; }
      seen.add(id); out.push({ ...base, id, status: 'create', norm: n, data: templateCreateDoc(v.value, { uid, now }), targetLabel: n.typeLabel }); return;
    }
    const pick = mapping[key] !== undefined ? (n.targetKind === 'room' ? rooms : devices).find((x) => x.id === mapping[key] && x.active !== false) || null : defaultTarget(n, { rooms, devices });
    if (!pick) { out.push({ ...base, status: 'invalid', reasons: [n.targetKind === 'room' ? 'noMatchingRoom' : 'noMatchingDevice'], norm: n }); return; }
    const isDev = n.targetKind === 'device';
    const roomId = isDev ? null : pick.id;   // 5.4d: device tasks follow the device's room
    const deviceId = isDev && !n.trigger ? pick.id : null;   // periodic device item → plain device link
    const trigger = n.trigger ? (n.trigger.kind === 'afterUse' ? { kind: 'afterUse', deviceId: pick.id } : { kind: 'seasonal', deviceId: pick.id, phase: n.trigger.phase }) : null;
    const title = lang === 'en' && n.titleEn ? n.titleEn : n.title;
    if (title.length > 80) { out.push({ ...base, status: 'invalid', reasons: ['titleTooLongForTask'], norm: n }); return; }
    const id = `ai_${fnv64(JSON.stringify(['task', title, roomId, trigger, n.recurrence, ...(deviceId ? [deviceId] : [])]))}`;
    const devOf = (t) => (t.trigger && t.trigger.deviceId) || t.deviceId || (t.source && t.source.kind === 'device' ? t.source.id : null);
    const sameTarget = tasks.filter((t) => t.active !== false && (isDev ? devOf(t) === pick.id : t.roomId === roomId && !devOf(t)));
    if (taskIds.has(id) || seen.has(id) || sameTarget.some((t) => norm(t.title) === norm(title))) { out.push({ ...base, id, status: 'duplicate', norm: n, targetId: pick.id }); return; }
    seen.add(id);
    out.push({ ...base, id, status: 'create', norm: n, targetId: pick.id, targetLabel: pick.name, data: {
      title, instructions: n.instructions, roomId, priority: n.priority, assignMode: 'shared', assigneeUids: [], eligibleUids: [], recurrence: n.recurrence,
      startDate: today, dueDate: null, endDate: null, active: true, archivedAt: null, archivedBy: null, ...(trigger ? { trigger } : {}), ...(deviceId ? { deviceId } : {}),
      estimatedMinutes: n.minutes, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 } });
  });
  each(parsed.tasks, 'task'); each(parsed.templates, 'template');
  return out;
}

/** The copyable prompt — ONLY what the user ticked. Never member names, finances, notes or ids. */
export function buildPrompt({ lang = 'ar', roomTypes = [], roomNames = [], deviceTypes = [], minutesPerDay = null, style = null, problems = [], wantTemplates = false }) {
  const L = [];
  L.push(lang === 'ar' ? 'أنت تصمّم خطة تنظيف منزلي لتطبيق HomeHub. أعد كائن JSON واحدًا فقط يطابق المخطط أدناه، بدون أي شرح أو علامات Markdown.'
    : 'You are designing a home-cleaning plan for the HomeHub app. Output ONLY one JSON object matching the schema below — no prose, no Markdown fences.');
  if (problems.length) { L.push('', lang === 'ar' ? '# المشكلات المطلوب حلها' : '# Problems to solve'); for (const p of problems) L.push(`- ${p}`); }
  L.push('', lang === 'ar' ? '# المنزل (ما اختار المستخدم مشاركته فقط)' : '# Home (only what the user chose to share)');
  if (roomTypes.length) L.push(`areaType: ${roomTypes.join(', ')}`);
  if (roomNames.length) L.push(`${lang === 'ar' ? 'أسماء الغرف' : 'Room names'}: ${roomNames.join(', ')}`);
  if (deviceTypes.length) L.push(`deviceType: ${deviceTypes.join(', ')}`);
  if (minutesPerDay) L.push(`${lang === 'ar' ? 'الوقت المتاح يوميًا (دقائق)' : 'Time available per day (minutes)'}: ${minutesPerDay}`);
  if (style) L.push(`${lang === 'ar' ? 'التكرار المفضّل' : 'Preferred frequency style'}: ${style}`);
  L.push('', '# Rules',
    `- schemaVersion: 1, packageType: "homehub-cleaning-plan"; at most ${IMPORT_LIMITS.tasks} tasks${wantTemplates ? ` and ${IMPORT_LIMITS.templates} templates` : ''}.`,
    `- Each item uses EXACTLY ONE of areaType (${AREA_TYPES.join(', ')}) or deviceType (${DEVICE_TYPES.join(', ')}).`,
    '- frequency: {"type":"daily"} | {"type":"interval","unit":"day"|"month","n":N (days ≤ 365, months ≤ 12)} | {"type":"weekly","weekday":0-6} | {"type":"monthly","day":1-31}.',
    '- Device items may set triggerType: periodic | afterUse | afterCycle | inSeason | seasonStart | seasonEnd (afterUse/afterCycle/seasonStart/seasonEnd: no frequency). Do NOT use conditionBased or manual.',
    '- estimatedMinutes: whole number 1–240. priority: low | normal | high. title ≤ 80 characters (titleEn optional). note/reason ≤ 300. No links, no ids, no dates, no extra fields.');
  const example = { schemaVersion: 1, packageType: 'homehub-cleaning-plan', metadata: { name: 'Plan name', language: lang },
    tasks: [{ title: lang === 'ar' ? 'مسح سطح المطبخ' : 'Wipe the kitchen counter', areaType: 'kitchen', frequency: { type: 'daily' }, estimatedMinutes: 5, priority: 'normal', note: '', reason: '' }],
    ...(wantTemplates ? { templates: [{ pack: 'Weekend', title: lang === 'ar' ? 'تنظيف الثلاجة' : 'Clean the fridge', deviceType: 'fridge', triggerType: 'inSeason', frequency: { type: 'interval', unit: 'month', n: 1 }, estimatedMinutes: 20 }] } : {}) };
  L.push('', '# Schema example', JSON.stringify(example, null, 2));
  return L.join('\n');
}

/** Copyable sample (documented in PHASE-5.4c-DESIGN.md). */
export const SAMPLE_PLAN = Object.freeze({ schemaVersion: 1, packageType: 'homehub-cleaning-plan', metadata: { name: 'Sample plan', language: 'ar' },
  tasks: [
    { title: 'مسح سطح المطبخ', titleEn: 'Wipe the kitchen counter', areaType: 'kitchen', frequency: { type: 'daily' }, estimatedMinutes: 5, priority: 'normal' },
    { title: 'تنظيف سلة القلاية', titleEn: 'Clean the air-fryer basket', deviceType: 'airfryer', triggerType: 'afterUse', estimatedMinutes: 5, priority: 'normal' },
    { title: 'تغيير ملاءات السرير', titleEn: 'Change the bed sheets', areaType: 'bedroom', frequency: { type: 'weekly', weekday: 5 }, estimatedMinutes: 15, priority: 'normal' },
  ],
  templates: [{ pack: 'Monthly', title: 'تنظيف الحمام بعمق', titleEn: 'Deep-clean the bathroom', areaType: 'bathroom', frequency: { type: 'monthly', day: 1 }, estimatedMinutes: 45, priority: 'high' }] });
