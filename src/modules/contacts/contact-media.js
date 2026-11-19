/**
 * Contact media (V6.4 Batch C) — pure, no DOM. Profile pictures and restaurant menus are EXTERNAL HTTPS LINKS
 * ONLY: nothing is uploaded, stored as bytes, proxied or fetched by HomeHub itself (Firebase Spark: no Storage,
 * no Functions). The browser loads a picture / menu directly from its host, only when it is displayed.
 *
 * Stored (both OPTIONAL — contacts written before 6.4.0-c simply have neither key):
 *   avatarUrl: string | null                       — https URL, ≤ MEDIA_LIMITS.url characters
 *   menus:     string[] (≤ MEDIA_LIMITS.menus)      — "kind|label|url" (kind ∈ MENU_KINDS, label ≤ 40, url as above)
 * Strings, not maps (like phones): the Firestore rules validate EACH ELEMENT by index (menus[0] … menus[9], no
 * loops in rules) with anchored per-entry patterns — one element can never carry two entries and two elements
 * can never combine into one (rev 2: the earlier joined-string check allowed both). The same patterns are used
 * here; a unit test keeps them identical to firestore.rules.
 *
 * URL safety is BEST-EFFORT and purely syntactic (see HOST_DENY_PATTERN): HomeHub never resolves DNS and
 * cannot see redirects (the browser follows them when it loads the image / frame), so a public-looking host
 * name that resolves — or redirects — to a private address cannot be detected here. Browser protections
 * (mixed-content blocking / upgrading, Private Network Access where shipped) are the remaining safeguard.
 */

export const MEDIA_LIMITS = Object.freeze({ url: 500, menus: 10, menuLabel: 40, rawInput: 2000 });
export const MENU_KINDS = Object.freeze(['image', 'pdf', 'web', 'drive']);
/** The suggested category whose contacts show a Menu section (identified by KEY, so a rename keeps it). */
export const RESTAURANT_KEY = 'restaurants';

// ------------------------------------------------------------------ shared URL grammar (= firestore.rules)
// https only; a DNS host name (lower-case, at least one dot, alphabetic top-level label — so no numeric IP
// addresses or bracketed IP literals, no bare "localhost", no credentials, no trailing dot);
// optional port; then path / query / fragment restricted to printable URL characters (no space, quote, '<', '>',
// '\', '^', '`', '{', '|', '}', no control characters). "|" is the menu field separator, so it is never in a URL.
// ("https:[/][/]" = "https://" — written so the rules file never contains "//" inside a string.)
const HOST = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*[.][a-z]([a-z0-9-]{0,61}[a-z0-9])?';
const REST = '([/?#][!#$%&\\x27\\x28\\x29*+,./0-9:;=?@A-Z\\x5b\\x5d_a-z~-]*)?';
export const URL_PATTERN = `^https:[/][/]${HOST}(:[0-9]{1,5})?${REST}$`;
/** ONE menu entry "kind|label|url" — anchored, so exactly one entry per array element. */
export const MENU_ENTRY_PATTERN = `^(image|pdf|web|drive)[|][^|\\x00-\\x1f\\x7f]{0,40}[|]https:[/][/]${HOST}(:[0-9]{1,5})?${REST}$`;
/** Lengths of ONE entry: kind 3–5, label ≤ 40, url 8–500 (exactly two separators). */
export const MENU_ENTRY_LENGTH_PATTERN = '^[a-z]{3,5}[|][^|]{0,40}[|][^|]{8,500}$';
/**
 * Prohibited host names: local-network suffixes (localhost, local, localdomain, internal, intranet, lan, home,
 * home.arpa, corp, private) and public wildcard-DNS services that map names to arbitrary IP addresses (nip.io,
 * sslip.io, xip.io, localtest.me, lvh.me). Best-effort and syntactic: a deny-list is necessarily incomplete.
 */
const DENY_SUFFIX = '(localhost|local|localdomain|internal|intranet|lan|home|home[.]arpa|corp|private|nip[.]io|sslip[.]io|xip[.]io|localtest[.]me|lvh[.]me)';
/** A single URL on a prohibited host. */
export const HOST_DENY_PATTERN = `^https:[/][/]([a-z0-9-]{1,63}[.])*${DENY_SUFFIX}([:/?#].*)?$`;
/**
 * menus.join('|') containing an entry whose URL is on a prohibited host. Used ONLY AFTER every element was
 * validated on its own as exactly one "kind|label|url" (3 fields, no '|' inside a field): the joined string's
 * field boundaries then match the elements, and this pattern only ever looks at URL fields (every third one).
 */
