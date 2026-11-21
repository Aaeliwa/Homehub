/**
 * vCard import PREVIEW and PLAN (V6.4 B) — pure. Nothing is written here; the store executes the plan only
 * after the user confirms. Duplicates: normalised phone (last 9 national digits) is the primary signal,
 * the folded name a secondary one. Defaults are conservative: every possible duplicate is SKIPPED unless
 * the user explicitly chooses "merge into …" (fills empty fields / adds numbers, never overwrites) or
 * "keep separate" (a new contact).
 */
import { validateContact, findMatches, importId, matchKey, fold, mergeValue, sameContent, CONTACT_LIMITS, isDeleted } from './contact-model.js';
import { mergeJson } from './contacts-json.js';

export const ACTIONS = Object.freeze(['create', 'skip', 'merge', 'separate']);

/** Map vCard CATEGORIES names to existing category ids (name, or the suggested label in EN / AR). */
function mapCategories(names, categories, labelsOf) {
  const ids = []; const unknown = [];
  for (const n of names || []) {
    const f = fold(n);
    const hit = categories.find((c) => labelsOf(c).some((l) => fold(l) === f));
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); } else unknown.push(n);
  }
  return { ids: ids.slice(0, CONTACT_LIMITS.categories), unknown };
}

/**
 * parsed: parseVcf() result. contacts: live contacts. categories: live categories.
 * labelsOf(cat) → every display label of a category (its name, or the EN + AR suggested labels).
 * Returns { fileErrors, items: [{ index, status, action, matches, value, categoryIds, unknownCategories,
 *   errors, warnings, unsupported, mediaSkipped }], counts }.
 */
export function buildPreview(parsed, { contacts = [], categories = [], labelsOf = (c) => [c.name].filter(Boolean) } = {}) {
  const live = contacts.filter((c) => !isDeleted(c));
  const items = []; const seen = [];   // earlier VALID records in this file (in-file duplicates)
  for (const r of parsed.records) {
    const cats = mapCategories(r.value.categoryNames, categories, labelsOf);
    // .vcf records never carry a favourite or media; AI JSON records may (validated by the same validators)
    const v = validateContact({ ...r.value, categoryIds: cats.ids, favorite: r.version === 'json' && r.value.favorite === true }, { categories });
    const errors = [...r.errors, ...Object.values(v.errors).map((e) => e.replace(/^contacts\.v\./, ''))];
    const base = { index: r.index, version: r.version, value: v.value, categoryIds: cats.ids, unknownCategories: cats.unknown,
      errors: [...new Set(errors)], warnings: r.warnings, unsupported: r.unsupported, mediaSkipped: r.mediaSkipped, matches: [], inFileOf: null,
      ...(r.version === 'json' ? { unknownFields: r.unknownFields || [] } : {}) };
    if (errors.length || !r.ok) { items.push({ ...base, status: 'invalid', action: 'skip' }); continue; }
    const cand = { name: v.value.name, phones: v.value.phones.map((p) => ({ number: p.slice(p.indexOf('|') + 1) })) };
    const keys = cand.phones.map((p) => matchKey(p.number)).filter((k) => k.length >= 6);
    const twin = seen.find((s) => s.keys.some((k) => keys.includes(k)) || (fold(s.name) === fold(cand.name) && (keys.length === 0 || s.keys.length === 0)));
    const matches = findMatches(cand, live).map((m) => ({ id: m.contact.id, name: m.contact.name, by: m.by, rev: m.contact.rev }));
    seen.push({ index: r.index, name: cand.name, keys });
    if (twin) { items.push({ ...base, matches, status: 'inFile', inFileOf: twin.index, action: 'skip' }); continue; }
    // rev 2: this record's deterministic id is already a live contact → it was imported before (maybe edited
    // since). Never re-created or copied automatically: skip, merge into it, or explicitly keep separate.
    const prior = live.find((c) => c.id === importId(v.value, 0));
    if (prior) {
      const all = [{ id: prior.id, name: prior.name, by: 'import', rev: prior.rev }, ...matches.filter((m) => m.id !== prior.id)];
      items.push({ ...base, matches: all, status: 'imported', edited: !sameContent(prior, v.value), action: 'skip', targetId: prior.id });
      continue;
    }
    const phoneHits = matches.filter((m) => m.by !== 'name');
    const status = !matches.length ? 'new' : phoneHits.length > 1 || (!phoneHits.length && matches.length > 1) ? 'ambiguous' : phoneHits.length ? 'duplicate' : 'possible';
    items.push({ ...base, matches, status, action: status === 'new' ? 'create' : 'skip', targetId: status === 'duplicate' || status === 'possible' ? matches[0].id : null });
  }
  return { fileErrors: parsed.fileErrors, items, counts: countPreview(items) };
}
export function countPreview(items) {
  const c = { new: 0, imported: 0, duplicate: 0, possible: 0, ambiguous: 0, inFile: 0, invalid: 0, selected: 0 };
  for (const it of items) { c[it.status]++; if (it.action !== 'skip') c.selected++; }
  return c;
}
/** Which actions the user may choose for an item. */
export function allowedActions(it) {
  if (it.status === 'invalid') return ['skip'];
  if (it.status === 'new') return ['create', 'skip'];
  if (it.status === 'inFile') return ['skip', 'separate'];
  return it.matches.length ? ['skip', 'merge', 'separate'] : ['skip', 'separate'];
}

