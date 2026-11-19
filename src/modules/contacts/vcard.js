/**
 * vCard import / export (V6.4 Batch B) — PURE, local only (the file never leaves the browser; nothing is
 * uploaded). Import: vCard 2.1 / 3.0 / 4.0, CRLF or LF, folded lines, 3.0/4.0 backslash escapes,
 * 2.1 QUOTED-PRINTABLE (+ soft line breaks) with CHARSET, multiple TEL, `tel:` URIs, Unicode.
 * Binary / media properties (PHOTO, LOGO, SOUND, KEY, attachments) are SKIPPED and counted — never kept.
 * Export: vCard 3.0, UTF-8, CRLF, proper escaping and 75-octet folding.
 */
import { CONTACT_LIMITS, cleanNumber, validNumber, clean } from './contact-model.js';

export const VCF_LIMITS = Object.freeze({ bytes: 1024 * 1024, records: 500, lineChars: 20000, valueChars: 4000 });
const MEDIA = new Set(['PHOTO', 'LOGO', 'SOUND', 'KEY', 'ATTACH']);
const KNOWN = new Set(['BEGIN', 'END', 'VERSION', 'FN', 'N', 'TEL', 'EMAIL', 'ORG', 'ADR', 'NOTE', 'CATEGORIES', 'PRODID', 'REV', 'UID', 'KIND', 'X-HOMEHUB-LABEL']);
const TYPE_TO_LABEL = [['CELL', 'mobile'], ['MOBILE', 'mobile'], ['IPHONE', 'mobile'], ['HOME', 'home'], ['WORK', 'work'], ['FAX', 'fax'], ['WHATSAPP', 'whatsapp']];

/** Bytes (ArrayBuffer / Uint8Array) or string → text. UTF-8 (BOM stripped); invalid bytes never throw. */
export function decodeFile(input) {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { /* not UTF-8 */ }
  // Older exports (e.g. vCard 2.1 from older phones) may be in a single-byte charset: use the declared
  // CHARSET when the decoder knows it, else Windows-1252; never throw on bad bytes.
  const ascii = new TextDecoder('latin1').decode(bytes.slice(0, 65536));
  const declared = (ascii.match(/CHARSET=([A-Za-z0-9_-]+)/i) || [])[1];
  for (const cs of [declared, 'windows-1252']) {
    if (!cs) continue;
    try { return new TextDecoder(cs, { fatal: false }).decode(bytes).replace(/^\uFEFF/, ''); } catch { /* unknown label */ }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Unfold: CRLF/CR → LF; a line starting with space / tab continues the previous one (RFC 6350 §3.2). */
function unfold(text) {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  // vCard 2.1 quoted-printable soft breaks: a QP line ending with '=' continues on the next line
  const joined = [];
  for (let i = 0; i < out.length; i++) {
    let l = out[i];
    if (/ENCODING=QUOTED-PRINTABLE|;QUOTED-PRINTABLE/i.test(l.split(':')[0] || '')) {
      while (/=$/.test(l) && i + 1 < out.length) { l = l.slice(0, -1) + out[++i]; }
    }
    joined.push(l);
  }
  return joined;
}

function parseLine(line) {
  // split name;params:value — the first ':' outside a quoted parameter value
  let inQ = false; let colon = -1;
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') inQ = !inQ; else if (c === ':' && !inQ) { colon = i; break; } }
  if (colon < 0) return null;
  const head = line.slice(0, colon); const value = line.slice(colon + 1);
  const parts = head.split(';'); let name = parts.shift().trim().toUpperCase();
  if (name.includes('.')) name = name.slice(name.lastIndexOf('.') + 1);   // item1.TEL → TEL
  const params = {}; const types = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) { types.push(p.trim().toUpperCase()); continue; }   // vCard 2.1 bare parameters (TEL;CELL;VOICE)
    const k = p.slice(0, eq).trim().toUpperCase(); const v = p.slice(eq + 1).replace(/^"|"$/g, '');
    if (k === 'TYPE') types.push(...v.split(',').map((x) => x.trim().toUpperCase()));
    else params[k] = v;
  }
  if (types.includes('QUOTED-PRINTABLE')) params.ENCODING = 'QUOTED-PRINTABLE';
  if (types.includes('BASE64') || types.includes('B')) params.ENCODING = 'BASE64';
  return { name, params, types, value };
}

