/**
 * V6.3 Recipes — external-AI JSON import (PURE; no network, no AI API, no video fetching).
 * The user asks ANY external AI (with the prompt below) to turn cooking videos / transcripts THEY
 * provide into this envelope, then pastes / uploads the JSON here. Input is untrusted:
 *   - exact envelope { schema, version, items[] }; unknown keys are refused at every level and
 *     protected metadata (ids, owners, permissions, timestamps…) is refused explicitly;
 *   - only allowlisted fields are mapped onto the EXISTING recipe validator (validateRecipe), so an
 *     imported recipe is exactly a manual one (same limits, units, categories, video policy);
 *   - text is plain text (rendered as text nodes; never HTML), URLs go through parseYouTube /
 *     safeVideoUrl (https only), step timers 1–1440 minutes;
 *   - nothing is silently dropped: empty rows, unknown units / categories and review flags are errors
 *     or visible warnings; review flags are kept in the recipe's notes.
 */
import { CATEGORIES, UNITS, LIMITS, validateRecipe, parseAmount, parseYouTube, safeVideoUrl } from './recipe-model.js';

export const IMPORT_SCHEMA = 'homehub.recipes';
export const IMPORT_VERSION = 1;
export const IMPORT_LIMITS = Object.freeze({ bytes: 256 * 1024, items: 25, review: 20, reviewText: 200 });
const ENVELOPE_KEYS = ['schema', 'version', 'items'];
const ITEM_KEYS = ['titleEn', 'titleAr', 'description', 'category', 'servings', 'prepMinutes', 'cookMinutes', 'ingredients', 'steps', 'videoUrl', 'notes', 'review'];
const ING_KEYS = ['name', 'amount', 'unit', 'note'];
const STEP_KEYS = ['text', 'minutes'];
/** Never accepted from a file (assigned by HomeHub / the server). */
export const PROTECTED_KEYS = Object.freeze(['id', 'recipeId', 'homeId', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'rev', 'schemaVersion', 'archived', 'archivedAt',
  'archivedBy', 'deletedAt', 'deletedBy', 'favoritedBy', 'ownerUid', 'owner', 'members', 'readers', 'permissions', 'roles', 'audience', 'videoId']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const optStr = (v, max) => v === undefined || v === null || isStr(v, max);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Keys the object may not have (unknown or protected), as error codes. */
function keyErrors(o, allowed, where) {
  const out = [];
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    out.push(PROTECTED_KEYS.includes(k) ? `protected:${where}${k}` : `unknownField:${where}${k}`);
  }
  return out;
}

