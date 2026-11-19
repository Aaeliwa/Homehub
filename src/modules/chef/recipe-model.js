/**
 * Recipes (V6.1) — PURE model. Household cookbook with stable ids (future Meal Planner references a
 * recipe by id; recipes are archived, never deleted). Amounts are stored as integer THOUSANDTHS
 * (`amountMilli`) so serving scaling is display-only and never drifts.
 */
export const CATEGORIES = Object.freeze(['breakfast', 'main', 'side', 'soup', 'salad', 'dessert', 'baking', 'drink', 'snack', 'other']);
export const UNITS = Object.freeze(['', 'g', 'kg', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'piece', 'pinch', 'clove', 'slice', 'can']);
export const LIMITS = Object.freeze({ title: 120, description: 1000, notes: 2000, ingName: 80, ingNote: 120, step: 1000, ingredients: 100, steps: 60,
  minutes: 1440, servings: 100, amountMilli: 100000000, stepMinutes: 1440 });
const fail = (detail, fields) => Object.assign(new Error(detail), { code: 'validation', detail, fields });
const txt = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '');
const DIGITS = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9, '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };
const VULGAR = { '¼': [1, 4], '½': [1, 2], '¾': [3, 4], '⅓': [1, 3], '⅔': [2, 3], '⅛': [1, 8] };