/**
 * Turn the confirmed preview into writes (rev 2).
 *  - "create" ALWAYS uses copy 0 of the deterministic id: the same record gets the same id on every device
 *    and retry. An occupied id is NEVER turned into a new copy here; the store verifies what occupies it
 *    (classifyOccupied) and reports it — it is not overwritten, restored or duplicated.
 *  - Only an explicit "keep separate" gets a copy number (≥ 1), skipping ids known to be taken (live
 *    contacts, takenIds, and ids planned earlier in this run); the store may move it further on a conflict.
 *  - Merges carry the target's revision seen in the preview (stale → re-confirm).
 * extraCategoryIds: categories the user assigned to the whole import. source: 'vcf' (default) | 'json' (V6.4.1).
 */
export function planImport(items, { contacts = [], takenIds = [], extraCategoryIds = [], source = 'vcf' } = {}) {
  const taken = new Set([...takenIds, ...contacts.map((c) => c.id)]);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const ops = [];
  for (const it of items) {
    if (it.status === 'invalid' || it.action === 'skip') continue;
    const value = { ...it.value, categoryIds: [...new Set([...(it.value.categoryIds || []), ...extraCategoryIds])].slice(0, CONTACT_LIMITS.categories) };
    if (it.action === 'merge') {
      const target = byId.get(it.targetId); const seen = it.matches.find((m) => m.id === it.targetId);
      if (!target || !seen) { ops.push({ kind: 'merge', index: it.index, name: value.name, targetId: it.targetId, error: 'contacts.import.targetGone' }); continue; }
      // V6.4.1: JSON merges may replace a conflicting field only when the user ticked it (it.take); .vcf unchanged
      const m = source === 'json' ? mergeJson(target, value, it.take || new Set()) : mergeValue(target, value);
      ops.push({ kind: 'merge', index: it.index, name: value.name, targetId: it.targetId, baseRev: seen.rev, value: m.value, changed: m.changed, conflicts: m.conflicts, droppedPhones: m.droppedPhones });
      continue;
    }
    if (it.action === 'separate') { ops.push(separateOp({ index: it.index, value, source }, taken)); continue; }
    const id = importId(value, 0); taken.add(id);
    ops.push({ kind: 'create', index: it.index, name: value.name, id, copy: 0, value, source });
  }
  return ops;
}
/** Explicit "keep separate" (from the preview, or for occupied results the user chose to add anyway). */
export function separateOp({ index, value, source = 'vcf' }, taken = new Set()) {
  let copy = 1; let id = importId(value, copy);
  while (taken.has(id) && copy < MAX_COPY) id = importId(value, ++copy);
  taken.add(id);
  return { kind: 'create', index, name: value.name, id, copy, separate: true, value, source };
}
export const MAX_COPY = 50;