/** Strict check of one item; returns { errors, warnings, input } — `input` feeds validateRecipe. */
export function checkItem(it) {
  const errors = []; const warnings = [];
  if (!isObj(it)) return { errors: ['notObject'], warnings, input: null };
  errors.push(...keyErrors(it, ITEM_KEYS, ''));
  const tEn = it.titleEn ?? null; const tAr = it.titleAr ?? null;
  if (!optStr(tEn, LIMITS.title) || !optStr(tAr, LIMITS.title)) errors.push('title');
  if (!(typeof tEn === 'string' && tEn.trim()) && !(typeof tAr === 'string' && tAr.trim())) errors.push('titleRequired');
  if (!optStr(it.description, LIMITS.description)) errors.push('description');
  if (it.category !== undefined && !CATEGORIES.includes(it.category)) errors.push('category');
  if (it.servings !== undefined && !isInt(it.servings, 1, LIMITS.servings)) errors.push('servings');
  for (const k of ['prepMinutes', 'cookMinutes']) if (it[k] !== undefined && !isInt(it[k], 0, LIMITS.minutes)) errors.push(k);
  if (!optStr(it.notes, LIMITS.notes)) errors.push('notes');
  let video = '';
  if (it.videoUrl !== undefined && it.videoUrl !== null) {
    if (!isStr(it.videoUrl, 500) || !(parseYouTube(it.videoUrl) || safeVideoUrl(it.videoUrl))) errors.push('videoUrl'); else video = it.videoUrl.trim();
  }
  const ings = it.ingredients === undefined ? [] : it.ingredients;
  if (!Array.isArray(ings) || ings.length > LIMITS.ingredients) errors.push('ingredients');
  const ingredients = [];
  if (Array.isArray(ings)) ings.slice(0, LIMITS.ingredients).forEach((g, i) => {
    const at = `ingredients[${i}]`;
    if (!isObj(g)) { errors.push(`notObject:${at}`); return; }
    errors.push(...keyErrors(g, ING_KEYS, `${at}.`));
    if (!(typeof g.name === 'string' && g.name.trim() && g.name.length <= LIMITS.ingName)) errors.push(`name:${at}`);
    if (g.unit !== undefined && !UNITS.includes(g.unit)) errors.push(`unit:${at}`);
    if (!optStr(g.note, LIMITS.ingNote)) errors.push(`note:${at}`);
    let amount = '';
    if (g.amount === undefined || g.amount === null || g.amount === '') warnings.push(`noAmount:${at}`);
    else if (typeof g.amount === 'number' || typeof g.amount === 'string') {
      amount = String(g.amount);
      try { parseAmount(amount); } catch { errors.push(`amount:${at}`); }
    } else errors.push(`amount:${at}`);
    ingredients.push({ name: typeof g.name === 'string' ? g.name : '', amount, unit: g.unit || '', note: typeof g.note === 'string' ? g.note : '' });
  });
  const sts = it.steps === undefined ? [] : it.steps;
  if (!Array.isArray(sts) || sts.length > LIMITS.steps) errors.push('steps');
  const steps = [];
  if (Array.isArray(sts)) sts.slice(0, LIMITS.steps).forEach((s, i) => {
    const at = `steps[${i}]`;
    if (!isObj(s)) { errors.push(`notObject:${at}`); return; }
    errors.push(...keyErrors(s, STEP_KEYS, `${at}.`));
    if (!(typeof s.text === 'string' && s.text.trim() && s.text.length <= LIMITS.step)) errors.push(`text:${at}`);
    if (s.minutes !== undefined && s.minutes !== null && !isInt(s.minutes, 1, LIMITS.stepMinutes)) errors.push(`minutes:${at}`);
    steps.push({ text: typeof s.text === 'string' ? s.text : '', minutes: s.minutes ?? null });
  });
  if (Array.isArray(sts) && !sts.length) warnings.push('noSteps');
  if (Array.isArray(ings) && !ings.length) warnings.push('noIngredients');
  // Review flags (uncertain quantities / steps): shown before import and KEPT in the notes.
  let notes = typeof it.notes === 'string' ? it.notes.trim() : '';
  if (it.review !== undefined) {
    if (!Array.isArray(it.review) || it.review.length > IMPORT_LIMITS.review || !it.review.every((x) => isStr(x, IMPORT_LIMITS.reviewText) && x.trim())) errors.push('review');
    else if (it.review.length) {
      for (const r of it.review) warnings.push(`flag:${r.trim()}`);
      notes = [notes, `⚠ ${it.review.map((x) => x.trim()).join(' · ')}`].filter(Boolean).join('\n\n');
      if (notes.length > LIMITS.notes) errors.push('notesWithReview');
    }
  }
  const input = { titleEn: tEn, titleAr: tAr, description: it.description ?? null, category: it.category || 'other', servings: it.servings ?? 1,
    prepMinutes: it.prepMinutes ?? 0, cookMinutes: it.cookMinutes ?? 0, video, ingredients, steps, notes };
  if (!errors.length) {   // the existing validator decides last — exactly as for a manual recipe
    const v = validateRecipe(input);
    for (const k of Object.keys(v.errors)) errors.push(`model:${k}`);
  }
  return { errors: [...new Set(errors)], warnings, input };
}

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[ً-ْ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Stable identity used for duplicate detection: normalized titles + the video (id or URL). */
export function identityOf(r) {
  const vid = r.videoId || parseYouTube(r.video || r.videoUrl || '') || null;
  const url = vid ? null : (r.videoUrl || safeVideoUrl(r.video || '') || null);
  return { titles: [norm(r.titleEn), norm(r.titleAr)].filter(Boolean), video: vid ? `yt:${vid}` : url ? `url:${url}` : null };
}
const sameRecipe = (a, b) => (a.video && b.video && a.video === b.video) || a.titles.some((x) => b.titles.includes(x));

/** FNV-1a 64 → 16 hex (deterministic import ids; a retry of the same preview reuses them). */
function fnv64(s) {
  let h = 0xcbf29ce484222325n; const p = 0x100000001b3n;
  for (const ch of new TextEncoder().encode(s)) { h ^= BigInt(ch); h = (h * p) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0');
}

/** V6.3.0.1: stable identity key — the same recipe gives the same key on every device / session. */
export const identityKey = (ident) => `${[...ident.titles].sort().join('|')}#${ident.video || ''}`;

/**
 * Parse + check a pasted / uploaded file against the live cookbook. `existing` = accessible recipes
 * (deleted ones excluded by the caller); `takenIds` = every known recipe id (deleted included).
 * V6.3.0.1 ids are DETERMINISTIC and session-independent: `ai_<hash(identityKey#copy)>`, copy = how many
 * matching recipes already exist (cookbook + earlier in this file). So two devices importing the same new
 * recipe at once produce the SAME id and the create-only rules keep exactly one; an intentional
 * separate copy (a ticked duplicate) gets the next copy number, i.e. its own id. `nonce` is ignored.
 * Returns { ok, error?, items: [{ index, status: 'ready'|'duplicate'|'invalid', dupOf, errors, warnings, input, id, selected }] }.
 */
export function previewImport(text, { existing = [], takenIds = [], nonce = '' } = {}) {   // eslint-disable-line no-unused-vars
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty', items: [] };
  if (new TextEncoder().encode(text).length > IMPORT_LIMITS.bytes) return { ok: false, error: 'tooLarge', items: [] };
  let data; try { data = JSON.parse(text); } catch { return { ok: false, error: 'json', items: [] }; }
  if (!isObj(data)) return { ok: false, error: 'envelope', items: [] };
  if (typeof data.needInput === 'string' && Object.keys(data).length === 1) return { ok: false, error: 'needInput', detail: data.needInput.slice(0, 300), items: [] };   // the AI asked for the transcript
  const extra = keyErrors(data, ENVELOPE_KEYS, '');
  if (extra.length) return { ok: false, error: 'envelopeKeys', detail: extra.join(', '), items: [] };
  if (data.schema !== IMPORT_SCHEMA) return { ok: false, error: 'schema', items: [] };
  if (data.version !== IMPORT_VERSION) return { ok: false, error: 'version', items: [] };
  if (!Array.isArray(data.items) || !data.items.length) return { ok: false, error: 'noItems', items: [] };
  if (data.items.length > IMPORT_LIMITS.items) return { ok: false, error: 'tooMany', items: [] };
  const known = existing.map((r) => ({ id: r.id, ...identityOf(r) }));
  const seen = []; const taken = new Set([...takenIds, ...existing.map((r) => r.id)]);
  const items = data.items.map((raw, index) => {
    const c = checkItem(raw);
    const base = { index, errors: c.errors, warnings: c.warnings, input: c.input };
    if (c.errors.length) return { ...base, status: 'invalid', selected: false, id: null };
    const ident = identityOf(c.input);
    const inFile = seen.find((x) => sameRecipe(x.ident, ident));
    const inBook = known.find((x) => sameRecipe(x, ident));
    let copy = known.filter((x) => sameRecipe(x, ident)).length + seen.filter((x) => sameRecipe(x.ident, ident)).length;
    let id = `ai_${fnv64(`${identityKey(ident)}#${copy}`)}`;
    while (taken.has(id)) id = `ai_${fnv64(`${identityKey(ident)}#${++copy}`)}`;   // e.g. a deleted recipe keeps its id
    taken.add(id);
    seen.push({ ident, index });
    if (inFile) return { ...base, id, status: 'duplicate', dupOf: { kind: 'file', index: inFile.index }, selected: false };
    if (inBook) return { ...base, id, status: 'duplicate', dupOf: { kind: 'cookbook', id: inBook.id }, selected: false };
    return { ...base, id, status: 'ready', selected: true };
  });
  return { ok: true, items };
}

// ---------------------------------------------------------------- prompt / template / example
export const EXAMPLE = Object.freeze({
  schema: IMPORT_SCHEMA, version: IMPORT_VERSION,
  items: [{
    titleEn: 'Lentil soup', titleAr: null, description: 'A quick weeknight soup.', category: 'soup', servings: 4, prepMinutes: 10, cookMinutes: 30,
    ingredients: [{ name: 'Red lentils', amount: '1 1/2', unit: 'cup', note: 'rinsed' }, { name: 'Onion', amount: 1, unit: 'piece', note: null },
      { name: 'Cumin', amount: '1', unit: 'tsp', note: null }, { name: 'Salt', amount: null, unit: '', note: 'to taste' }],
    steps: [{ text: 'Sauté the chopped onion until soft.', minutes: 5 }, { text: 'Add lentils, cumin and 1 litre of water.', minutes: null },
      { text: 'Simmer until the lentils are soft, then blend.', minutes: 25 }],
    videoUrl: null, notes: null, review: ['The video does not say how much salt.'],
  }],
});
/** Every key with its default / placeholder (valid as-is, so it round-trips through the importer). */
export const TEMPLATE = Object.freeze({
  schema: IMPORT_SCHEMA, version: IMPORT_VERSION,
  items: [{ titleEn: 'Recipe title', titleAr: null, description: null, category: 'other', servings: 1, prepMinutes: 0, cookMinutes: 0,
    ingredients: [{ name: 'Ingredient', amount: null, unit: '', note: null }], steps: [{ text: 'Step 1', minutes: null }], videoUrl: null, notes: null, review: [] }],
});

export function buildPrompt() {
  return `You convert cooking videos into recipes for the HomeHub app. Reply with VALID JSON ONLY (no Markdown, no comments, no text before or after).

INPUT: I will give you one or more cooking video URLs and/or transcripts. Use ONLY what is said or shown in what I provide.
- If you cannot access a video or I gave no transcript, DO NOT invent a recipe: reply exactly {"needInput": "<what you need, e.g. the transcript of URL …>"} and nothing else.
- Never guess quantities, times or steps. When something is unclear, keep the field empty (null) and add a short sentence to "review".
- Do not translate. Put the title in the language of the video: Arabic → "titleAr", otherwise → "titleEn" (the other one null).

OUTPUT (exactly these keys; no other keys anywhere):
{
  "schema": "${IMPORT_SCHEMA}",
  "version": ${IMPORT_VERSION},
  "items": [ one object per recipe, at most ${IMPORT_LIMITS.items} ]
}
Each recipe object:
- "titleEn" / "titleAr": string up to ${LIMITS.title} characters or null (at least one is required)
- "description": string up to ${LIMITS.description} characters or null
- "category": one of ${CATEGORIES.map((c) => `"${c}"`).join(', ')} (default "other")
- "servings": integer 1–${LIMITS.servings} (default 1)
- "prepMinutes", "cookMinutes": integers 0–${LIMITS.minutes} (default 0)
- "ingredients": up to ${LIMITS.ingredients} objects {"name": string up to ${LIMITS.ingName}, "amount": number, or a string like "1 1/2", "½", "0.25", or null when not stated, "unit": one of ${UNITS.map((u) => `"${u}"`).join(', ')} ("" = no unit, e.g. "2 eggs"), "note": string up to ${LIMITS.ingNote} or null}
  Convert units that are not in the list (e.g. "oz") only if the video states the metric amount; otherwise use "" and put the original wording in "note".
- "steps": up to ${LIMITS.steps} objects in cooking order {"text": string up to ${LIMITS.step}, "minutes": integer 1–${LIMITS.stepMinutes} when the video gives a time for that step (it becomes a cooking timer), else null}
- "videoUrl": the original https video URL (YouTube links are embedded; other https links are shown as links) or null
- "notes": string up to ${LIMITS.notes} or null (tips, storage, substitutions mentioned in the video)
- "review": list of up to ${IMPORT_LIMITS.review} short strings (up to ${IMPORT_LIMITS.reviewText} characters) describing anything uncertain; [] when nothing is uncertain
Do not output ids, owners, dates, permissions or any other field.

Example of a valid answer:
${JSON.stringify(EXAMPLE, null, 2)}`;
}