function qpDecode(s, charset) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else { const cp = s.charCodeAt(i); if (cp < 128) bytes.push(cp); else for (const b of new TextEncoder().encode(s[i])) bytes.push(b); }
  }
  let dec;
  try { dec = new TextDecoder(charset || 'utf-8', { fatal: false }); } catch { dec = new TextDecoder('utf-8', { fatal: false }); }
  return dec.decode(new Uint8Array(bytes));
}
/** Split a structured value on unescaped `sep`, then unescape each part (3.0 / 4.0). */
function splitEsc(v, sep) {
  const out = []; let cur = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i++; continue; }
    if (v[i] === sep) { out.push(cur); cur = ''; continue; }
    cur += v[i];
  }
  out.push(cur); return out;
}
const unesc = (s) => s.replace(/\\([\\,;:nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

function valueOf(prop, version) {
  let v = prop.value;
  if (prop.params.ENCODING && /^QUOTED-PRINTABLE$/i.test(prop.params.ENCODING)) v = qpDecode(v, prop.params.CHARSET);
  else if (prop.params.CHARSET && !/^utf-?8$/i.test(prop.params.CHARSET)) {
    // already decoded as UTF-8 text; a v21 charset label without QP cannot be re-decoded safely → kept, warned
    prop.warn = 'charset';
  }
  return v.length > VCF_LIMITS.valueChars ? v.slice(0, VCF_LIMITS.valueChars) : v;
}

/**
 * Parse a .vcf text. Returns { records: [{ index, ok, value?, errors, warnings, unsupported, mediaSkipped }], fileErrors }.
 * `value` is a contact input ({ name, organization, email, address, notes, phones:[{label,number}], categoryNames }).
 */
export function parseVcf(input) {
  const fileErrors = [];
  const text = decodeFile(input);
  if (new TextEncoder().encode(text).length > VCF_LIMITS.bytes) return { records: [], fileErrors: ['tooLarge'] };
  if (!/BEGIN\s*:\s*VCARD/i.test(text)) return { records: [], fileErrors: ['notVcf'] };
  const lines = unfold(text);
  const records = []; let cur = null; let depth = 0;
  for (const raw of lines) {
    if (raw.length > VCF_LIMITS.lineChars) { if (cur) cur.errors.push('lineTooLong'); continue; }
    const line = raw.trim() ? raw : '';
    if (!line) continue;
    const p = parseLine(line);
    if (!p) { if (cur) cur.warnings.push('badLine'); continue; }
    if (p.name === 'BEGIN' && /^VCARD$/i.test(p.value.trim())) {
      if (cur && depth > 0) { depth++; continue; }    // nested (AGENT) — ignored
      if (records.length >= VCF_LIMITS.records) { fileErrors.push('tooMany'); break; }
      cur = { index: records.length, props: [], errors: [], warnings: [], unsupported: new Set(), mediaSkipped: 0, closed: false, version: '3.0' }; depth = 1; continue;
    }
    if (!cur) continue;
    if (p.name === 'END' && /^VCARD$/i.test(p.value.trim())) { depth--; if (depth === 0) { cur.closed = true; records.push(cur); cur = null; } continue; }
    if (depth > 1) continue;
    if (p.name === 'VERSION') { cur.version = p.value.trim(); continue; }
    if (MEDIA.has(p.name) || /^X-.*(PHOTO|IMAGE|AVATAR)/i.test(p.name)) { cur.mediaSkipped++; continue; }
    if (!KNOWN.has(p.name)) { cur.unsupported.add(p.name); continue; }
    cur.props.push(p);
  }
  if (cur) { cur.errors.push('unterminated'); records.push(cur); }
  return { records: records.map(toRecord), fileErrors };
}

function toRecord(r) {
  const errors = [...r.errors]; const warnings = [...r.warnings];
  const v21 = r.version === '2.1';
  const get = (n) => r.props.filter((p) => p.name === n);
  const text = (p) => { const v = valueOf(p, r.version); if (p.warn) warnings.push(p.warn); return clean(v21 ? v : unesc(v)); };
  let name = ''; const fn = get('FN')[0];
  if (fn) name = text(fn).trim();
  if (!name && get('N')[0]) {
    const parts = splitEsc(valueOf(get('N')[0], r.version), ';').map((x) => clean(v21 ? x : unesc(x)).trim());
    const [family = '', given = '', additional = '', prefix = '', suffix = ''] = parts;
    name = [prefix, given, additional, family, suffix].filter(Boolean).join(' ');
  }
  const org = get('ORG')[0] ? splitEsc(valueOf(get('ORG')[0], r.version), ';').map((x) => clean(v21 ? x : unesc(x)).trim()).filter(Boolean).join(' – ') : null;
  const emails = get('EMAIL').map(text).map((x) => x.trim()).filter(Boolean);
  const adr = get('ADR')[0] ? splitEsc(valueOf(get('ADR')[0], r.version), ';').map((x) => clean(v21 ? x : unesc(x)).trim()).filter(Boolean).join(', ') : null;
  const notes = get('NOTE').map(text).map((x) => x.trim()).filter(Boolean).join('\n\n') || null;
  const categoryNames = [...new Set(get('CATEGORIES').flatMap((p) => splitEsc(valueOf(p, r.version), ',').map((x) => clean(v21 ? x : unesc(x)).trim())).filter(Boolean))];
  const phones = []; let badPhones = 0;
  let last = null;
  for (const p of r.props) {
    if (p.name === 'X-HOMEHUB-LABEL') { const l = text(p).trim(); if (last && l && !l.includes('|') && l.length <= CONTACT_LIMITS.phoneLabel) last.label = l; continue; }
    if (p.name !== 'TEL') continue;
    last = null;
    const number = cleanNumber(valueOf(p, r.version));
    if (!validNumber(number)) { badPhones++; continue; }
    const tl = (TYPE_TO_LABEL.find(([k]) => p.types.includes(k)) || [null, 'other'])[1];
    if (!phones.some((x) => x.number.replace(/\D/g, '') === number.replace(/\D/g, ''))) { last = { label: tl, number }; phones.push(last); }
  }
  if (badPhones) warnings.push('badPhone');
  if (phones.length > CONTACT_LIMITS.phones) { warnings.push('phonesTrimmed'); phones.length = CONTACT_LIMITS.phones; }
  if (emails.length > 1) warnings.push('extraEmails');
  if (r.mediaSkipped) warnings.push('mediaSkipped');
  if (!name) errors.push('noName');
  const value = { name, organization: org, email: emails[0] || null, address: adr, notes, phones, categoryNames };
  for (const [k, max] of [['name', CONTACT_LIMITS.name], ['organization', CONTACT_LIMITS.organization], ['address', CONTACT_LIMITS.address], ['notes', CONTACT_LIMITS.notes]]) {
    if (value[k] && value[k].length > max) { if (k === 'name') errors.push('nameTooLong'); else { value[k] = value[k].slice(0, max); warnings.push(`${k}Trimmed`); } }
  }
  if (value.email && value.email.length > CONTACT_LIMITS.email) { value.email = null; warnings.push('emailDropped'); }
  return { index: r.index, version: r.version, ok: errors.length === 0, value, errors: [...new Set(errors)], warnings: [...new Set(warnings)], unsupported: [...r.unsupported].sort(), mediaSkipped: r.mediaSkipped };
}

// ------------------------------------------------------------------ export (vCard 3.0)
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r\n?|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
/** Fold to ≤ 75 octets per line (continuation lines start with one space), never splitting a UTF-8 character. */
export function foldLine(line) {
  const enc = new TextEncoder(); const out = []; let cur = ''; let bytes = 0; let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}
const LABEL_TO_TYPE = { mobile: 'CELL', home: 'HOME', work: 'WORK', fax: 'FAX', whatsapp: 'CELL', other: 'VOICE' };

/**
 * contacts → one vCard 3.0 text (CRLF). Round-tripped: name, phones (+ type), organization, email, address
 * (as one street line), notes, category NAMES. Not round-tripped (documented in the UI): favourite flag,
 * category ids / suggested-category translation, custom phone labels (exported as X-HOMEHUB-LABEL), history.
 */
export function exportVcf(contacts, { categoryName = () => null } = {}) {
  const lines = [];
  for (const c of contacts) {
    lines.push('BEGIN:VCARD', 'VERSION:3.0');
    lines.push(`FN:${esc(c.name)}`, `N:${esc(c.name)};;;;`);
    for (const raw of c.phones || []) {
      const i = raw.indexOf('|'); const label = i < 0 ? 'other' : raw.slice(0, i); const number = i < 0 ? raw : raw.slice(i + 1);
      const type = LABEL_TO_TYPE[label] || 'VOICE';
      lines.push(`TEL;TYPE=${type}:${esc(number)}`);
      if (!LABEL_TO_TYPE[label]) lines.push(`X-HOMEHUB-LABEL:${esc(label)}`);
    }
    if (c.organization) lines.push(`ORG:${esc(c.organization)}`);
    if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${esc(c.email)}`);
    if (c.address) lines.push(`ADR;TYPE=HOME:;;${esc(c.address)};;;;`);
    if (c.notes) lines.push(`NOTE:${esc(c.notes)}`);
    const cats = (c.categoryIds || []).map(categoryName).filter(Boolean);
    if (cats.length) lines.push(`CATEGORIES:${cats.map(esc).join(',')}`);
    lines.push('END:VCARD');
  }
  return lines.map(foldLine).join('\r\n') + (lines.length ? '\r\n' : '');
}
export function vcfFileName(base) {
  const safe = String(base || 'contacts').normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, '-').slice(0, 60) || 'contacts';
  return `${safe}.vcf`;
}
