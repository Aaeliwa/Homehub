/**
 * Historical CSV import — PURE (parsing, mapping, preview, document building).
 *
 * Purpose: bring the preserved Expenses CSV backup into homes/{homeId}/expenses ONCE, safely:
 *   - nothing is written until the owner has seen the preview (row count, exact total, months);
 *   - document ids are DETERMINISTIC (the CSV's own id column when present, otherwise a stable
 *     hash of the row), so re-running the import can never create duplicates;
 *   - amounts are parsed from text into integer minor units (no floating point);
 *   - every original column is kept verbatim in `originalRow` (nothing is "normalised away");
 *   - historical rows get NO wallet / cycle (presented as "Imported history"), audience household.
 */
import { parseMinor } from './money.js';
import { isCalendarDate } from './calendar.js';
import { CATEGORY_IDS, FINANCE_SCHEMA_VERSION } from './finance-model.js';

export const MAX_IMPORT_ROWS = 5000;

/** RFC-4180 style CSV parser (quotes, escaped quotes, CRLF, BOM). Returns string[][] */
export function parseCsv(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

const norm = (h) => String(h || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const GUESS = {
  id: ['id', 'docid', 'documentid', 'expenseid', 'key'],
  date: ['date', 'day', 'transactiondate', 'expensedate', 'التاريخ'],
  amount: ['amount', 'value', 'price', 'cost', 'total', 'المبلغ'],
  category: ['category', 'categoryid', 'cat', 'type', 'الفئة', 'التصنيف'],
  note: ['name', 'note', 'notes', 'description', 'title', 'details', 'الوصف', 'البيان'],
  payment: ['paymentmethod', 'payment', 'method', 'isvisa', 'visa'],
  createdAt: ['createdat', 'created', 'timestamp'],
};

/** Best-guess column mapping from headers (the owner can change every choice in the UI). */
export function guessMapping(headers) {
  const n = headers.map(norm);
  const pick = (keys) => { const i = n.findIndex((h) => keys.includes(h)); return i >= 0 ? i : null; };
  return { id: pick(GUESS.id), date: pick(GUESS.date), amount: pick(GUESS.amount), category: pick(GUESS.category),
    note: pick(GUESS.note), payment: pick(GUESS.payment), createdAt: pick(GUESS.createdAt), dateFormat: 'auto' };
}

/** Parse a date cell. Formats: auto (ISO, or D/M/Y when unambiguous), ymd, dmy, mdy. */
export function parseDateCell(raw, format = 'auto') {
  const s = String(raw || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m && (format === 'auto' || format === 'ymd')) return pad(m[1], m[2], m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (!m) return null;
  let [a, b] = [Number(m[1]), Number(m[2])];
  if (format === 'mdy' || (format === 'auto' && a <= 12 && b > 12)) [a, b] = [b, a];
  else if (format === 'auto' && a <= 12 && b <= 12) return null; // ambiguous → owner must pick a format
  return pad(m[3], b, a);
}
function pad(y, mo, d) {
  const v = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isCalendarDate(v) ? v : null;
}

function paymentFrom(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'visa'].includes(v)) return 'visa';
  if (['cash', 'debit_card', 'credit_card', 'bank_transfer', 'digital_wallet', 'other'].includes(v)) return v;
  return null; // unknown/false/empty → not inferred (never guessed as cash)
}

/** Stable 20-char id from the row's content (FNV-1a based), used when the CSV has no id column. */
export function rowHashId(cells) {
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  const s = cells.join('\u241f');
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return `imp_${h1.toString(36)}${h2.toString(36)}`.slice(0, 24);
}

/**
 * Build the preview. Nothing here touches Firestore.
 * Returns { rows: [{ id, doc }], errors: [{ line, reason }], totalMinor, months: {YYYY-MM: minor}, duplicates }
 */
export function buildImportPlan(table, mapping, { uid, currency, batchId, now }) {
  const [headers, ...body] = table;
  const errors = []; const rows = []; const seen = new Set(); let duplicates = 0;
  if (body.length > MAX_IMPORT_ROWS) return { rows: [], errors: [{ line: 0, reason: 'finance.import.tooMany' }], totalMinor: 0, months: {}, duplicates: 0 };
  if (mapping.date == null || mapping.amount == null) return { rows: [], errors: [{ line: 0, reason: 'finance.import.mapRequired' }], totalMinor: 0, months: {}, duplicates: 0 };
  const months = {}; let totalMinor = 0;
  body.forEach((cells, i) => {
    const line = i + 2;
    const date = parseDateCell(cells[mapping.date], mapping.dateFormat);
    if (!date) { errors.push({ line, reason: 'finance.import.badDate' }); return; }
    const amt = parseMinor(cells[mapping.amount], { allowZero: true });
    if (amt.error || amt.value === null) { errors.push({ line, reason: 'finance.import.badAmount' }); return; }
    const rawId = mapping.id != null ? String(cells[mapping.id] || '').trim() : '';
    const id = rawId && /^[A-Za-z0-9_-]{1,128}$/.test(rawId) ? rawId : rowHashId(cells);
    if (seen.has(id)) { duplicates++; errors.push({ line, reason: 'finance.import.duplicateId' }); return; }
    seen.add(id);
    const rawCat = mapping.category != null ? String(cells[mapping.category] || '').trim() : '';
    const category = CATEGORY_IDS.includes(rawCat.toLowerCase()) ? rawCat.toLowerCase() : 'other';
    const originalRow = Object.fromEntries(headers.map((h, k) => [String(h || `col${k}`).slice(0, 60), String(cells[k] ?? '').slice(0, 500)]));
    rows.push({ id, doc: {
      amountMinor: amt.value, currency, date, category,
      importedCategory: rawCat || null,
      note: mapping.note != null ? (String(cells[mapping.note] || '').trim().slice(0, 200) || null) : null,
      merchant: null,
      paymentMethod: mapping.payment != null ? paymentFrom(cells[mapping.payment]) : null,
      walletId: null, budgetCycleId: null, paidBy: null, commitmentId: null, commitmentDueDate: null,
      audience: 'household', readers: [],
      status: 'active', voidedAt: null, voidedBy: null, voidReason: null,
      source: 'import', importBatchId: batchId, originalRow,
      createdBy: uid, createdAt: now, updatedBy: uid, updatedAt: now, schemaVersion: FINANCE_SCHEMA_VERSION,
    } });
    totalMinor += amt.value;
    months[date.slice(0, 7)] = (months[date.slice(0, 7)] || 0) + amt.value;
  });
  return { rows, errors, totalMinor, months, duplicates };
}

/** Skip ids already present in Firestore (idempotent re-runs). */
export function withoutExisting(plan, existingIds) {
  const ex = new Set(existingIds);
  const rows = plan.rows.filter((r) => !ex.has(r.id));
  return { ...plan, rows, alreadyImported: plan.rows.length - rows.length };
}