// ---------------------------------------------------------------- YouTube
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const ID = /^[A-Za-z0-9_-]{11}$/;
/** Strict: returns the 11-char video id, or null. Exact host allow-list; https/http only; no credentials; no HTML. */
export function parseYouTube(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s || s.length > 300 || /[<>"'\s]/.test(s)) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (host.endsWith('youtu.be')) id = parts.length === 1 ? parts[0] : null;
  else if (parts[0] === 'watch' && parts.length === 1) id = u.searchParams.get('v');
  else if ((parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') && parts.length === 2) id = parts[1];
  return id && ID.test(id) ? id : null;
}
export const isVideoId = (id) => typeof id === 'string' && ID.test(id);
/**
 * V6.1.1: any OTHER video page (Facebook, Instagram, …) — a safe https link only (never embedded,
 * never a thumbnail). https only; no credentials, port, whitespace or markup; a real dotted hostname.
 */
export function safeVideoUrl(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s || s.length > 500 || /[<>"'\s\\]/.test(s)) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
  const out = u.toString();
  return out.length <= 500 && /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/[^\s<>"]*)?$/.test(out) ? out : null;
}
/** Human label for a non-YouTube source (shown as text; never a fabricated thumbnail). */
export function videoSourceName(url) {
  let host = ''; try { host = new URL(url).hostname.toLowerCase().replace(/^(www|m)\./, ''); } catch { return ''; }
  if (host === 'fb.watch' || host.endsWith('facebook.com')) return 'Facebook';
  if (host.endsWith('instagram.com')) return 'Instagram';
  if (host.endsWith('tiktok.com')) return 'TikTok';
  if (host.endsWith('vimeo.com')) return 'Vimeo';
  return host;
}
export const embedUrl = (id) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const thumbUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

// ---------------------------------------------------------------- amounts (integer thousandths)
/** "1½", "1 1/2", "0.5", "٢", "" → milli units (null = no quantity). Throws on invalid / out-of-range. */
export function parseAmount(raw) {
  let s = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw);
  if (!s) return null;
  s = s.replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d]).replace(/[٫,]/g, '.');
  let whole = 0; let num = 0; let den = 1;
  const vf = Object.keys(VULGAR).find((k) => s.endsWith(k));
  if (vf) { [num, den] = VULGAR[vf]; s = s.slice(0, -1).trim(); if (s) { if (!/^\d+$/.test(s)) throw fail('recipes.err.amount'); whole = Number(s); } }
  else if (/^\d+\s+\d+\/\d+$/.test(s)) { const [w, f] = s.split(/\s+/); whole = Number(w); [num, den] = f.split('/').map(Number); }
  else if (/^\d+\/\d+$/.test(s)) [num, den] = s.split('/').map(Number);
  else if (/^\d+(\.\d{1,3})?$/.test(s)) { const [a, b = ''] = s.split('.'); return check(Number(a) * 1000 + Number((b + '000').slice(0, 3))); }
  else throw fail('recipes.err.amount');
  if (!den || den > 1000) throw fail('recipes.err.amount');
  return check(whole * 1000 + Math.round((num * 1000) / den));
}
function check(m) { if (!Number.isSafeInteger(m) || m <= 0 || m > LIMITS.amountMilli) throw fail('recipes.err.amount'); return m; }
/** Display-only scaling from the immutable base amount; integer arithmetic, rounded once. */
export function scaleMilli(amountMilli, baseServings, servings) {
  if (amountMilli == null) return null;
  return Math.round((amountMilli * servings) / baseServings);
}
const FRACS = [[125, '⅛'], [250, '¼'], [333, '⅓'], [500, '½'], [667, '⅔'], [750, '¾']];
/** Friendly display: whole + common fraction when within ±1/100, else up to 2 decimals. */
export function formatAmount(milli) {
  if (milli == null) return '';
  const whole = Math.floor(milli / 1000); const rem = milli % 1000;
  if (rem === 0) return String(whole);
  const f = FRACS.find(([v]) => Math.abs(v - rem) <= 10);
  if (f && whole < 100) return whole ? `${whole} ${f[1]}` : f[1];
  return (milli / 1000).toFixed(2).replace(/\.?0+$/, '');
}

// ---------------------------------------------------------------- validation
const newId = (p) => `${p}${Math.random().toString(36).slice(2, 10)}`;
export function validateRecipe(input = {}) {
  const errors = {};
  const titleEn = txt(input.titleEn); const titleAr = txt(input.titleAr);
  if (!titleEn && !titleAr) errors.title = 'recipes.err.title';
  if (titleEn.length > LIMITS.title || titleAr.length > LIMITS.title) errors.title = 'recipes.err.tooLong';
  const description = txt(input.description); if (description.length > LIMITS.description) errors.description = 'recipes.err.tooLong';
  const notes = txt(input.notes); if (notes.length > LIMITS.notes) errors.notes = 'recipes.err.tooLong';
  const category = CATEGORIES.includes(input.category) ? input.category : 'other';
  const int = (v, lo, hi, key) => { const n = v === '' || v == null ? 0 : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) errors[key] = 'recipes.err.number'; return n; };
  const prepMinutes = int(input.prepMinutes, 0, LIMITS.minutes, 'prepMinutes'); const cookMinutes = int(input.cookMinutes, 0, LIMITS.minutes, 'cookMinutes');
  const servings = int(input.servings == null || input.servings === '' ? 1 : input.servings, 1, LIMITS.servings, 'servings');
  let videoId = null; let videoUrl = null;
  if (input.video) {
    videoId = isVideoId(input.video) ? input.video : parseYouTube(input.video);   // YouTube keeps the embedded player
    if (!videoId) { videoUrl = safeVideoUrl(input.video); if (!videoUrl) errors.video = 'recipes.err.video'; }
  }
  const ings = Array.isArray(input.ingredients) ? input.ingredients : [];
  if (ings.length > LIMITS.ingredients) errors.ingredients = 'recipes.err.tooMany';
  const ingredients = [];
  ings.forEach((g, i) => {
    const name = txt(g.name); if (!name) return;   // empty rows are dropped
    if (name.length > LIMITS.ingName) errors[`ing${i}`] = 'recipes.err.tooLong';
    let amountMilli = null;
    try { amountMilli = typeof g.amountMilli === 'number' ? check(g.amountMilli) : parseAmount(g.amount); } catch { errors[`ing${i}`] = 'recipes.err.amount'; }
    const unit = UNITS.includes(g.unit) ? g.unit : '';
    const note = txt(g.note); if (note.length > LIMITS.ingNote) errors[`ing${i}`] = 'recipes.err.tooLong';
    ingredients.push({ id: typeof g.id === 'string' && /^[a-z0-9]{3,20}$/.test(g.id) ? g.id : newId('i'), name, amountMilli, unit, note: note || null });
  });
  const sts = Array.isArray(input.steps) ? input.steps : [];
  if (sts.length > LIMITS.steps) errors.steps = 'recipes.err.tooMany';
  const steps = [];
  sts.forEach((st, i) => {
    const text = txt(st.text); if (!text) return;
    if (text.length > LIMITS.step) errors[`step${i}`] = 'recipes.err.tooLong';
    const m = st.minutes === '' || st.minutes == null ? null : Number(st.minutes);
    if (m !== null && (!Number.isInteger(m) || m < 1 || m > LIMITS.stepMinutes)) errors[`step${i}`] = 'recipes.err.number';
    steps.push({ id: typeof st.id === 'string' && /^[a-z0-9]{3,20}$/.test(st.id) ? st.id : newId('s'), text, minutes: m });
  });
  return { value: { titleEn: titleEn || null, titleAr: titleAr || null, description: description || null, category, prepMinutes, cookMinutes, servings,
    videoId, videoUrl, ingredients, steps, notes: notes || null }, errors };
}
export const EDITABLE = Object.freeze(['titleEn', 'titleAr', 'description', 'category', 'prepMinutes', 'cookMinutes', 'servings', 'videoId', 'videoUrl', 'ingredients', 'steps', 'notes']);
export function createDoc(v, { uid, now }) {
  return { ...v, favoritedBy: [], archived: false, archivedAt: null, archivedBy: null, rev: 1, createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: 1 };
}
export function editPatch(cur, v, { uid, now }) {
  const p = {}; for (const k of EDITABLE) if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(v[k] ?? null)) p[k] = v[k] ?? null;
  return Object.keys(p).length ? { ...p, rev: (cur.rev || 0) + 1, updatedBy: uid, updatedAt: now } : null;
}
/** Duplicate: a NEW recipe (new id) with the same content; never shares ids with the source. */
export function duplicateInput(r, suffix) {
  return { titleEn: r.titleEn ? `${r.titleEn} ${suffix}`.slice(0, LIMITS.title) : null, titleAr: r.titleAr ? `${r.titleAr} ${suffix}`.slice(0, LIMITS.title) : null,
    description: r.description, category: r.category, prepMinutes: r.prepMinutes, cookMinutes: r.cookMinutes, servings: r.servings, video: r.videoId || r.videoUrl || '',
    ingredients: r.ingredients.map((g) => ({ name: g.name, amountMilli: g.amountMilli, unit: g.unit, note: g.note })), steps: r.steps.map((s) => ({ text: s.text, minutes: s.minutes })), notes: r.notes };
}
/** V6.1.1: soft-deleted recipes leave every list, search and favorite (still readable by id). */
export const isDeleted = (r) => !!(r && r.deletedAt);
export const titleOf = (r, lang) => (lang === 'ar' ? r.titleAr || r.titleEn : r.titleEn || r.titleAr) || '';
export function matches(r, q) {
  const s = (q || '').trim().toLowerCase(); if (!s) return true;
  return [r.titleEn, r.titleAr, r.description, ...(r.ingredients || []).map((g) => g.name)].some((x) => x && x.toLowerCase().includes(s));
}
