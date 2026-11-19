/**
 * Compare two Firestore rules files structurally (Phase 5.1.2).
 *   node tools/rules-compare.mjs <baseline.rules> [candidate.rules=firestore.rules] [--md out.md]
 * Reports: functions added / removed / changed; match paths added / removed; per match path, the
 * allow statements added / removed / changed. Comments and whitespace are ignored.
 * It is a REVIEW AID — every reported difference still needs a human security reading.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , basePath, candArg, ...rest] = process.argv;
if (!basePath) { console.error('usage: node tools/rules-compare.mjs <baseline.rules> [candidate.rules] [--md out.md]'); process.exit(2); }
const candPath = candArg && !candArg.startsWith('--') ? candArg : 'firestore.rules';
const mdIdx = process.argv.indexOf('--md'); const mdOut = mdIdx > 0 ? process.argv[mdIdx + 1] : null;

const strip = (src) => src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const norm = (t) => t.replace(/\s+/g, ' ').trim();
// Brace matching that ignores braces inside string literals (e.g. regex quantifiers '{24}').
function block(src, openIdx) {
  let d = 0; let q = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '{') d++; else if (c === '}') { d--; if (!d) return [openIdx, i]; }
  }
  return [openIdx, src.length];
}

function parse(raw) {
  const src = strip(raw);
  const functions = new Map(); const matches = new Map();
  for (const m of src.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{/g)) {
    const [a, b] = block(src, m.index + m[0].length - 1);
    functions.set(m[1], norm(`(${m[2]}) ${src.slice(a, b + 1)}`));
  }
  // match blocks by brace matching; each allow is attributed to its INNERMOST enclosing match.
  const blocks = [];
  for (const m of src.matchAll(/match\s+(\S+)\s+\{/g)) {
    const [a, b] = block(src, m.index + m[0].length - 1);
    blocks.push({ seg: m[1], start: a, end: b });
  }
  for (const b of blocks) {
    const parents = blocks.filter((x) => x.start < b.start && x.end > b.end).sort((x, y) => x.start - y.start);
    b.path = [...parents.map((x) => x.seg), b.seg].join('');
    matches.set(b.path, new Map());
  }
  for (const a of src.matchAll(/allow\s+([\w,\s]+?)\s*:\s*if\s*([\s\S]*?);/g)) {
    const owner = blocks.filter((x) => x.start < a.index && x.end > a.index).sort((x, y) => y.start - x.start)[0];
    if (!owner) continue;
    for (const op of a[1].split(',').map((x) => x.trim())) owner.allows = (matches.get(owner.path).set(op, norm(a[2])), true);
  }
  return { functions, matches };
}

const A = parse(readFileSync(basePath, 'utf8')); const B = parse(readFileSync(candPath, 'utf8'));
const out = [];
const diffKeys = (a, b) => ({ added: [...b.keys()].filter((k) => !a.has(k)), removed: [...a.keys()].filter((k) => !b.has(k)), common: [...a.keys()].filter((k) => b.has(k)) });
out.push(`# Rules comparison\n\nBaseline: \`${basePath}\`\nCandidate: \`${candPath}\`\n`);
const f = diffKeys(A.functions, B.functions);
out.push(`## Functions\n- Added (${f.added.length}): ${f.added.join(', ') || '—'}\n- Removed (${f.removed.length}): ${f.removed.join(', ') || '—'}\n- Changed (${f.common.filter((k) => A.functions.get(k) !== B.functions.get(k)).length}): ${f.common.filter((k) => A.functions.get(k) !== B.functions.get(k)).join(', ') || '—'}\n`);
const mm = diffKeys(A.matches, B.matches);
out.push(`## Match paths\n- Added (${mm.added.length}): ${mm.added.map((x) => `\`${x}\``).join(', ') || '—'}\n- Removed (${mm.removed.length}): ${mm.removed.map((x) => `\`${x}\``).join(', ') || '—'}\n`);
out.push('## Allow statements on common paths');
let changed = 0;
for (const p of mm.common) {
  const a = A.matches.get(p); const b = B.matches.get(p); const d = diffKeys(a, b);
  const ch = d.common.filter((k) => a.get(k) !== b.get(k));
  if (!d.added.length && !d.removed.length && !ch.length) continue;
  changed++;
  out.push(`- \`${p}\`: ${[d.added.length && `added ${d.added.join('/')}`, d.removed.length && `removed ${d.removed.join('/')}`, ch.length && `changed ${ch.join('/')}`].filter(Boolean).join('; ')}`);
}
if (!changed) out.push('- none');
const text = out.join('\n') + '\n';
if (mdOut) writeFileSync(mdOut, text);
console.log(text);