export const MENUS_DENY_PATTERN = `^([^|]*[|][^|]*[|][^|]*[|])*[^|]*[|][^|]*[|]https:[/][/]([a-z0-9-]{1,63}[.])*${DENY_SUFFIX}([:/?#][^|]*)?([|].*)?$`;
const URL_RE = new RegExp(URL_PATTERN);
// 'u': count code points like RE2 does in the rules (an emoji label is 1 character, not 2)
const ENTRY_RE = new RegExp(MENU_ENTRY_PATTERN, 'u');
const ENTRY_LEN_RE = new RegExp(MENU_ENTRY_LENGTH_PATTERN, 'u');
const DENY_RE = new RegExp(HOST_DENY_PATTERN);
const MENUS_DENY_RE = new RegExp(MENUS_DENY_PATTERN, 'u');

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '');
const EXEC_SCHEME = /^\s*(javascript|vbscript|data|file|blob|about|filesystem|intent|chrome|content)\s*:/i;

/**
 * Normalise and validate a user-entered picture / menu URL.
 * → { url } | { empty: true } | { error: 'contacts.v.url*' }. Never guesses a scheme ("example.com" is refused:
 * the user must paste the full https link), never accepts http, credentials, executable schemes or > 500 chars.
 */
export function normalizeHttpsUrl(raw) {
  const s = clean(raw).trim();
  if (!s) return { empty: true };
  if (s.length > MEDIA_LIMITS.rawInput) return { error: 'contacts.v.urlLong' };
  if (EXEC_SCHEME.test(s)) return { error: 'contacts.v.urlScheme' };
  let u;
  try { u = new URL(s); } catch { return { error: 'contacts.v.url' }; }
  if (u.protocol !== 'https:') return { error: u.protocol === 'http:' ? 'contacts.v.urlHttps' : 'contacts.v.urlScheme' };
  if (u.username || u.password || /^https:\/\/[^/?#]*@/i.test(s)) return { error: 'contacts.v.urlCredentials' };
  // WHATWG keeps | { } ^ in paths: percent-encode them (and anything else outside the shared grammar's set)
  const href = u.href.replace(/[|{}^`"<>\\ ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  if (href.length > MEDIA_LIMITS.url) return { error: 'contacts.v.urlLong' };
  if (!URL_RE.test(href)) return { error: 'contacts.v.url' };
  if (DENY_RE.test(href)) return { error: 'contacts.v.urlHost' };
  return { url: href };
}
/** Exactly the rules' contactUrlOk. */
export const isStoredUrl = (v) => typeof v === 'string' && v.length <= MEDIA_LIMITS.url && URL_RE.test(v) && !DENY_RE.test(v);
/** Exactly the rules' contactMenuOk for one element (structure + lengths), plus the host deny check. */
const entryShapeOk = (e) => typeof e === 'string' && ENTRY_LEN_RE.test(e) && ENTRY_RE.test(e);
export const isStoredMenuEntry = (e) => entryShapeOk(e) && !MENUS_DENY_RE.test(e);

// ------------------------------------------------------------------ providers
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
/**
 * Google Drive / Docs links → their official "/preview" embed URL (Drive enforces the file's own sharing:
 * a private file stays private — HomeHub never changes sharing or converts to a public "publish" link).
 * Any other host → null (never embedded: opened in a new tab instead).
 */
export function driveEmbedUrl(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const key = u.searchParams.get('resourcekey');
  const rk = key && /^[A-Za-z0-9_-]{1,100}$/.test(key) ? `?resourcekey=${key}` : '';
  if (u.hostname === 'drive.google.com') {
    const m = u.pathname.match(/^\/file\/d\/([^/]+)(\/(view|preview|edit))?\/?$/);
    const id = m ? m[1] : u.pathname === '/open' ? u.searchParams.get('id') : null;
    return id && DRIVE_ID.test(id) ? `https://drive.google.com/file/d/${id}/preview${rk}` : null;
  }
  if (u.hostname === 'docs.google.com') {
    const m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)(\/[a-z]*)?\/?$/);
    return m && DRIVE_ID.test(m[2]) ? `https://docs.google.com/${m[1]}/d/${m[2]}/preview${rk}` : null;
  }
  return null;
}
/** Kind suggestion from the URL (the user may override image / pdf / web). */
export function detectKind(url) {
  if (driveEmbedUrl(url)) return 'drive';
  let path = ''; try { path = new URL(url).pathname.toLowerCase(); } catch { /* invalid → web */ }
  if (/\.pdf$/.test(path)) return 'pdf';
  if (/\.(jpe?g|png|webp|gif|avif|svg)$/.test(path)) return 'image';   // shown via <img> only (scripts in SVG never run there)
  return 'web';
}
/** How a menu is shown: 'image' (img + fullscreen viewer), 'embed' (sandboxed provider preview), 'link' (new tab only). */
export function menuPresentation(m) {
  if (m.kind === 'image') return 'image';
  return driveEmbedUrl(m.url) ? 'embed' : 'link';
}

// ------------------------------------------------------------------ menus
export const encodeMenu = (m) => `${m.kind}|${m.label || ''}|${m.url}`;
export function decodeMenu(s) {
  const a = String(s).indexOf('|'); const b = a < 0 ? -1 : String(s).indexOf('|', a + 1);
  if (b < 0 || !isStoredMenuEntry(s)) return null;
  const m = { kind: s.slice(0, a), label: s.slice(a + 1, b), url: s.slice(b + 1) };
  return MENU_KINDS.includes(m.kind) && isStoredUrl(m.url) ? m : null;
}
/** Valid stored menus of a contact (an invalid entry — impossible past the rules — is skipped, never rendered). */
export const menusOf = (c) => (Array.isArray(c && c.menus) ? c.menus.map(decodeMenu).filter(Boolean) : []);
/** The whole stored list exactly as the rules check it (≤ 10 elements, each a valid entry on its own). */
export function storedMenusOk(list) {
  if (!Array.isArray(list) || list.length > MEDIA_LIMITS.menus || list.some((x) => typeof x !== 'string')) return false;
  if (!list.length) return true;
  // rev 2: STRUCTURE element by element (as the rules do); only then the deny check on the joined list (= rules)
  return list.every(entryShapeOk) && !MENUS_DENY_RE.test(list.join('|'));
}

/**
 * Validate the media part of a contact input. Only keys PRESENT in `input` are returned — an input without
 * `avatarUrl` / `menus` (vCard import, merge, an older client) never produces a value that could erase them.
 * menus rows: { kind ('auto' | MENU_KINDS), label, url } or stored "kind|label|url" strings (idempotent).
 */
export function validateMedia(input, errors) {
  const out = {};
  if ('avatarUrl' in input) {
    const r = input.avatarUrl == null ? { empty: true } : normalizeHttpsUrl(input.avatarUrl);
    if (r.error) errors.avatarUrl = r.error; else out.avatarUrl = r.url || null;
  }
  if ('menus' in input) {
    const menus = [];
    for (const [i, raw] of (Array.isArray(input.menus) ? input.menus : []).entries()) {
      const row = typeof raw === 'string' ? decodeMenu(raw) || { kind: 'web', label: '', url: 'invalid:stored' } : raw || {};
      const r = normalizeHttpsUrl(row.url);
      const label = clean(row.label).replace(/\s+/g, ' ').trim();
      if (r.empty && !label) continue;                                       // blank row: dropped
      if (r.empty) { errors[`menu${i}`] = 'contacts.v.menuUrl'; continue; }
      if (r.error) { errors[`menu${i}`] = r.error; continue; }
      if ([...label].length > MEDIA_LIMITS.menuLabel || /\|/.test(label)) { errors[`menu${i}`] = 'contacts.v.menuLabel'; continue; }
      const kind = row.kind === 'auto' || !row.kind ? detectKind(r.url) : row.kind;
      if (!MENU_KINDS.includes(kind)) { errors[`menu${i}`] = 'contacts.v.menuKind'; continue; }
      if (kind === 'drive' && !driveEmbedUrl(r.url)) { errors[`menu${i}`] = 'contacts.v.menuDrive'; continue; }
      menus.push(encodeMenu({ kind, label, url: r.url }));
    }
    if (menus.length > MEDIA_LIMITS.menus) errors.menus = 'contacts.v.tooManyMenus';
    else if (!storedMenusOk(menus) && !Object.keys(errors).some((k) => k.startsWith('menu'))) errors.menus = 'contacts.v.menuUrl';
    out.menus = menus;
  }
  return out;
}
/** Media equality with "absent" = null = [] (so opening and saving an old contact writes nothing). */
export const sameMedia = (k, a, b) => {
  const n = (v) => (k === 'menus' ? (Array.isArray(v) && v.length ? JSON.stringify(v) : null) : v || null);
  return n(a) === n(b);
};

/** Ids of the categories that mean "Restaurants" (key-based: survives renames; a custom "Restaurants" does not count). */
export const restaurantCategoryIds = (categories) => (categories || []).filter((k) => k.key === RESTAURANT_KEY).map((k) => k.id);
/** Is the Menu section shown? Live Restaurants category assigned. Menu DATA is kept either way. */
export const showsMenu = (liveIds, categories) => { const r = new Set(restaurantCategoryIds(categories)); return liveIds.some((id) => r.has(id)); };
